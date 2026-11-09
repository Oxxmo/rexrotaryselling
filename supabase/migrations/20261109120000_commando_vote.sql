-- ============================================================
--  Rex Commando — 15/ Vote des sujets par l'équipe
-- ------------------------------------------------------------
--  Le lundi matin, le responsable soumet au vote les sujets de la semaine
--  (toutes les thématiques non écartées d'une semaine en brouillon), avec
--  une heure de clôture et un nombre de choix par commercial (3 par défaut).
--  Chaque commercial vote depuis RexSeller (onglet « Vote ») et peut
--  changer d'avis jusqu'à la clôture ; il voit les résultats une fois son
--  vote enregistré. À la clôture (échéance traitée par pg_cron chaque
--  minute, ou clôture manuelle), si le responsable l'a demandé : les
--  sujets les plus votés sont retenus (égalité : ordre du responsable),
--  et la semaine est publiée automatiquement. Voter rapporte des points
--  (barème « vote », 3 par défaut, une fois par semaine).
-- ============================================================

alter table public.commando_semaines
  add column if not exists vote_ouvert_le timestamptz,
  add column if not exists vote_ouvert_par uuid references auth.users(id) on delete set null,
  add column if not exists vote_fin timestamptz,
  add column if not exists vote_clos_le timestamptz,
  add column if not exists vote_nb_choix int not null default 3 check (vote_nb_choix between 1 and 5),
  add column if not exists vote_auto_retenir boolean not null default true,
  add column if not exists vote_auto_publier boolean not null default false,
  add column if not exists vote_message text,
  add column if not exists vote_resultat jsonb;

create table if not exists public.commando_votes (
  id            uuid primary key default gen_random_uuid(),
  semaine_id    uuid not null references public.commando_semaines(id) on delete cascade,
  thematique_id uuid not null references public.commando_thematiques(id) on delete cascade,
  commercial_id uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (thematique_id, commercial_id)
);
create index if not exists commando_votes_semaine_idx on public.commando_votes (semaine_id);
-- Un choix retiré est désactivé (actif = false) plutôt qu'effacé : un vote
-- modifié ne supprime aucune ligne.
alter table public.commando_votes add column if not exists actif boolean not null default true;

create table if not exists public.commando_vote_participations (
  semaine_id    uuid not null references public.commando_semaines(id) on delete cascade,
  commercial_id uuid not null references auth.users(id) on delete cascade,
  commentaire   text,
  vote_le       timestamptz not null default now(),
  modifie_le    timestamptz not null default now(),
  primary key (semaine_id, commercial_id)
);

-- Lecture directe : le responsable voit tout, un commercial ses propres lignes.
-- Écriture uniquement par les fonctions ci-dessous (security definer).
alter table public.commando_votes enable row level security;
alter table public.commando_vote_participations enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_votes' and policyname = 'commando_votes_select') then
    create policy commando_votes_select on public.commando_votes for select to authenticated
      using ((select public.commando_est_responsable(auth.uid())) or commercial_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_vote_participations' and policyname = 'commando_vote_participations_select') then
    create policy commando_vote_participations_select on public.commando_vote_participations for select to authenticated
      using ((select public.commando_est_responsable(auth.uid())) or commercial_id = auth.uid());
  end if;
end $$;

-- ------------------------------------------------------------
-- Publication : version interne (clôture automatique du vote), sans
-- contrôle de rôle ; la fonction publique garde le contrôle et refuse
-- de publier pendant un vote ouvert.
-- ------------------------------------------------------------
create or replace function public.commando_publier_interne(_semaine_id uuid, _par uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sem record; v_nb int; v_appels int; v_res jsonb;
begin
  select * into v_sem from public.commando_semaines where id = _semaine_id;
  if v_sem.id is null then raise exception 'Semaine introuvable'; end if;
  select count(*) into v_nb from public.commando_thematiques where semaine_id = _semaine_id and statut = 'retenue';
  if v_nb <> 3 then raise exception 'Il faut retenir exactement 3 thématiques (actuellement %)', v_nb; end if;
  select count(*) into v_appels from public.commando_appels where semaine_id = _semaine_id;
  if v_sem.statut = 'publiee' and v_appels > 0 then
    raise exception 'Semaine déjà publiée et % appel(s) enregistré(s) : l''instantané ne peut plus être recalculé', v_appels;
  end if;

  -- Instantané recalculé par insertion/mise à jour (clé thématique + siret).
  -- Les lignes d'une thématique qui ne serait plus retenue restent en base
  -- mais sont ignorées : toutes les lectures joignent sur statut = 'retenue'.
  insert into public.commando_ciblages (thematique_id, siret, semaine_id, couleur, regle_index, raison, secteur_code)
  select t.id, v.siret, _semaine_id, c->>'couleur', (c->>'regle_index')::int, c->>'raison', v.secteur_code
    from public.commando_thematiques t
    cross join public.commando_entreprises_v v
    cross join lateral (select public.commando_couleur(t.regles, v.naf_code, v.tranche_effectif, v.anciennete) as c) x
   where t.semaine_id = _semaine_id and t.statut = 'retenue' and v.eligible
  on conflict (thematique_id, siret) do update set
    couleur = excluded.couleur, regle_index = excluded.regle_index,
    raison = excluded.raison, secteur_code = excluded.secteur_code;

  update public.commando_semaines
     set statut = 'publiee', publiee_le = now(), publiee_par = _par
   where id = _semaine_id;

  select jsonb_build_object(
    'entreprises', count(distinct ci.siret),
    'vert', count(*) filter (where ci.couleur = 'vert'),
    'orange', count(*) filter (where ci.couleur = 'orange'),
    'rouge', count(*) filter (where ci.couleur = 'rouge'),
    'non_classee', count(*) filter (where ci.couleur is null))
  into v_res
  from public.commando_ciblages ci
  join public.commando_thematiques t on t.id = ci.thematique_id and t.statut = 'retenue'
  where ci.semaine_id = _semaine_id;
  return v_res;
end $$;
revoke all on function public.commando_publier_interne(uuid, uuid) from public, anon, authenticated;

create or replace function public.commando_publier(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if exists (select 1 from public.commando_semaines where id = _semaine_id and vote_ouvert_le is not null and vote_clos_le is null) then
    raise exception 'Un vote est en cours sur cette semaine : clôturez-le avant de publier';
  end if;
  return public.commando_publier_interne(_semaine_id, auth.uid());
end $$;
revoke all on function public.commando_publier(uuid) from public, anon;
grant execute on function public.commando_publier(uuid) to authenticated;

-- ------------------------------------------------------------
-- Classement du vote : sujets non écartés, votes décroissants, puis ordre
-- du responsable (départage des égalités).
-- ------------------------------------------------------------
create or replace function public.commando_vote_classement(_semaine_id uuid)
returns table (thematique_id uuid, titre text, votes int, rang int)
language sql stable set search_path = public, pg_temp as $$
  select t.id, t.titre, coalesce(v.n, 0)::int,
         (row_number() over (order by coalesce(v.n, 0) desc, t.ordre, t.created_at))::int
    from public.commando_thematiques t
    left join (select x.thematique_id, count(*) as n from public.commando_votes x where x.semaine_id = _semaine_id and x.actif group by x.thematique_id) v
      on v.thematique_id = t.id
   where t.semaine_id = _semaine_id and t.statut <> 'ecartee'
$$;
revoke all on function public.commando_vote_classement(uuid) from public, anon, authenticated;

-- Retient les 3 sujets les plus votés (les autres non écartés repassent « proposée »).
create or replace function public.commando_vote_appliquer(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids uuid[]; v_total int;
begin
  select count(*) into v_total from public.commando_votes x
    join public.commando_thematiques t on t.id = x.thematique_id and t.statut <> 'ecartee'
   where x.semaine_id = _semaine_id and x.actif;
  if v_total = 0 then return jsonb_build_object('retenues', '[]'::jsonb, 'raison', 'aucun vote'); end if;
  select array_agg(thematique_id order by rang) into v_ids from public.commando_vote_classement(_semaine_id) where rang <= 3;
  if coalesce(array_length(v_ids, 1), 0) < 3 then return jsonb_build_object('retenues', '[]'::jsonb, 'raison', 'moins de 3 sujets'); end if;
  update public.commando_thematiques set statut = case when id = any(v_ids) then 'retenue' else 'proposee' end
   where semaine_id = _semaine_id and statut <> 'ecartee';
  return jsonb_build_object('retenues', to_jsonb(v_ids), 'votes', v_total);
end $$;
revoke all on function public.commando_vote_appliquer(uuid) from public, anon, authenticated;

-- Clôture : fige le classement, retient et publie si demandé. Idempotente.
create or replace function public.commando_vote_finaliser(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sem record; v_res jsonb := '{}'::jsonb; v_app jsonb; v_pub jsonb;
begin
  select * into v_sem from public.commando_semaines where id = _semaine_id for update;
  if v_sem.id is null or v_sem.vote_ouvert_le is null then return null; end if;
  if v_sem.vote_clos_le is not null then return v_sem.vote_resultat; end if;
  v_res := jsonb_build_object(
    'classement', (select coalesce(jsonb_agg(jsonb_build_object('thematique_id', thematique_id, 'titre', titre, 'votes', votes, 'rang', rang) order by rang), '[]'::jsonb)
                     from public.commando_vote_classement(_semaine_id)),
    'votants', (select count(*) from public.commando_vote_participations where semaine_id = _semaine_id),
    'clos_par_echeance', now() >= v_sem.vote_fin);
  if v_sem.vote_auto_retenir and v_sem.statut = 'brouillon' then
    v_app := public.commando_vote_appliquer(_semaine_id);
    v_res := v_res || jsonb_build_object('retenues', v_app->'retenues', 'retenue_auto', jsonb_array_length(v_app->'retenues') = 3);
    if jsonb_array_length(v_app->'retenues') <> 3 then
      v_res := v_res || jsonb_build_object('note', 'Sujets non retenus automatiquement : ' || coalesce(v_app->>'raison', '?'));
    elsif v_sem.vote_auto_publier then
      begin
        v_pub := public.commando_publier_interne(_semaine_id, v_sem.vote_ouvert_par);
        v_res := v_res || jsonb_build_object('publie', true, 'publication', v_pub);
      exception when others then
        v_res := v_res || jsonb_build_object('publie', false, 'erreur_publication', sqlerrm);
      end;
    end if;
  end if;
  update public.commando_semaines set vote_clos_le = now(), vote_resultat = v_res where id = _semaine_id;
  return v_res;
end $$;
revoke all on function public.commando_vote_finaliser(uuid) from public, anon, authenticated;

-- Échéances (pg_cron, chaque minute).
create or replace function public.commando_vote_traiter_echeances()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id from public.commando_semaines where vote_ouvert_le is not null and vote_clos_le is null and vote_fin <= now() loop
    perform public.commando_vote_finaliser(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.commando_vote_traiter_echeances() from public, anon, authenticated;

-- Ouverture par le responsable.
create or replace function public.commando_vote_ouvrir(_semaine_id uuid, _fin timestamptz, _nb_choix int default 3,
  _auto_retenir boolean default true, _auto_publier boolean default false, _message text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sem record; v_nb int;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
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
         vote_ouvert_par = auth.uid(), vote_fin = _fin, vote_clos_le = null, vote_resultat = null,
         vote_nb_choix = _nb_choix, vote_auto_retenir = coalesce(_auto_retenir, true),
         vote_auto_publier = coalesce(_auto_publier, false) and coalesce(_auto_retenir, true),
         vote_message = nullif(trim(coalesce(_message, '')), '')
   where id = _semaine_id;
  return jsonb_build_object('semaine_id', _semaine_id, 'sujets', v_nb, 'fin', _fin);
end $$;
revoke all on function public.commando_vote_ouvrir(uuid, timestamptz, int, boolean, boolean, text) from public, anon;
grant execute on function public.commando_vote_ouvrir(uuid, timestamptz, int, boolean, boolean, text) to authenticated;

-- Clôture manuelle (le responsable n'attend pas l'échéance).
create or replace function public.commando_vote_clore(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if not exists (select 1 from public.commando_semaines where id = _semaine_id and vote_ouvert_le is not null and vote_clos_le is null) then
    raise exception 'Aucun vote ouvert sur cette semaine';
  end if;
  return public.commando_vote_finaliser(_semaine_id);
end $$;
revoke all on function public.commando_vote_clore(uuid) from public, anon;
grant execute on function public.commando_vote_clore(uuid) to authenticated;

-- Le responsable retient à la main les 3 plus votés (vote clos ou en cours).
create or replace function public.commando_vote_retenir(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if exists (select 1 from public.commando_semaines where id = _semaine_id and statut = 'publiee') then
    raise exception 'Semaine déjà publiée';
  end if;
  return public.commando_vote_appliquer(_semaine_id);
end $$;
revoke all on function public.commando_vote_retenir(uuid) from public, anon;
grant execute on function public.commando_vote_retenir(uuid) to authenticated;

-- Vote d'un commercial : remplace ses choix précédents (modifiable jusqu'à la clôture).
create or replace function public.commando_voter(_semaine_id uuid, _thematiques uuid[], _commentaire text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sem record; v_ids uuid[]; v_nb int; v_valides int;
begin
  if not exists (select 1 from public.commando_membres where user_id = auth.uid() and role = 'commercial') then
    raise exception 'Le vote est réservé aux commerciaux du commando' using errcode = '42501';
  end if;
  select * into v_sem from public.commando_semaines where id = _semaine_id;
  if v_sem.id is null or v_sem.vote_ouvert_le is null then raise exception 'Aucun vote sur cette semaine'; end if;
  if v_sem.vote_clos_le is not null or v_sem.vote_fin <= now() then raise exception 'Le vote est clos'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(_thematiques, '{}'::uuid[])) x;
  v_nb := coalesce(array_length(v_ids, 1), 0);
  if v_nb < 1 then raise exception 'Choisissez au moins un sujet'; end if;
  if v_nb > v_sem.vote_nb_choix then raise exception 'Au plus % sujet(s)', v_sem.vote_nb_choix; end if;
  select count(*) into v_valides from public.commando_thematiques
   where id = any(v_ids) and semaine_id = _semaine_id and statut <> 'ecartee';
  if v_valides <> v_nb then raise exception 'Sujet inconnu ou retiré du vote'; end if;
  update public.commando_votes set actif = (thematique_id = any(v_ids))
   where semaine_id = _semaine_id and commercial_id = auth.uid();
  insert into public.commando_votes (semaine_id, thematique_id, commercial_id)
  select _semaine_id, x, auth.uid() from unnest(v_ids) x
  on conflict (thematique_id, commercial_id) do update set actif = true;
  insert into public.commando_vote_participations (semaine_id, commercial_id, commentaire)
  values (_semaine_id, auth.uid(), nullif(trim(coalesce(_commentaire, '')), ''))
  on conflict (semaine_id, commercial_id) do update set commentaire = excluded.commentaire, modifie_le = now();
  perform public.commando_points_crediter();
  return public.commando_vote_etat(_semaine_id);
end $$;
revoke all on function public.commando_voter(uuid, uuid[], text) from public, anon;
grant execute on function public.commando_voter(uuid, uuid[], text) to authenticated;

-- État du vote pour l'écran « Vote » : semaine donnée, sinon le vote ouvert,
-- sinon le dernier vote de la semaine cible. Les compteurs ne sont montrés
-- à un commercial qu'après son vote (ou après la clôture) ; les commentaires
-- et le détail des votants, au responsable seulement.
create or replace function public.commando_vote_etat(_semaine_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_resp boolean := public.commando_est_responsable(v_uid);
  v_sem record; v_ouvert boolean; v_a_vote boolean; v_voir boolean;
begin
  if not public.commando_est_membre(v_uid) then return null; end if;
  if _semaine_id is not null then
    select * into v_sem from public.commando_semaines where id = _semaine_id;
  else
    select * into v_sem from public.commando_semaines
     where vote_ouvert_le is not null and vote_clos_le is null order by vote_fin limit 1;
    if v_sem.id is null then
      select * into v_sem from public.commando_semaines
       where vote_ouvert_le is not null and semaine = public.commando_semaine_cible((now() at time zone 'Europe/Paris')::date)
       order by vote_ouvert_le desc limit 1;
    end if;
  end if;
  if v_sem.id is null or v_sem.vote_ouvert_le is null then return jsonb_build_object('vote', false); end if;
  v_ouvert := v_sem.vote_clos_le is null and v_sem.vote_fin > now();
  v_a_vote := exists (select 1 from public.commando_vote_participations where semaine_id = v_sem.id and commercial_id = v_uid);
  v_voir := v_resp or v_a_vote or not v_ouvert;
  return jsonb_build_object(
    'vote', true,
    'semaine_id', v_sem.id, 'semaine', v_sem.semaine, 'statut_semaine', v_sem.statut,
    'ouvert', v_ouvert, 'en_cloture', v_sem.vote_clos_le is null and v_sem.vote_fin <= now(),
    'fin', v_sem.vote_fin, 'ouvert_le', v_sem.vote_ouvert_le, 'clos_le', v_sem.vote_clos_le,
    'nb_choix', v_sem.vote_nb_choix, 'message', v_sem.vote_message,
    'auto_retenir', v_sem.vote_auto_retenir, 'auto_publier', v_sem.vote_auto_publier,
    'resultat', v_sem.vote_resultat,
    'responsable', v_resp, 'a_vote', v_a_vote, 'resultats_visibles', v_voir,
    'mes_choix', (select coalesce(jsonb_agg(thematique_id), '[]'::jsonb) from public.commando_votes where semaine_id = v_sem.id and commercial_id = v_uid and actif),
    'mon_commentaire', (select commentaire from public.commando_vote_participations where semaine_id = v_sem.id and commercial_id = v_uid),
    'participation', jsonb_build_object(
      'votants', (select count(*) from public.commando_vote_participations where semaine_id = v_sem.id),
      'commerciaux', (select count(*) from public.commando_membres where role = 'commercial')),
    'votants', case when v_resp then (select coalesce(jsonb_agg(jsonb_build_object('commercial_id', commercial_id, 'le', modifie_le, 'commentaire', commentaire) order by vote_le), '[]'::jsonb)
                                        from public.commando_vote_participations where semaine_id = v_sem.id) end,
    'sujets', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'titre', t.titre, 'famille', t.famille, 'offre_rex', t.offre_rex, 'pourquoi_maintenant', t.pourquoi_maintenant,
        'points_cles', coalesce(t.trames->'vert'->'points_cles', '[]'::jsonb),
        'accroche', t.trames->'vert'->>'accroche', 'argument', t.trames->'vert'->>'argument',
        'statut', t.statut, 'ordre', t.ordre,
        'votes', case when v_voir then c.votes end, 'rang', case when v_voir then c.rang end,
        'votants', case when v_resp then (select coalesce(jsonb_agg(x.commercial_id), '[]'::jsonb) from public.commando_votes x where x.thematique_id = t.id and x.actif) end
      ) order by t.ordre, t.created_at), '[]'::jsonb)
        from public.commando_thematiques t
        join public.commando_vote_classement(v_sem.id) c on c.thematique_id = t.id
       where t.semaine_id = v_sem.id and t.statut <> 'ecartee')
  );
end $$;
revoke all on function public.commando_vote_etat(uuid) from public, anon;
grant execute on function public.commando_vote_etat(uuid) to authenticated;

-- ------------------------------------------------------------
-- Points : participation au vote (3 par défaut, une fois par semaine).
-- ------------------------------------------------------------
alter table public.commando_points drop constraint if exists commando_points_type_check;
alter table public.commando_points add constraint commando_points_type_check
  check (type in ('appel','rdv','rdv_annule','rdv_honore','premier_rdv','pronostic','badge','mail','vote','ajustement','depense'));

update public.commando_parametres
   set jeux = jsonb_set(jeux, '{points,vote}', '3'::jsonb, true)
 where jeux ? 'points' and not (jeux->'points' ? 'vote');

create or replace function public.commando_points_bareme()
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select '{"actif": true, "appel": 1, "rdv": 10, "rdv_honore": 25, "premier_rdv": 15, "pronostic": 10, "badge": 20, "mail": 5, "vote": 3}'::jsonb
         || coalesce((select jeux->'points' from public.commando_parametres where id), '{}'::jsonb)
$$;

create or replace function public.commando_points_crediter()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b jsonb := public.commando_points_bareme();
  p jsonb := (select jeux from public.commando_parametres where id);
  n_total int := 0; n int;
begin
  if not coalesce((b->>'actif')::boolean, true) then return jsonb_build_object('actif', false); end if;

  -- 1) Un appel enregistré.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'appel', (b->>'appel')::int, 'appel:' || a.id, 'Appel passé', a.created_at, a.id
    from public.commando_appels a
   where a.semaine_id is not null and (b->>'appel')::int <> 0
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 2) Un RDV pris (repris s'il est annulé).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv', (b->>'rdv')::int, 'appel:' || a.id, 'RDV pris', a.created_at, a.id
    from public.commando_appels a
   where a.statut = 'rdv' and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv_annule', -x.points, 'appel:' || a.id, 'RDV annulé : points repris', a.id
    from public.commando_appels a
    join public.commando_points x on x.type = 'rdv' and x.reference = 'appel:' || a.id
   where a.statut = 'rdv' and a.rdv_statut = 'annule' and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 3) Un RDV honoré, validé par le responsable.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv_honore', (b->>'rdv_honore')::int, 'appel:' || a.id, 'RDV honoré (validé)', a.rdv_valide_le, a.id
    from public.commando_appels a
   where a.statut = 'rdv' and a.rdv_statut = 'honore' and a.rdv_valide_le is not null and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 4) Premier RDV d'un créneau de jeu (indépendant des fiches, qui peuvent être plafonnées).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select c.commercial_id, c.semaine_id, 'premier_rdv', (b->>'premier_rdv')::int, 'appel:' || c.id, 'Premier RDV de l''heure', c.created_at, c.id
    from (select distinct on (public.commando_creneau(a.created_at)) a.*
            from public.commando_appels a
           where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule' and a.semaine_id is not null
             and public.commando_jeux_heure_ok(a.created_at, p)
           order by public.commando_creneau(a.created_at), a.created_at) c
   where coalesce((p->>'premier_rdv')::boolean, true)
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 5) Un pronostic tenu.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, pronostic_id)
  select x.commercial_id, x.semaine_id, 'pronostic', (b->>'pronostic')::int, 'pronostic:' || x.id, 'Pronostic tenu (' || x.annonce || ' RDV)', x.resolu_le, x.id
    from public.commando_pronostics x
   where x.reussi
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 6 bis) Un mail de suivi préparé et ouvert dans la messagerie du commercial.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'mail', (b->>'mail')::int, 'appel:' || a.id, 'Mail de suivi envoyé', a.mail_prepare_le, a.id
    from public.commando_appels a
   where a.mail_prepare_le is not null and a.semaine_id is not null and (b->>'mail')::int <> 0
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 6 ter) Participation au vote des sujets de la semaine.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at)
  select v.commercial_id, v.semaine_id, 'vote', (b->>'vote')::int, 'vote:' || v.semaine_id || ':' || v.commercial_id,
         'Vote des sujets de la semaine', v.vote_le
    from public.commando_vote_participations v
   where (b->>'vote')::int <> 0
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 6) Badges des semaines terminées (le lundi suivant au plus tôt).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle)
  select bd.commercial_id, s.id, 'badge', (b->>'badge')::int, 'badge:' || s.semaine || ':' || bd.badge,
         'Badge ' || initcap(bd.badge) || ' (' || s.semaine || ')'
    from public.commando_semaines s
    cross join lateral public.commando_badges_semaine(s.id) bd
   where s.statut = 'publiee' and bd.commercial_id is not null
     and public.commando_lundi(s.semaine) + 7 <= (now() at time zone 'Europe/Paris')::date
     and coalesce((p->>'ligue')::boolean, true)
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  return jsonb_build_object('nouvelles_lignes', n_total);
end $$;
revoke all on function public.commando_points_crediter() from public, anon, authenticated;

-- Échéances du vote : chaque minute.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_vote_echeances')
      where exists (select 1 from cron.job where jobname = 'commando_vote_echeances');
    perform cron.schedule('commando_vote_echeances', '* * * * *', 'select public.commando_vote_traiter_echeances()');
  end if;
end $$;
