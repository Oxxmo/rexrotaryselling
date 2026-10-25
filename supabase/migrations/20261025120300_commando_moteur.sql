-- ============================================================
--  Rex Commando — 4/ Moteur de couleurs, publication, listes
-- ------------------------------------------------------------
--  * commando_couleur : moteur déterministe (règles dans l'ordre,
--    conditions en ET, valeurs en OU, première règle gagnante,
--    sinon « non classée »). Unique implémentation, en SQL.
--  * commando_valider_regles : rejette tout champ inconnu (aussi
--    posé en contrainte CHECK sur commando_thematiques).
--  * commando_apercu_compteurs : compteurs avant publication.
--  * commando_publier : instantané figé des couleurs (ciblages).
--  * commando_liste : « Ma liste » (chaque entreprise une seule
--    fois, sous sa meilleure couleur) et vue par thématique.
--  * commando_importer_thematiques : import manuel d'un fichier au
--    format de la veille (ex. thematiques_exemple.json).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Ancienneté (classes paramétrables)
-- ------------------------------------------------------------
create or replace function public.commando_anciennete(_date_creation date, _bornes jsonb)
returns text
language sql stable as $$
  select case
    when _date_creation is null then null
    when (current_date - _date_creation) / 365.25 < coalesce((_bornes->>'moins_3')::numeric, 3) then 'moins_3'
    when (current_date - _date_creation) / 365.25 >= coalesce((_bornes->>'plus_5')::numeric, 5) then 'plus_5'
    else '3_5' end;
$$;

-- ------------------------------------------------------------
-- 2) Validation des règles
--    Renvoie null si tout est valide, sinon le message d'erreur.
-- ------------------------------------------------------------
create or replace function public.commando_valider_regles(_regles jsonb)
returns text
language plpgsql immutable as $$
declare
  r jsonb; si jsonb; k text; v text; i int := 0;
  tranches_ok text[] := '{00,01,02,03,11,12,21,22,31,32,41,42,51,52,53}';
  anc_ok text[] := '{moins_3,3_5,plus_5}';
begin
  if _regles is null or jsonb_typeof(_regles) <> 'array' then return 'Les règles doivent être une liste.'; end if;
  for r in select * from jsonb_array_elements(_regles) loop
    i := i + 1;
    if jsonb_typeof(r) <> 'object' then return format('Règle %s : objet attendu.', i); end if;
    if coalesce(r->>'couleur','') not in ('vert','orange','rouge') then
      return format('Règle %s : couleur « %s » inconnue (vert, orange ou rouge).', i, coalesce(r->>'couleur',''));
    end if;
    si := r->'si';
    if si is null or jsonb_typeof(si) <> 'object' then return format('Règle %s : le bloc « si » est obligatoire.', i); end if;
    for k in select jsonb_object_keys(si) loop
      if k not in ('naf_prefixes','naf_exclus','tranches','anciennete') then
        return format('Règle %s : condition « %s » inconnue (naf_prefixes, naf_exclus, tranches, anciennete).', i, k);
      end if;
      if jsonb_typeof(si->k) <> 'array' then return format('Règle %s : « %s » doit être une liste.', i, k); end if;
      for v in select jsonb_array_elements_text(si->k) loop
        if coalesce(v,'') = '' then return format('Règle %s : valeur vide dans « %s ».', i, k); end if;
        if k = 'tranches' and not (v = any(tranches_ok)) then return format('Règle %s : tranche « %s » inconnue.', i, v); end if;
        if k = 'anciennete' and not (v = any(anc_ok)) then return format('Règle %s : ancienneté « %s » inconnue (moins_3, 3_5, plus_5).', i, v); end if;
        if k in ('naf_prefixes','naf_exclus') and v !~ '^[0-9]{2}(\.?[0-9]{1,2}[A-Z]?)?$' then
          return format('Règle %s : préfixe NAF « %s » invalide (ex. 43, 43.2, 43.22A).', i, v);
        end if;
      end loop;
    end loop;
  end loop;
  return null;
end $$;

alter table public.commando_thematiques
  add constraint commando_thematiques_regles_valides check (public.commando_valider_regles(regles) is null);

-- ------------------------------------------------------------
-- 3) Moteur de couleurs (déterministe, sans IA)
--    Retour : {"couleur": …|null, "regle_index": n|null, "raison": …|null}
--    regle_index commence à 0.
-- ------------------------------------------------------------
create or replace function public.commando_couleur(_regles jsonb, _naf text, _tranche text, _anciennete text)
returns jsonb
language plpgsql immutable as $$
declare
  r jsonb; si jsonb; k text; v text; i int := 0; ok boolean; hit boolean;
  naf text := replace(coalesce(_naf, ''), '.', '');
  vide jsonb := jsonb_build_object('couleur', null, 'regle_index', null, 'raison', null);
begin
  if _regles is null or jsonb_typeof(_regles) <> 'array' then return vide; end if;
  for r in select * from jsonb_array_elements(_regles) loop
    si := coalesce(r->'si', '{}'::jsonb);
    ok := true;
    for k in select jsonb_object_keys(si) loop
      if k = 'naf_prefixes' then
        hit := false;
        for v in select jsonb_array_elements_text(si->k) loop
          if naf like replace(v, '.', '') || '%' then hit := true; end if;
        end loop;
        if not hit then ok := false; end if;
      elsif k = 'naf_exclus' then
        for v in select jsonb_array_elements_text(si->k) loop
          if naf like replace(v, '.', '') || '%' then ok := false; end if;
        end loop;
      elsif k = 'tranches' then
        if _tranche is null or not ((si->k) ? _tranche) then ok := false; end if;
      elsif k = 'anciennete' then
        if _anciennete is null or not ((si->k) ? _anciennete) then ok := false; end if;
      else
        raise exception 'Condition inconnue dans une règle : %', k;
      end if;
      exit when not ok;
    end loop;
    if ok then
      return jsonb_build_object('couleur', r->>'couleur', 'regle_index', i, 'raison', r->>'raison');
    end if;
    i := i + 1;
  end loop;
  return vide;
end $$;

-- ------------------------------------------------------------
-- 4) Vue enrichie des entreprises (secteur, ancienneté, contact)
-- ------------------------------------------------------------
create or replace view public.commando_entreprises_v
with (security_invoker = true) as
  select e.*,
         cp.secteur_code, s.nom as secteur_nom, s.commercial_id,
         public.commando_anciennete(e.date_creation_ul, p.bornes_anciennete) as anciennete,
         (e.nouvelle_semaine is not null and e.nouvelle_semaine = public.commando_semaine_cible(current_date)) as est_nouvelle,
         c.telephone, c.email, coalesce(c.opposition, false) as opposition,
         (e.archived_at is null and not e.est_client and e.exclu_le is null and not coalesce(c.opposition, false)) as eligible
    from public.commando_entreprises e
    left join public.commando_codes_postaux cp on cp.code_postal = e.code_postal
    left join public.commando_secteurs s on s.code = cp.secteur_code
    left join public.commando_contacts c on c.siret = e.siret
    cross join (select bornes_anciennete from public.commando_parametres where id) p;
grant select on public.commando_entreprises_v to authenticated;

-- ------------------------------------------------------------
-- 5) Aperçu des compteurs d'une thématique (avant publication)
-- ------------------------------------------------------------
create or replace function public.commando_apercu_compteurs(_thematique_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_regles jsonb; v_res jsonb;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  select regles into v_regles from public.commando_thematiques where id = _thematique_id;
  if v_regles is null then raise exception 'Thématique introuvable'; end if;
  with cl as (
    select v.secteur_code,
           coalesce(public.commando_couleur(v_regles, v.naf_code, v.tranche_effectif, v.anciennete)->>'couleur', 'non_classee') as couleur
      from public.commando_entreprises_v v
     where v.eligible
  ),
  par as (
    select secteur_code, jsonb_build_object(
      'vert',  count(*) filter (where couleur = 'vert'),
      'orange', count(*) filter (where couleur = 'orange'),
      'rouge', count(*) filter (where couleur = 'rouge'),
      'non_classee', count(*) filter (where couleur = 'non_classee'),
      'total', count(*)) as c
    from cl group by secteur_code
  )
  select jsonb_build_object(
    'par_secteur', coalesce((select jsonb_object_agg(coalesce(secteur_code, '?'), c) from par), '{}'::jsonb),
    'total', (select jsonb_build_object(
      'vert',  count(*) filter (where couleur = 'vert'),
      'orange', count(*) filter (where couleur = 'orange'),
      'rouge', count(*) filter (where couleur = 'rouge'),
      'non_classee', count(*) filter (where couleur = 'non_classee'),
      'total', count(*)) from cl))
  into v_res;
  return v_res;
end $$;
revoke all on function public.commando_apercu_compteurs(uuid) from public, anon;
grant execute on function public.commando_apercu_compteurs(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6) Publication : instantané figé des couleurs
-- ------------------------------------------------------------
create or replace function public.commando_publier(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sem record; v_nb int; v_appels int; v_res jsonb;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
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
     set statut = 'publiee', publiee_le = now(), publiee_par = auth.uid()
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
revoke all on function public.commando_publier(uuid) from public, anon;
grant execute on function public.commando_publier(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7) Listes : « Ma liste » (thematique null) ou vue par thématique
--    Secteurs visibles : ceux affectés à l'appelant ; le secteur libre
--    pour le responsable (ou pour tous si le paramètre le permet).
-- ------------------------------------------------------------
create or replace function public.commando_liste(_semaine_id uuid, _thematique_id uuid default null)
returns table (
  siret text, raison_sociale text, enseigne text, naf_code text, naf_libelle text,
  tranche_effectif text, annee_effectif int, anciennete text, date_creation_ul date,
  dirigeants jsonb, adresse text, code_postal text, commune text, secteur_code text,
  est_nouvelle boolean, telephone text, email text,
  thematique_id uuid, thematique_titre text, couleur text, regle_index int, raison text,
  dernier_appel_le timestamptz, dernier_appel_statut text, dernier_appel_par uuid,
  bloquee_jusqua date, deja_appelee boolean, nb_appels bigint
)
language sql stable security definer set search_path = public as $$
  with p as (select * from public.commando_parametres where id),
  moi as (select auth.uid() as uid,
                 public.commando_est_membre(auth.uid()) as membre,
                 public.commando_est_responsable(auth.uid()) as resp),
  visibles as (
    select s.code from public.commando_secteurs s, moi, p
     where moi.membre
       and (s.commercial_id = moi.uid
            or (s.commercial_id is null and (moi.resp or p.secteur_libre_visible_par = 'equipe')))
  ),
  sem as (select semaine from public.commando_semaines where id = _semaine_id),
  cibl as (
    select ci.siret, ci.thematique_id, ci.couleur, ci.regle_index, ci.raison, t.titre, t.ordre,
           case ci.couleur when 'vert' then 1 when 'orange' then 2 when 'rouge' then 3 else 4 end as rang
      from public.commando_ciblages ci
      join public.commando_thematiques t on t.id = ci.thematique_id
     where ci.semaine_id = _semaine_id and t.statut = 'retenue'
       and (_thematique_id is null or ci.thematique_id = _thematique_id)
  ),
  choix as (select distinct on (siret) * from cibl order by siret, rang, ordre),
  dernier as (
    select distinct on (a.siret) a.siret, a.created_at, a.statut, a.commercial_id, a.date_rappel
      from public.commando_appels a order by a.siret, a.created_at desc
  ),
  nb as (select a.siret, count(*) as n from public.commando_appels a group by a.siret)
  select v.siret, v.raison_sociale, v.enseigne, v.naf_code, v.naf_libelle,
         v.tranche_effectif, v.annee_effectif, v.anciennete, v.date_creation_ul,
         v.dirigeants, v.adresse, v.code_postal, v.commune, v.secteur_code,
         (v.nouvelle_semaine is not null and v.nouvelle_semaine = sem.semaine) as est_nouvelle,
         v.telephone, v.email,
         ch.thematique_id, ch.titre, ch.couleur, ch.regle_index, ch.raison,
         d.created_at, d.statut, d.commercial_id,
         bl.bloquee, coalesce(bl.bloquee > current_date, false), coalesce(nb.n, 0)
    from public.commando_entreprises_v v
    join visibles vs on vs.code = v.secteur_code
    join choix ch on ch.siret = v.siret
    cross join sem
    cross join p
    left join dernier d on d.siret = v.siret
    left join nb on nb.siret = v.siret
    cross join lateral (select case d.statut
        when 'refus'       then d.created_at::date + p.delai_rappel_refus_semaines * 7
        when 'injoignable' then d.created_at::date + p.delai_rappel_injoignable_semaines * 7
        when 'rappeler'    then coalesce(d.date_rappel, d.created_at::date + 7)
        when 'rdv'         then d.created_at::date + p.delai_rappel_refus_semaines * 7
        else null end as bloquee) bl
   where v.eligible
   order by coalesce(bl.bloquee > current_date, false), ch.rang,
            (v.nouvelle_semaine is not null and v.nouvelle_semaine = sem.semaine) desc,
            (v.anciennete = '3_5') desc, v.raison_sociale;
$$;
revoke all on function public.commando_liste(uuid, uuid) from public, anon;
grant execute on function public.commando_liste(uuid, uuid) to authenticated;

-- Compteurs d'une semaine publiée pour l'appelant (en-tête de « Ma liste »).
create or replace function public.commando_ma_semaine(_semaine_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with l as (select * from public.commando_liste(_semaine_id, null)),
  mes as (select * from public.commando_appels a where a.semaine_id = _semaine_id and a.commercial_id = auth.uid())
  select jsonb_build_object(
    'a_appeler', (select count(*) from l where not deja_appelee),
    'vert', (select count(*) from l where couleur = 'vert' and not deja_appelee),
    'orange', (select count(*) from l where couleur = 'orange' and not deja_appelee),
    'rouge', (select count(*) from l where couleur = 'rouge' and not deja_appelee),
    'appels', (select count(*) from mes),
    'rdv', (select count(*) from mes where statut = 'rdv' and coalesce(rdv_statut, 'prevu') <> 'annule'),
    'objectif', (select objectif_rdv_semaine from public.commando_parametres where id));
$$;
revoke all on function public.commando_ma_semaine(uuid) from public, anon;
grant execute on function public.commando_ma_semaine(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8) Import manuel d'un fichier au format de la veille
--    (ex. thematiques_exemple.json). Crée la semaine (brouillon) si
--    besoin et ajoute les thématiques en « proposée ». Les sources
--    sont marquées non vérifiées (aucune recherche n'a eu lieu).
-- ------------------------------------------------------------
create or replace function public.commando_importer_thematiques(_json jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_semaine text := _json->>'semaine';
  v_id uuid; t jsonb; v_ordre int; v_sources jsonb; v_conc jsonb;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if v_semaine !~ '^[0-9]{4}-W[0-9]{2}$' then raise exception 'Semaine invalide : %', v_semaine; end if;
  if jsonb_typeof(_json->'thematiques') <> 'array' then raise exception 'Le fichier ne contient pas de liste « thematiques »'; end if;
  insert into public.commando_semaines (semaine) values (v_semaine) on conflict (semaine) do nothing;
  select id into v_id from public.commando_semaines where semaine = v_semaine;
  select coalesce(max(ordre), 0) into v_ordre from public.commando_thematiques where semaine_id = v_id;
  for t in select * from jsonb_array_elements(_json->'thematiques') loop
    v_ordre := v_ordre + 1;
    select coalesce(jsonb_agg(s || jsonb_build_object('verifiee', false)), '[]'::jsonb)
      into v_sources from jsonb_array_elements(coalesce(t->'sources', '[]'::jsonb)) s;
    v_conc := coalesce(t->'concurrence', '{}'::jsonb);
    insert into public.commando_thematiques
      (semaine_id, origine, statut, ordre, cle, titre, offre_rex, pourquoi_maintenant, sources,
       concurrence, regles, trames, objections, hypotheses, modifiee_par, modifiee_le)
    values
      (v_id, 'manuelle', 'proposee', v_ordre, t->>'id', coalesce(t->>'titre', 'Sans titre'),
       coalesce(t->>'offre_rex', ''), coalesce(t->>'pourquoi_maintenant', ''), v_sources,
       v_conc, coalesce(t->'regles', '[]'::jsonb), coalesce(t->'trames', '{}'::jsonb),
       coalesce(t->'objections', '[]'::jsonb), coalesce(t->'hypotheses', '[]'::jsonb),
       auth.uid(), now());
  end loop;
  return v_id;
end $$;
revoke all on function public.commando_importer_thematiques(jsonb) from public, anon;
grant execute on function public.commando_importer_thematiques(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 9) Répartition de la base (variable {{repartition_base}} de la veille)
-- ------------------------------------------------------------
create or replace function public.commando_repartition_base()
returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (select * from public.commando_entreprises_v where eligible)
  select jsonb_build_object(
    'total', (select count(*) from v),
    'tranches', (select coalesce(jsonb_object_agg(coalesce(tranche_effectif, 'inconnue'), n), '{}'::jsonb)
                   from (select tranche_effectif, count(*) n from v group by 1) x),
    'anciennete', (select coalesce(jsonb_object_agg(coalesce(anciennete, 'inconnue'), n), '{}'::jsonb)
                     from (select anciennete, count(*) n from v group by 1) x),
    'secteurs', (select coalesce(jsonb_object_agg(coalesce(secteur_code, '?'), n), '{}'::jsonb)
                   from (select secteur_code, count(*) n from v group by 1) x),
    'naf_divisions', (select coalesce(jsonb_agg(jsonb_build_object('division', d, 'n', n) order by n desc), '[]'::jsonb)
                        from (select left(naf_code, 2) d, count(*) n from v where naf_code is not null group by 1) x),
    'naf_principaux', (select coalesce(jsonb_agg(jsonb_build_object('code', naf_code, 'libelle', naf_libelle, 'n', n,
                                 'tranches', tr) order by n desc), '[]'::jsonb)
                         from (select naf_code, max(naf_libelle) naf_libelle, count(*) n,
                                      jsonb_object_agg(coalesce(tranche_effectif,'?'), c) tr
                                 from (select naf_code, naf_libelle, tranche_effectif, count(*) c from v where naf_code is not null group by 1,2,3) y
                                group by naf_code order by n desc limit 60) x)
  ) where public.commando_est_membre(auth.uid()) or auth.uid() is null;
$$;
revoke all on function public.commando_repartition_base() from public, anon;
grant execute on function public.commando_repartition_base() to authenticated;
