-- ============================================================
--  Rex Commando — 5/ Tableau de bord d'efficacité
-- ------------------------------------------------------------
--  commando_stats : appels, RDV pris, taux, RDV honorés par couleur,
--  thématique, règle, commercial et semaine ; RDV de la semaine par
--  commercial face à l'objectif ; drapeau « échantillon insuffisant »
--  sous le seuil paramétré. Alimente aussi {{performance}} de la veille.
--  Accès : responsable (ou service_role, auth.uid() null).
-- ============================================================

create or replace function public.commando_stats_bloc(_appels bigint, _rdv bigint, _honores bigint, _seuil int)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'appels', coalesce(_appels, 0), 'rdv', coalesce(_rdv, 0), 'honores', coalesce(_honores, 0),
    'taux', case when coalesce(_appels, 0) = 0 then null else round(coalesce(_rdv, 0)::numeric / _appels, 3) end,
    'echantillon_insuffisant', coalesce(_appels, 0) < _seuil);
$$;

create or replace function public.commando_stats(_depuis date default null, _jusqua date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seuil int; v_objectif int; v_res jsonb; v_sem_courante text := public.commando_semaine_cible(current_date);
begin
  if auth.uid() is not null and not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  select seuil_echantillon, objectif_rdv_semaine into v_seuil, v_objectif from public.commando_parametres where id;
  v_seuil := coalesce(v_seuil, 30); v_objectif := coalesce(v_objectif, 5);

  create temp table _ap on commit drop as
    select a.id, a.siret, a.commercial_id, a.statut, a.created_at, a.couleur_au_moment as couleur,
           a.regle_index_au_moment as regle_index, a.thematique_id,
           coalesce(s.semaine, public.commando_semaine_iso(a.created_at::date)) as semaine,
           t.titre, (t.regles -> a.regle_index_au_moment ->> 'raison') as raison,
           (t.regles -> a.regle_index_au_moment ->> 'couleur') as couleur_regle,
           pr.full_name as commercial_nom,
           (a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as rdv_pris,
           (a.statut = 'rdv' and a.rdv_statut = 'honore') as rdv_honore
      from public.commando_appels a
      left join public.commando_semaines s on s.id = a.semaine_id
      left join public.commando_thematiques t on t.id = a.thematique_id
      left join public.profiles pr on pr.id = a.commercial_id
     where (_depuis is null or a.created_at::date >= _depuis)
       and (_jusqua is null or a.created_at::date <= _jusqua);

  select jsonb_build_object(
    'periode', jsonb_build_object('depuis', _depuis, 'jusqua', _jusqua),
    'seuil', v_seuil, 'objectif', v_objectif, 'semaine_courante', v_sem_courante,
    'total', (select public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) from _ap),
    'par_couleur', (select coalesce(jsonb_agg(jsonb_build_object('couleur', couleur) || b order by case couleur when 'vert' then 1 when 'orange' then 2 when 'rouge' then 3 else 4 end), '[]'::jsonb)
                      from (select couleur, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b from _ap group by couleur) x),
    'par_thematique', (select coalesce(jsonb_agg(jsonb_build_object('thematique_id', thematique_id, 'titre', titre, 'semaine', semaine) || b order by semaine desc, titre), '[]'::jsonb)
                         from (select thematique_id, max(titre) titre, max(semaine) semaine, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b from _ap group by thematique_id) x),
    'par_regle', (select coalesce(jsonb_agg(jsonb_build_object('thematique_id', thematique_id, 'titre', titre, 'semaine', semaine, 'regle_index', regle_index, 'raison', raison, 'couleur_regle', couleur_regle) || b order by semaine desc, titre, regle_index), '[]'::jsonb)
                    from (select thematique_id, max(titre) titre, max(semaine) semaine, regle_index, max(raison) raison, max(couleur_regle) couleur_regle,
                                 public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b
                            from _ap where regle_index is not null group by thematique_id, regle_index) x),
    'par_commercial', (select coalesce(jsonb_agg(jsonb_build_object('commercial_id', commercial_id, 'nom', commercial_nom) || b order by commercial_nom), '[]'::jsonb)
                         from (select commercial_id, max(commercial_nom) commercial_nom, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b from _ap group by commercial_id) x),
    'par_semaine', (select coalesce(jsonb_agg(jsonb_build_object('semaine', semaine) || b order by semaine desc), '[]'::jsonb)
                      from (select semaine, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b from _ap group by semaine) x),
    'par_commercial_semaine', (select coalesce(jsonb_agg(jsonb_build_object('semaine', semaine, 'commercial_id', commercial_id, 'nom', commercial_nom) || b order by semaine desc, commercial_nom), '[]'::jsonb)
                                 from (select semaine, commercial_id, max(commercial_nom) commercial_nom, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), v_seuil) b from _ap group by semaine, commercial_id) x),
    -- RDV de la semaine courante par commercial membre (y compris à zéro), face à l'objectif
    'semaine_courante_par_commercial', (select coalesce(jsonb_agg(jsonb_build_object('commercial_id', m.user_id, 'nom', pr.full_name,
                                                 'appels', (select count(*) from _ap a where a.commercial_id = m.user_id and a.semaine = v_sem_courante),
                                                 'rdv', (select count(*) from _ap a where a.commercial_id = m.user_id and a.semaine = v_sem_courante and a.rdv_pris),
                                                 'objectif', v_objectif) order by pr.full_name), '[]'::jsonb)
                                          from public.commando_membres m join public.profiles pr on pr.id = m.user_id where m.role = 'commercial')
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_stats(date, date) from public, anon;
grant execute on function public.commando_stats(date, date) to authenticated;

-- Export CSV : une ligne par appel, avec le contexte (responsable).
create or replace function public.commando_appels_export()
returns table (
  date_appel timestamptz, semaine text, commercial text, entreprise text, siret text, code_postal text, secteur text,
  thematique text, couleur text, regle_index int, raison text, statut text, date_rdv timestamptz, rdv_statut text, note text
)
language sql stable security definer set search_path = public as $$
  select a.created_at, s.semaine, pr.full_name, e.raison_sociale, a.siret, e.code_postal, cp.secteur_code,
         t.titre, a.couleur_au_moment, a.regle_index_au_moment, (t.regles -> a.regle_index_au_moment ->> 'raison'),
         a.statut, a.date_rdv, a.rdv_statut, a.note
    from public.commando_appels a
    left join public.commando_semaines s on s.id = a.semaine_id
    left join public.profiles pr on pr.id = a.commercial_id
    left join public.commando_entreprises e on e.siret = a.siret
    left join public.commando_codes_postaux cp on cp.code_postal = e.code_postal
    left join public.commando_thematiques t on t.id = a.thematique_id
   where public.commando_est_responsable(auth.uid())
   order by a.created_at desc;
$$;
revoke all on function public.commando_appels_export() from public, anon;
grant execute on function public.commando_appels_export() to authenticated;
