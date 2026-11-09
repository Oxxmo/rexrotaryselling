-- ============================================================
--  Rex Commando — « Ma liste » en blocs, complément, fiches passées
-- ------------------------------------------------------------
--  commando_ma_liste : chaque entreprise du secteur une seule fois,
--  rangée dans un bloc :
--    rappel  : « à rappeler » arrivé à échéance depuis moins de 8 jours
--    neuve   : jamais appelée
--    relance : déjà appelée, délai écoulé (injoignable, refus ancien…)
--    attente : appel récent, délai en cours
--    passee  : passée par un commercial (hors cible, fermée…)
--  Plancher : si les sujets de la semaine donnent moins de N fiches
--  neuves vertes ou orange à un commercial (paramètre, 40 par défaut),
--  sa liste est complétée par les meilleures fiches neuves non classées
--  (« complément »).
--  Priorité à l'intérieur d'une couleur : événement BODACC récent,
--  nouvelle entreprise, numéro connu, taille, chiffre d'affaires ; puis
--  rotation quotidienne propre à chaque commercial.
--  commando_liste reste disponible (mêmes colonnes) pour les écrans
--  qui n'ont pas encore été mis à jour.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Calcul commun (interne) : secteurs et utilisateur explicites
-- ------------------------------------------------------------
create or replace function public.commando_liste_calcul(
  _semaine_id uuid, _thematique_id uuid, _secteurs text[], _uid uuid)
returns table (
  siret text, raison_sociale text, enseigne text, naf_code text, naf_libelle text,
  tranche_effectif text, annee_effectif int, anciennete text, date_creation_ul date,
  dirigeants jsonb, adresse text, code_postal text, commune text, secteur_code text,
  est_nouvelle boolean, telephone text, email text,
  thematique_id uuid, thematique_titre text, couleur text, regle_index int, raison text,
  dernier_appel_le timestamptz, dernier_appel_statut text, dernier_appel_par uuid,
  bloquee_jusqua date, deja_appelee boolean, nb_appels bigint,
  bloc text, complement boolean, priorite int,
  signal text, signal_type text, signal_le date, signal_url text,
  ca bigint, ca_annee int, telephone_source text,
  passee_raison text, passee_jusqua date, ordre bigint
)
language sql stable security definer set search_path = public as $$
  with p as (select * from public.commando_parametres where id),
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
  nb as (select a.siret, count(*) as n from public.commando_appels a group by a.siret),
  ev as (
    select distinct on (e.siren) e.siren, e.libelle, e.type, e.date_parution, e.url
      from public.commando_evenements e
     where e.type in ('dirigeant','demenagement','rachat','etablissement','capital','activite')
       and e.date_parution > current_date - 90
     order by e.siren, e.date_parution desc,
              case e.type when 'dirigeant' then 1 when 'demenagement' then 2 when 'rachat' then 3
                          when 'etablissement' then 4 when 'capital' then 5 else 6 end
  ),
  base as (
    select v.siret, v.raison_sociale, v.enseigne, v.naf_code, v.naf_libelle,
           v.tranche_effectif, v.annee_effectif, v.anciennete, v.date_creation_ul,
           v.dirigeants, v.adresse, v.code_postal, v.commune, v.secteur_code,
           (v.nouvelle_semaine is not null and v.nouvelle_semaine = sem.semaine) as est_nouvelle,
           v.telephone, v.email,
           ch.thematique_id, ch.titre as thematique_titre, ch.couleur, ch.regle_index, ch.raison,
           d.created_at as dernier_appel_le, d.statut as dernier_appel_statut, d.commercial_id as dernier_appel_par,
           bl.bloquee as bloquee_jusqua, coalesce(bl.bloquee > current_date, false) as deja_appelee,
           coalesce(nb.n, 0) as nb_appels,
           case
             when pa.siret is not null then 'passee'
             when coalesce(bl.bloquee > current_date, false) then 'attente'
             when d.statut = 'rappeler' and bl.bloquee >= current_date - 7 then 'rappel'
             when coalesce(nb.n, 0) = 0 then 'neuve'
             else 'relance' end as bloc,
           ( case when ev.type in ('dirigeant','demenagement','rachat','etablissement') then 4
                  when ev.type is not null then 2 else 0 end
           + case when v.nouvelle_semaine is not null and v.nouvelle_semaine = sem.semaine then 3 else 0 end
           + case when v.telephone is not null then 2 else 0 end
           + case v.tranche_effectif when '21' then 2 when '12' then 1 else 0 end
           + case when f.ca >= 5000000 then 2 when f.ca >= 1000000 then 1 else 0 end )::int as priorite,
           ev.libelle as signal, ev.type as signal_type, ev.date_parution as signal_le, ev.url as signal_url,
           f.ca, f.annee as ca_annee, c.source as telephone_source,
           pa.raison as passee_raison, pa.jusqua as passee_jusqua,
           md5(v.siret || ':' || current_date::text || ':' || coalesce(_uid::text, '')) as rot
      from public.commando_entreprises_v v
      join choix ch on ch.siret = v.siret
      cross join sem
      cross join p
      left join dernier d on d.siret = v.siret
      left join nb on nb.siret = v.siret
      left join ev on ev.siren = v.siren
      left join public.commando_finances f on f.siren = v.siren
      left join public.commando_contacts c on c.siret = v.siret
      left join public.commando_passages pa on pa.siret = v.siret and pa.annule_le is null and pa.jusqua > current_date
      cross join lateral (select case d.statut
          when 'refus'       then d.created_at::date + p.delai_rappel_refus_semaines * 7
          when 'injoignable' then d.created_at::date + p.delai_rappel_injoignable_semaines * 7
          when 'rappeler'    then coalesce(d.date_rappel, d.created_at::date + 7)
          when 'rdv'         then d.created_at::date + p.delai_rappel_refus_semaines * 7
          else null end as bloquee) bl
     where v.eligible and v.secteur_code = any(_secteurs)
  ),
  stock as (
    select b.secteur_code, count(*) as n from base b
     where b.bloc = 'neuve' and b.couleur in ('vert', 'orange') group by b.secteur_code
  ),
  candidats as (
    select b.siret, b.secteur_code,
           row_number() over (partition by b.secteur_code order by b.priorite desc, b.rot) as rn
      from base b
     where _thematique_id is null and b.bloc = 'neuve' and b.couleur is null
  ),
  compl as (
    select x.siret from candidats x cross join p
      left join stock s on s.secteur_code = x.secteur_code
     where x.rn <= greatest(0, p.plancher_fiches_neuves - coalesce(s.n, 0))
  ),
  fin as (
    select b.*, (cp.siret is not null) as est_compl
      from base b left join compl cp on cp.siret = b.siret
  )
  select siret, raison_sociale, enseigne, naf_code, naf_libelle,
         tranche_effectif, annee_effectif, anciennete, date_creation_ul,
         dirigeants, adresse, code_postal, commune, secteur_code,
         est_nouvelle, telephone, email,
         thematique_id, thematique_titre, couleur, regle_index, raison,
         dernier_appel_le, dernier_appel_statut, dernier_appel_par,
         bloquee_jusqua, deja_appelee, nb_appels,
         bloc, est_compl, priorite,
         signal, signal_type, signal_le, signal_url,
         ca, ca_annee, telephone_source,
         passee_raison, passee_jusqua,
         row_number() over (order by
           case bloc when 'rappel' then 1 when 'neuve' then 2 when 'relance' then 3 when 'attente' then 4 else 5 end,
           case when couleur = 'vert' then 1 when couleur = 'orange' then 2 when est_compl then 3
                when couleur is null then 4 else 5 end,
           priorite desc, rot, siret) as ordre
    from fin
   order by ordre;
$$;
revoke all on function public.commando_liste_calcul(uuid, uuid, text[], uuid) from public, anon, authenticated;

-- Secteurs visibles par un membre : les siens ; le secteur libre pour le
-- responsable (ou pour tous si le paramètre le permet).
create or replace function public.commando_secteurs_visibles(_uid uuid)
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(s.code order by s.code), '{}')
    from public.commando_secteurs s, public.commando_parametres p
   where p.id and public.commando_est_membre(_uid)
     and (s.commercial_id = _uid
          or (s.commercial_id is null and (public.commando_est_responsable(_uid) or p.secteur_libre_visible_par = 'equipe')));
$$;
revoke all on function public.commando_secteurs_visibles(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2) « Ma liste » de l'appelant
-- ------------------------------------------------------------
create or replace function public.commando_ma_liste(_semaine_id uuid, _thematique_id uuid default null)
returns table (
  siret text, raison_sociale text, enseigne text, naf_code text, naf_libelle text,
  tranche_effectif text, annee_effectif int, anciennete text, date_creation_ul date,
  dirigeants jsonb, adresse text, code_postal text, commune text, secteur_code text,
  est_nouvelle boolean, telephone text, email text,
  thematique_id uuid, thematique_titre text, couleur text, regle_index int, raison text,
  dernier_appel_le timestamptz, dernier_appel_statut text, dernier_appel_par uuid,
  bloquee_jusqua date, deja_appelee boolean, nb_appels bigint,
  bloc text, complement boolean, priorite int,
  signal text, signal_type text, signal_le date, signal_url text,
  ca bigint, ca_annee int, telephone_source text,
  passee_raison text, passee_jusqua date, ordre bigint
)
language sql stable security definer set search_path = public as $$
  select l.* from public.commando_liste_calcul(_semaine_id, _thematique_id,
                    public.commando_secteurs_visibles(auth.uid()), auth.uid()) l
   order by l.ordre;
$$;
revoke all on function public.commando_ma_liste(uuid, uuid) from public, anon;
grant execute on function public.commando_ma_liste(uuid, uuid) to authenticated;

-- Ancienne signature, mêmes colonnes qu'avant (écrans pas encore mis à jour).
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
  select l.siret, l.raison_sociale, l.enseigne, l.naf_code, l.naf_libelle,
         l.tranche_effectif, l.annee_effectif, l.anciennete, l.date_creation_ul,
         l.dirigeants, l.adresse, l.code_postal, l.commune, l.secteur_code,
         l.est_nouvelle, l.telephone, l.email,
         l.thematique_id, l.thematique_titre, l.couleur, l.regle_index, l.raison,
         l.dernier_appel_le, l.dernier_appel_statut, l.dernier_appel_par,
         l.bloquee_jusqua, l.deja_appelee, l.nb_appels
    from public.commando_ma_liste(_semaine_id, _thematique_id) l
   where l.bloc <> 'passee'
   order by l.ordre;
$$;
revoke all on function public.commando_liste(uuid, uuid) from public, anon;
grant execute on function public.commando_liste(uuid, uuid) to authenticated;

-- Compteurs de l'en-tête de « Ma liste ».
create or replace function public.commando_ma_semaine(_semaine_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with l as (select * from public.commando_ma_liste(_semaine_id, null)),
  mes as (select * from public.commando_appels a where a.semaine_id = _semaine_id and a.commercial_id = auth.uid())
  select jsonb_build_object(
    'a_appeler', (select count(*) from l where l.bloc = 'rappel'
                    or (l.bloc = 'neuve' and (l.couleur in ('vert', 'orange') or l.complement))),
    'rappels', (select count(*) from l where l.bloc = 'rappel'),
    'neuves', (select count(*) from l where l.bloc = 'neuve' and (l.couleur in ('vert', 'orange') or l.complement)),
    'relances', (select count(*) from l where l.bloc = 'relance'),
    'complement', (select count(*) from l where l.complement),
    'passees', (select count(*) from l where l.bloc = 'passee'),
    'vert', (select count(*) from l where l.bloc = 'neuve' and l.couleur = 'vert'),
    'orange', (select count(*) from l where l.bloc = 'neuve' and l.couleur = 'orange'),
    'rouge', (select count(*) from l where l.bloc = 'neuve' and l.couleur = 'rouge'),
    'appels', (select count(*) from mes),
    'rdv', (select count(*) from mes where statut = 'rdv' and coalesce(rdv_statut, 'prevu') <> 'annule'),
    'objectif', (select objectif_rdv_semaine from public.commando_parametres where id));
$$;
revoke all on function public.commando_ma_semaine(uuid) from public, anon;
grant execute on function public.commando_ma_semaine(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3) Passer une fiche / annuler
-- ------------------------------------------------------------
create or replace function public.commando_passer(_siret text, _raison text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_jusqua date;
begin
  if not public.commando_est_membre(v_uid) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  if coalesce(_raison, '') not in ('hors_cible', 'fermee', 'doublon', 'pas_de_numero', 'autre') then
    raise exception 'Raison inconnue : %', _raison;
  end if;
  if not public.commando_est_responsable(v_uid) and not exists (
       select 1 from public.commando_entreprises_v v
        where v.siret = _siret and v.secteur_code = any(public.commando_secteurs_visibles(v_uid))) then
    raise exception 'Fiche hors de votre secteur' using errcode = '42501';
  end if;
  v_jusqua := current_date + 7 * case when _raison in ('fermee', 'doublon') then 52
                                      else (select delai_passer_semaines from public.commando_parametres where id) end;
  insert into public.commando_passages (siret, commercial_id, raison, passe_le, jusqua, annule_le)
  values (_siret, v_uid, _raison, now(), v_jusqua, null)
  on conflict (siret) do update set
    commercial_id = excluded.commercial_id, raison = excluded.raison,
    passe_le = excluded.passe_le, jusqua = excluded.jusqua, annule_le = null;
  return jsonb_build_object('siret', _siret, 'raison', _raison, 'jusqua', v_jusqua);
end $$;
revoke all on function public.commando_passer(text, text) from public, anon;
grant execute on function public.commando_passer(text, text) to authenticated;

create or replace function public.commando_passer_annuler(_siret text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); n int;
begin
  if not public.commando_est_membre(v_uid) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  if not public.commando_est_responsable(v_uid) and not exists (
       select 1 from public.commando_entreprises_v v
        where v.siret = _siret and v.secteur_code = any(public.commando_secteurs_visibles(v_uid))) then
    raise exception 'Fiche hors de votre secteur' using errcode = '42501';
  end if;
  update public.commando_passages set annule_le = now() where siret = _siret and annule_le is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.commando_passer_annuler(text) from public, anon;
grant execute on function public.commando_passer_annuler(text) to authenticated;

-- ------------------------------------------------------------
-- 4) Stock de fiches neuves par commercial (console, avant publication)
--    Couleurs calculées à la volée avec les règles des sujets retenus.
-- ------------------------------------------------------------
create or replace function public.commando_stock_semaine(_semaine_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_res jsonb;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  with t as (
    select id, regles from public.commando_thematiques where semaine_id = _semaine_id and statut = 'retenue'
  ),
  v as (
    select e.siret, e.secteur_code, e.naf_code, e.tranche_effectif, e.anciennete
      from public.commando_entreprises_v e
     where e.eligible
       and not exists (select 1 from public.commando_appels a where a.siret = e.siret)
       and not exists (select 1 from public.commando_passages pa
                        where pa.siret = e.siret and pa.annule_le is null and pa.jusqua > current_date)
  ),
  c as (
    select v.siret, v.secteur_code,
           min(case public.commando_couleur(t.regles, v.naf_code, v.tranche_effectif, v.anciennete)->>'couleur'
                 when 'vert' then 1 when 'orange' then 2 else 9 end) as r
      from v cross join t group by v.siret, v.secteur_code
  ),
  par as (
    select s.code, s.nom, s.commercial_id,
           count(c.siret) filter (where c.r = 1) as vert,
           count(c.siret) filter (where c.r = 2) as orange,
           count(c.siret) as neuves_total
      from public.commando_secteurs s
      left join c on c.secteur_code = s.code
     group by s.code, s.nom, s.commercial_id
  )
  select jsonb_build_object(
    'plancher', (select plancher_fiches_neuves from public.commando_parametres where id),
    'retenues', (select count(*) from t),
    'secteurs', coalesce((select jsonb_agg(jsonb_build_object(
        'code', par.code, 'nom', par.nom, 'commercial_id', par.commercial_id,
        'vert', par.vert, 'orange', par.orange, 'neuves', par.vert + par.orange,
        'stock_total', par.neuves_total,
        'complement', greatest(0, (select plancher_fiches_neuves from public.commando_parametres where id) - (par.vert + par.orange)))
        order by par.code) from par), '[]'::jsonb))
  into v_res;
  return v_res;
end $$;
revoke all on function public.commando_stock_semaine(uuid) from public, anon;
grant execute on function public.commando_stock_semaine(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5) Verrou : une semaine publiée qui a déjà des appels ne change plus
--    de sujets retenus (ses listes et ses statistiques en dépendent).
-- ------------------------------------------------------------
create or replace function public.commando_thematiques_verrou()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.statut is distinct from old.statut and 'retenue' in (old.statut, new.statut)
     and exists (select 1 from public.commando_semaines s where s.id = new.semaine_id and s.statut = 'publiee')
     and exists (select 1 from public.commando_appels a where a.semaine_id = new.semaine_id) then
    raise exception 'Cette semaine est publiée et déjà appelée : ses sujets retenus ne peuvent plus changer.'
      using errcode = '42501';
  end if;
  return new;
end $$;
create or replace trigger trg_commando_thematiques_verrou
  before update of statut on public.commando_thematiques
  for each row execute function public.commando_thematiques_verrou();

-- ------------------------------------------------------------
-- 6) Ciblages manquants d'une semaine publiée (entreprises ajoutées à
--    la base après la publication, ex. nouvelle tranche d'effectif).
--    N'altère aucune ligne existante. Réservé à service_role.
-- ------------------------------------------------------------
create or replace function public.commando_ciblages_completer(_semaine_id uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into public.commando_ciblages (thematique_id, siret, semaine_id, couleur, regle_index, raison, secteur_code)
  select t.id, v.siret, _semaine_id, c->>'couleur', (c->>'regle_index')::int, c->>'raison', v.secteur_code
    from public.commando_thematiques t
    join public.commando_semaines s on s.id = t.semaine_id and s.statut = 'publiee'
    cross join public.commando_entreprises_v v
    cross join lateral (select public.commando_couleur(t.regles, v.naf_code, v.tranche_effectif, v.anciennete) as c) x
   where t.semaine_id = _semaine_id and t.statut = 'retenue' and v.eligible
  on conflict (thematique_id, siret) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.commando_ciblages_completer(uuid) from public, anon, authenticated;
grant execute on function public.commando_ciblages_completer(uuid) to service_role;

-- ------------------------------------------------------------
-- 7) Répartition de la base pour la veille : + fiches jamais appelées
--    par code NAF et par division, + métiers mis en vert ces 3
--    dernières semaines publiées.
-- ------------------------------------------------------------
create or replace function public.commando_repartition_base()
returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (
    select e.*, exists (select 1 from public.commando_appels a where a.siret = e.siret) as appelee
      from public.commando_entreprises_v e where e.eligible
  ),
  recentes as (
    select s.id, s.semaine from public.commando_semaines s
     where s.statut = 'publiee' order by s.semaine desc limit 3
  )
  select jsonb_build_object(
    'total', (select count(*) from v),
    'jamais_appelees', (select count(*) from v where not appelee),
    'tranches', (select coalesce(jsonb_object_agg(coalesce(tranche_effectif, 'inconnue'), n), '{}'::jsonb)
                   from (select tranche_effectif, count(*) n from v group by 1) x),
    'anciennete', (select coalesce(jsonb_object_agg(coalesce(anciennete, 'inconnue'), n), '{}'::jsonb)
                     from (select anciennete, count(*) n from v group by 1) x),
    'secteurs', (select coalesce(jsonb_object_agg(coalesce(secteur_code, '?'), n), '{}'::jsonb)
                   from (select secteur_code, count(*) n from v group by 1) x),
    'naf_divisions', (select coalesce(jsonb_agg(jsonb_build_object('division', d, 'n', n, 'jamais_appelees', j) order by n desc), '[]'::jsonb)
                        from (select left(naf_code, 2) d, count(*) n, count(*) filter (where not appelee) j
                                from v where naf_code is not null group by 1) x),
    'naf_principaux', (select coalesce(jsonb_agg(jsonb_build_object('code', naf_code, 'libelle', naf_libelle, 'n', n,
                                 'jamais_appelees', j, 'tranches', tr) order by n desc), '[]'::jsonb)
                         from (select naf_code, max(naf_libelle) naf_libelle, sum(c) n, sum(cj) j,
                                      jsonb_object_agg(coalesce(tranche_effectif,'?'), c) tr
                                 from (select naf_code, naf_libelle, tranche_effectif, count(*) c,
                                              count(*) filter (where not appelee) cj
                                         from v where naf_code is not null group by 1,2,3) y
                                group by naf_code order by n desc limit 60) x),
    'naf_vert_recents', (select coalesce(jsonb_agg(jsonb_build_object(
                             'semaine', r.semaine, 'titre', t.titre,
                             'naf_vert', (select coalesce(jsonb_agg(distinct pfx), '[]'::jsonb)
                                            from jsonb_array_elements(t.regles) rg,
                                                 jsonb_array_elements_text(coalesce(rg->'si'->'naf_prefixes', '[]'::jsonb)) pfx
                                           where rg->>'couleur' = 'vert'))
                           order by r.semaine desc, t.ordre), '[]'::jsonb)
                           from recentes r join public.commando_thematiques t on t.semaine_id = r.id and t.statut = 'retenue')
  ) where public.commando_est_membre(auth.uid()) or auth.uid() is null;
$$;
revoke all on function public.commando_repartition_base() from public, anon;
grant execute on function public.commando_repartition_base() to authenticated;

-- ------------------------------------------------------------
-- 8) Fiches gagnées aux jeux : de préférence avec un numéro connu,
--    jamais une fiche passée.
-- ------------------------------------------------------------
create or replace function public.commando_jeux_attribuer(
  _commercial uuid, _semaine uuid, _type text, _n int, _appel uuid, _pronostic uuid, _creneau timestamptz)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_max int := coalesce((p->>'max_fiches_semaine')::int, 15);
  v_deja int; v_n int;
begin
  select count(*) into v_deja from public.commando_recompenses
   where commercial_id = _commercial and semaine_id = _semaine and statut = 'attribuee';
  v_n := least(coalesce(_n, 0), greatest(0, v_max - v_deja));
  if v_n <= 0 then return 0; end if;
  insert into public.commando_recompenses (commercial_id, semaine_id, type, siret, appel_id, pronostic_id, creneau)
  select _commercial, _semaine, _type, c.siret, _appel, _pronostic, _creneau
    from (
      select v.siret,
             coalesce(ci.rang, 3) as rang_couleur,
             (v.telephone is not null) as a_telephone,
             (jsonb_array_length(coalesce(v.dirigeants, '[]'::jsonb)) > 0) as a_dirigeant,
             case v.tranche_effectif when '21' then 0 when '12' then 1 when '11' then 2 when '03' then 3 when '02' then 4 else 5 end as rang_tranche,
             (v.anciennete = 'plus_5') as ancienne
        from public.commando_entreprises_v v
        join public.commando_secteurs s on s.code = v.secteur_code and s.commercial_id is null
        left join lateral (
          select case ci.couleur when 'vert' then 0 when 'orange' then 1 when 'rouge' then 2 else 3 end as rang
            from public.commando_ciblages ci
            join public.commando_thematiques t on t.id = ci.thematique_id and t.statut = 'retenue'
           where ci.siret = v.siret and ci.semaine_id = _semaine
           order by 1 limit 1) ci on true
       where v.eligible
         and not exists (select 1 from public.commando_recompenses r where r.siret = v.siret and r.statut = 'attribuee')
         and not exists (select 1 from public.commando_appels a where a.siret = v.siret and a.created_at > now() - interval '8 weeks')
         and not exists (select 1 from public.commando_passages pa where pa.siret = v.siret and pa.annule_le is null and pa.jusqua > current_date)
       order by rang_couleur, a_telephone desc, a_dirigeant desc, rang_tranche, ancienne desc, random()
       limit v_n
    ) c;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.commando_jeux_attribuer(uuid, uuid, text, int, uuid, uuid, timestamptz) from public, anon, authenticated;
