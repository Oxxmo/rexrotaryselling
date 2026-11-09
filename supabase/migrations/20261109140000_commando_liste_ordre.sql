-- ============================================================
--  Rex Commando — ordre de « Ma liste » (les mêmes fiches ne
--  reviennent plus en tête chaque semaine)
-- ------------------------------------------------------------
--  Avant : couleur, nouvelles, ancienneté 3-5 ans, puis ordre
--  alphabétique, identique pour tous et chaque semaine ; les
--  « à rappeler » et « injoignables » revenaient mélangés aux
--  fiches jamais appelées.
--  Désormais (même signature, même colonnes) :
--    1. rappels datés arrivés à échéance depuis moins de 8 jours ;
--    2. fiches jamais appelées ;
--    3. fiches déjà appelées dont le délai est passé (relances,
--       rappels en retard de plus d'une semaine) ;
--    4. fiches bloquées (appel récent).
--  À l'intérieur : couleur, nouvelles, téléphone connu, puis une
--  rotation quotidienne propre à chaque commercial (hachage du
--  SIRET, du jour et de l'utilisateur), au lieu de l'alphabet.
-- ============================================================

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
    cross join lateral (select case
        when coalesce(bl.bloquee > current_date, false) then 4
        when d.statut = 'rappeler' and bl.bloquee >= current_date - 7 then 1
        when coalesce(nb.n, 0) = 0 then 2
        else 3 end as bloc) ob
   where v.eligible
   order by ob.bloc, ch.rang,
            (v.nouvelle_semaine is not null and v.nouvelle_semaine = sem.semaine) desc,
            (v.telephone is not null) desc,
            md5(v.siret || ':' || current_date::text || ':' || coalesce(auth.uid()::text, '')),
            v.siret;
$$;
revoke all on function public.commando_liste(uuid, uuid) from public, anon;
grant execute on function public.commando_liste(uuid, uuid) to authenticated;
