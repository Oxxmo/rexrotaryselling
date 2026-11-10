-- ============================================================
--  Rex Commando — pilote automatique du lundi
-- ------------------------------------------------------------
--  Quand il est activé (paramètre « pilote »), le lundi :
--    1. à l'heure prévue (7 h par défaut, heure de Paris), la veille
--       IA est lancée toute seule (même chaîne d'étapes que le bouton) ;
--    2. dès qu'elle est terminée, le vote de l'équipe s'ouvre jusqu'à
--       l'heure de clôture (13 h 30 par défaut) ;
--    3. à la clôture, le cron du vote retient les 3 sujets les plus
--       votés et publie la semaine (mécanisme existant).
--  Le responsable garde la main : il peut écarter un sujet, changer
--  l'échéance, clore le vote ou tout faire à la main. Le pilote ne fait
--  rien si une veille a déjà été lancée, si des sujets sont déjà
--  retenus ou si la semaine est publiée.
--  Chaque action est notée dans commando_pilote_journal.
--  + commando_mes_points : points crédités tout de suite après un appel.
-- ============================================================

alter table public.commando_parametres
  add column if not exists pilote jsonb not null default
    '{"actif": false, "jour": 1, "heure_veille": "07:00", "cloture_vote": "13:30", "nb_choix": 3, "auto_publier": true}'::jsonb;
comment on column public.commando_parametres.pilote is
  'Pilote automatique du lundi : actif, jour (1 = lundi), heure_veille, cloture_vote (heure de Paris), nb_choix, auto_publier.';

create table if not exists public.commando_pilote_journal (
  id       bigint generated always as identity primary key,
  le       timestamptz not null default now(),
  semaine  text,
  action   text not null,
  detail   jsonb not null default '{}'::jsonb
);
alter table public.commando_pilote_journal enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_pilote_journal' and policyname = 'commando_pilote_journal_select') then
    create policy commando_pilote_journal_select on public.commando_pilote_journal for select to authenticated
      using ( (select public.commando_est_responsable(auth.uid())) );
  end if;
end $$;
revoke all on public.commando_pilote_journal from anon, authenticated;
grant select on public.commando_pilote_journal to authenticated;

-- ------------------------------------------------------------
-- 1) Ouverture du vote : version interne (au nom d'un responsable)
-- ------------------------------------------------------------
create or replace function public.commando_vote_ouvrir_interne(_semaine_id uuid, _fin timestamptz, _nb_choix int,
  _auto_retenir boolean, _auto_publier boolean, _message text, _par uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sem record; v_nb int;
begin
  select * into v_sem from public.commando_semaines where id = _semaine_id for update;
  if v_sem.id is null then raise exception 'Semaine introuvable'; end if;
  if v_sem.statut <> 'brouillon' then raise exception 'La semaine est déjà publiée : le vote porte sur une semaine en préparation'; end if;
  if _fin is null or _fin <= now() + interval '5 minutes' then raise exception 'L''heure de clôture doit être dans au moins 5 minutes'; end if;
  select count(*) into v_nb from public.commando_thematiques where semaine_id = _semaine_id and statut <> 'ecartee';
  if v_nb < 4 then raise exception 'Il faut au moins 4 sujets non écartés pour un vote (actuellement %)', v_nb; end if;
  if _nb_choix is null or _nb_choix < 1 or _nb_choix > least(5, v_nb - 1) then
    raise exception 'Nombre de choix par commercial : entre 1 et %', least(5, v_nb - 1);
  end if;
  update public.commando_thematiques set statut = 'proposee' where semaine_id = _semaine_id and statut = 'retenue';
  update public.commando_semaines
     set vote_ouvert_le = coalesce(case when vote_clos_le is null then vote_ouvert_le end, now()),
         vote_ouvert_par = _par, vote_fin = _fin, vote_clos_le = null, vote_resultat = null,
         vote_nb_choix = _nb_choix, vote_auto_retenir = coalesce(_auto_retenir, true),
         vote_auto_publier = coalesce(_auto_publier, false) and coalesce(_auto_retenir, true),
         vote_message = nullif(trim(coalesce(_message, '')), '')
   where id = _semaine_id;
  return jsonb_build_object('semaine_id', _semaine_id, 'sujets', v_nb, 'fin', _fin);
end $$;
revoke all on function public.commando_vote_ouvrir_interne(uuid, timestamptz, int, boolean, boolean, text, uuid) from public, anon, authenticated;

create or replace function public.commando_vote_ouvrir(_semaine_id uuid, _fin timestamptz, _nb_choix int default 3,
  _auto_retenir boolean default true, _auto_publier boolean default false, _message text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  return public.commando_vote_ouvrir_interne(_semaine_id, _fin, _nb_choix, _auto_retenir, _auto_publier, _message, auth.uid());
end $$;
revoke all on function public.commando_vote_ouvrir(uuid, timestamptz, int, boolean, boolean, text) from public, anon;
grant execute on function public.commando_vote_ouvrir(uuid, timestamptz, int, boolean, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 2) Lancement interne de la veille : une génération « en attente »,
--    reprise par le cron commando_veille_relance (toutes les 20 s).
-- ------------------------------------------------------------
create or replace function public.commando_veille_lancer_interne(_semaine_id uuid, _par uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record; v_nb int; v_id uuid;
begin
  select * into p from public.commando_parametres where id;
  if p.fiche_rex is null or p.fiche_rex_validee_le is null then
    raise exception 'La fiche Rex-Rotary doit être validée avant de lancer la veille.';
  end if;
  select count(*) into v_nb from public.commando_generations
   where semaine_id = _semaine_id and type in ('veille', 'regeneration');
  if v_nb >= coalesce(p.limite_generations_semaine, 5) then
    raise exception 'Limite de générations atteinte pour cette semaine (%).', v_nb;
  end if;
  if exists (select 1 from public.commando_generations where semaine_id = _semaine_id and statut = 'en_cours') then
    raise exception 'Une génération est déjà en cours pour cette semaine.';
  end if;
  insert into public.commando_generations (semaine_id, type, modele, prompt_version, lancee_par, etat)
  values (_semaine_id, 'veille', coalesce(p.modele, 'claude-sonnet-5-5'), 7, _par,
          jsonb_build_object('phase', 'recherche', 'etape', 1, 'total', 6, 'attendu', 5,
                             'libelle', 'Veille d''actualité et concurrentielle (recherche web)',
                             'en_vol', false, 'phase_debut', now()::text, 'relance_apres', now()::text,
                             'tentatives', 0, 'propositions', '[]'::jsonb, 'ecrites', '[]'::jsonb,
                             'urls', '[]'::jsonb, 'usage', '{}'::jsonb, 'auto', true))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.commando_veille_lancer_interne(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Le pilote (cron toutes les 10 minutes)
-- ------------------------------------------------------------
create or replace function public.commando_pilote_tick(_maintenant timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select pilote from public.commando_parametres where id);
  loc timestamp := _maintenant at time zone 'Europe/Paris';
  v_heure time; v_cloture time; v_fin timestamptz;
  v_semaine text; v_sem record; v_resp uuid; v_nb int; v_retenues int; v_choix int; v_id uuid;
begin
  if not coalesce((p->>'actif')::boolean, false) then return jsonb_build_object('action', 'aucune', 'raison', 'pilote désactivé'); end if;
  if extract(isodow from loc) <> coalesce((p->>'jour')::int, 1) then return jsonb_build_object('action', 'aucune', 'raison', 'pas le jour du commando'); end if;
  v_heure := coalesce(nullif(p->>'heure_veille', ''), '07:00')::time;
  v_cloture := coalesce(nullif(p->>'cloture_vote', ''), '13:30')::time;
  if loc::time < v_heure then return jsonb_build_object('action', 'aucune', 'raison', 'avant l''heure de la veille'); end if;
  v_fin := (loc::date + v_cloture) at time zone 'Europe/Paris';

  v_semaine := public.commando_semaine_cible(loc::date);
  insert into public.commando_semaines (semaine) values (v_semaine) on conflict (semaine) do nothing;
  select * into v_sem from public.commando_semaines where semaine = v_semaine;
  if v_sem.statut <> 'brouillon' then return jsonb_build_object('action', 'aucune', 'raison', 'semaine déjà publiée'); end if;
  select user_id into v_resp from public.commando_membres where role = 'responsable' order by created_at limit 1;
  select count(*) filter (where statut <> 'ecartee'), count(*) filter (where statut = 'retenue')
    into v_nb, v_retenues
    from public.commando_thematiques where semaine_id = v_sem.id;
  if v_retenues > 0 then return jsonb_build_object('action', 'aucune', 'raison', 'sujets déjà retenus à la main'); end if;

  -- 1) Veille : jamais lancée cette semaine et pas assez de sujets
  if v_nb < 4 and not exists (select 1 from public.commando_generations
                               where semaine_id = v_sem.id and type in ('veille', 'regeneration')) then
    if _maintenant >= v_fin - interval '90 minutes' then
      return jsonb_build_object('action', 'aucune', 'raison', 'trop tard pour une veille');
    end if;
    begin
      v_id := public.commando_veille_lancer_interne(v_sem.id, v_resp);
      insert into public.commando_pilote_journal (le, semaine, action, detail)
      values (_maintenant, v_semaine, 'veille_lancee', jsonb_build_object('generation_id', v_id));
      return jsonb_build_object('action', 'veille_lancee', 'generation_id', v_id);
    exception when others then
      insert into public.commando_pilote_journal (le, semaine, action, detail)
      values (_maintenant, v_semaine, 'veille_impossible', jsonb_build_object('erreur', sqlerrm));
      return jsonb_build_object('action', 'veille_impossible', 'erreur', sqlerrm);
    end;
  end if;

  -- 2) Vote : veille finie, au moins 4 sujets, pas encore de vote
  if v_sem.vote_ouvert_le is null and v_nb >= 4
     and not exists (select 1 from public.commando_generations where semaine_id = v_sem.id and statut = 'en_cours') then
    if _maintenant >= v_fin - interval '30 minutes' then
      return jsonb_build_object('action', 'aucune', 'raison', 'trop tard pour ouvrir un vote');
    end if;
    v_choix := least(greatest(coalesce((p->>'nb_choix')::int, 3), 1), least(5, v_nb - 1));
    begin
      perform public.commando_vote_ouvrir_interne(v_sem.id, v_fin, v_choix, true,
        coalesce((p->>'auto_publier')::boolean, true),
        'Vote automatique : choisissez vos sujets préférés avant ' || to_char(v_cloture, 'HH24"h"MI') || '.', v_resp);
      insert into public.commando_pilote_journal (le, semaine, action, detail)
      values (_maintenant, v_semaine, 'vote_ouvert', jsonb_build_object('fin', v_fin, 'sujets', v_nb, 'nb_choix', v_choix));
      return jsonb_build_object('action', 'vote_ouvert', 'fin', v_fin);
    exception when others then
      insert into public.commando_pilote_journal (le, semaine, action, detail)
      values (_maintenant, v_semaine, 'vote_impossible', jsonb_build_object('erreur', sqlerrm));
      return jsonb_build_object('action', 'vote_impossible', 'erreur', sqlerrm);
    end;
  end if;
  return jsonb_build_object('action', 'aucune', 'raison', 'rien à faire');
end $$;
revoke all on function public.commando_pilote_tick(timestamptz) from public, anon, authenticated;

-- État du pilote pour la console (frise de la semaine).
create or replace function public.commando_pilote_etat()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.commando_est_responsable(auth.uid()) then jsonb_build_object(
    'pilote', (select pilote from public.commando_parametres where id),
    'journal', (select coalesce(jsonb_agg(jsonb_build_object('le', le, 'semaine', semaine, 'action', action, 'detail', detail) order by le desc), '[]'::jsonb)
                  from (select * from public.commando_pilote_journal order by le desc limit 10) j))
  end;
$$;
revoke all on function public.commando_pilote_etat() from public, anon;
grant execute on function public.commando_pilote_etat() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('commando_pilote', '*/10 * * * *', 'select public.commando_pilote_tick()');
  end if;
end $$;

-- ------------------------------------------------------------
-- 4) Points crédités tout de suite après un appel (sans attendre le cron)
-- ------------------------------------------------------------
create or replace function public.commando_mes_points(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_membre(auth.uid()) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  perform public.commando_points_crediter();
  return public.commando_points_solde(auth.uid(), _semaine_id);
end $$;
revoke all on function public.commando_mes_points(uuid) from public, anon;
grant execute on function public.commando_mes_points(uuid) to authenticated;
