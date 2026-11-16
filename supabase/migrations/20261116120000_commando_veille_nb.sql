-- ============================================================
--  Rex Commando — veille : nombre de sujets au choix, relance du pilote
-- ------------------------------------------------------------
--  Lundi 16 novembre : la veille automatique de 7 h a échoué à la première
--  étape (réponse tronquée) et le pilote ne l'a pas relancée ; les relances
--  manuelles pour obtenir plus de 5 sujets ont échoué de la même façon.
--   - la veille accepte de 3 à 12 sujets (paramètre « nb » de la fonction
--     commando-veille ; pilote : réglage « nb_sujets », 6 par défaut) ;
--   - le pilote relance une veille en erreur (3 essais au plus) ;
--   - les générations en erreur ne comptent plus dans la limite hebdomadaire.
-- ============================================================

update public.commando_parametres
   set pilote = pilote || jsonb_build_object('nb_sujets', 6)
 where id and not (pilote ? 'nb_sujets');

create or replace function public.commando_veille_lancer_nb(_semaine_id uuid, _par uuid, _nb int)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record; v_nb int; v_id uuid; v_voulu int := least(12, greatest(3, coalesce(_nb, 5))); v_lots int;
begin
  select * into p from public.commando_parametres where id;
  if p.fiche_rex is null or p.fiche_rex_validee_le is null then
    raise exception 'La fiche Rex-Rotary doit être validée avant de lancer la veille.';
  end if;
  select count(*) into v_nb from public.commando_generations
   where semaine_id = _semaine_id and type in ('veille', 'regeneration') and statut <> 'erreur';
  if v_nb >= coalesce(p.limite_generations_semaine, 5) then
    raise exception 'Limite de générations atteinte pour cette semaine (%).', v_nb;
  end if;
  if exists (select 1 from public.commando_generations where semaine_id = _semaine_id and statut = 'en_cours') then
    raise exception 'Une génération est déjà en cours pour cette semaine.';
  end if;
  v_lots := ceil(v_voulu / 5.0);
  insert into public.commando_generations (semaine_id, type, modele, prompt_version, lancee_par, etat)
  values (_semaine_id, 'veille', coalesce(p.modele, 'claude-sonnet-5-5'), 7, _par,
          jsonb_build_object('phase', 'recherche', 'etape', 1, 'total', v_voulu + v_lots,
                             'attendu', least(5, v_voulu), 'attendu_total', v_voulu, 'lots', 1, 'lots_max', v_lots + 1,
                             'libelle', 'Veille d''actualité et concurrentielle (recherche web)',
                             'en_vol', false, 'phase_debut', now()::text, 'relance_apres', now()::text,
                             'tentatives', 0, 'propositions', '[]'::jsonb, 'ecrites', '[]'::jsonb,
                             'urls', '[]'::jsonb, 'usage', '{}'::jsonb, 'auto', true))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.commando_veille_lancer_nb(uuid, uuid, int) from public, anon, authenticated;

-- Lancement par le pilote : nombre de sujets du réglage « nb_sujets ».
create or replace function public.commando_veille_lancer_interne(_semaine_id uuid, _par uuid)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.commando_veille_lancer_nb(_semaine_id, _par,
    coalesce((select (pilote->>'nb_sujets')::int from public.commando_parametres where id), 6));
$$;
revoke all on function public.commando_veille_lancer_interne(uuid, uuid) from public, anon, authenticated;

create or replace function public.commando_pilote_tick(_maintenant timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select pilote from public.commando_parametres where id);
  loc timestamp := _maintenant at time zone 'Europe/Paris';
  v_heure time; v_cloture time; v_fin timestamptz;
  v_semaine text; v_sem record; v_resp uuid; v_nb int; v_retenues int; v_choix int; v_id uuid; v_echecs int; v_autres int;
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

  -- 1) Veille : pas assez de sujets, aucune veille en cours ni aboutie.
  --    Une veille en erreur est relancée (3 essais au plus dans la matinée).
  select count(*) filter (where statut = 'erreur'), count(*) filter (where statut <> 'erreur')
    into v_echecs, v_autres
    from public.commando_generations where semaine_id = v_sem.id and type in ('veille', 'regeneration');
  if v_nb < 4 and v_autres = 0 and v_echecs < 3 then
    if _maintenant >= v_fin - interval '90 minutes' then
      return jsonb_build_object('action', 'aucune', 'raison', 'trop tard pour une veille');
    end if;
    begin
      v_id := public.commando_veille_lancer_interne(v_sem.id, v_resp);
      insert into public.commando_pilote_journal (le, semaine, action, detail)
      values (_maintenant, v_semaine, case when v_echecs > 0 then 'veille_relancee' else 'veille_lancee' end,
              jsonb_build_object('generation_id', v_id, 'essai', v_echecs + 1));
      return jsonb_build_object('action', case when v_echecs > 0 then 'veille_relancee' else 'veille_lancee' end, 'generation_id', v_id);
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
