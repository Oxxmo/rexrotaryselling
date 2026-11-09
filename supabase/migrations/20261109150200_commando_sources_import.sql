-- ============================================================
--  Rex Commando — import des annuaires publics (pg_net)
-- ------------------------------------------------------------
--  Sources gratuites et officielles, interrogées depuis la base :
--    * rge    : annuaire des entreprises RGE (ADEME, data.ademe.fr) :
--               téléphone et e-mail déclarés par l'entreprise ;
--    * finess : établissements sanitaires et médico-sociaux (FINESS,
--               via public.opendatasoft.com) : téléphone ;
--    * bodacc : annonces commerciales de la Vienne (BODACC, DILA) :
--               changement de dirigeant, déménagement, rachat,
--               procédures collectives, dissolutions.
--  Les numéros ne remplacent jamais un numéro déjà connu. Seules les
--  annonces des entreprises présentes dans la base sont conservées.
--  Chaîne : commando_sources_demander() lance les requêtes (lundi
--  02 h 30 UTC, ou bouton de la console) ; commando_sources_traiter()
--  importe les réponses arrivées (toutes les 5 minutes).
-- ============================================================

-- Numéro au format « 05 49 44 06 52 » (sinon le texte tel quel).
create or replace function public.commando_tel_formater(_tel text)
returns text
language sql immutable as $$
  with d as (select regexp_replace(coalesce(_tel, ''), '[^0-9]', '', 'g') as n)
  select case
    when n ~ '^33[1-9][0-9]{8}$' then regexp_replace('0' || substr(n, 3), '(..)(..)(..)(..)(..)', '\1 \2 \3 \4 \5')
    when n ~ '^0[1-9][0-9]{8}$'  then regexp_replace(n, '(..)(..)(..)(..)(..)', '\1 \2 \3 \4 \5')
    else nullif(trim(_tel), '') end
  from d;
$$;

-- JSON lu sans erreur (null si le texte n'est pas du JSON valide).
create or replace function public.commando_jsonb_sur(_txt text)
returns jsonb
language plpgsql immutable as $$
begin
  if _txt is null or _txt = '' then return null; end if;
  return _txt::jsonb;
exception when others then
  return null;
end $$;

-- ------------------------------------------------------------
-- 1) Lancer les requêtes
-- ------------------------------------------------------------
create or replace function public.commando_sources_demander(_jours_bodacc int default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ua jsonb := '{"User-Agent":"RexSeller-Commando/1.0 (Rex-Rotary Poitiers; github.com/Oxxmo/rexrotaryselling)"}'::jsonb;
  v_jours int;
  v_depuis date;
  v_rge bigint; v_finess bigint; v_bodacc bigint;
  v_where text;
begin
  -- Premier passage : 12 mois d'annonces (procédures collectives) ; ensuite 3 semaines.
  v_jours := coalesce(_jours_bodacc,
                      case when exists (select 1 from public.commando_evenements) then 21 else 365 end);
  v_depuis := current_date - v_jours;

  v_rge := net.http_get(
    url := 'https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines'
           || '?size=10000&select=siret,telephone,email,nom_entreprise&qs=code_postal:86*',
    headers := ua, timeout_milliseconds := 60000);

  v_finess := net.http_get(
    url := 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/healthref-france-finess/exports/json'
           || '?where=dep_code%3D%2286%22&select=siret,rs,telephone,libcategetab',
    headers := ua, timeout_milliseconds := 60000);

  v_where := 'numerodepartement="86" and dateparution>=date''' || to_char(v_depuis, 'YYYY-MM-DD') || ''''
          || ' and familleavis_lib in ("Ventes et cessions","Modifications diverses","Créations","Procédures collectives")';
  v_bodacc := net.http_get(
    url := 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/exports/json'
           || '?select=id,familleavis_lib,registre,commercant,cp,dateparution,modificationsgenerales,jugement,url_complete'
           || '&where=' || replace(replace(replace(replace(replace(replace(replace(replace(v_where,
                 '%', '%25'), ' ', '%20'), '"', '%22'), '''', '%27'), '=', '%3D'), '>', '%3E'), ',', '%2C'), 'é', '%C3%A9'),
    headers := ua, timeout_milliseconds := 90000);

  insert into public.commando_sources_requetes (id, source) values
    (v_rge, 'rge'), (v_finess, 'finess'), (v_bodacc, 'bodacc')
  on conflict (id) do update set source = excluded.source, demande_le = now(), traite_le = null, resultat = null;

  return jsonb_build_object('rge', v_rge, 'finess', v_finess, 'bodacc', v_bodacc, 'bodacc_depuis', v_depuis);
end $$;
revoke all on function public.commando_sources_demander(int) from public, anon, authenticated;
grant execute on function public.commando_sources_demander(int) to service_role;

-- ------------------------------------------------------------
-- 2) Importer une réponse
-- ------------------------------------------------------------
-- Numéros (et e-mails RGE) : seulement pour les établissements de la
-- base, sans écraser un numéro ou un e-mail déjà connu.
create or replace function public.commando_sources_contacts(_lignes jsonb, _source text, _detail text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lus int; v_tel int; v_mail int;
begin
  with src as (
    select distinct on (siret) siret, tel, email from (
      select trim(x->>'siret') as siret,
             public.commando_tel_formater(x->>'telephone') as tel,
             case when lower(trim(x->>'email')) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(trim(x->>'email')) end as email
        from jsonb_array_elements(coalesce(_lignes, '[]'::jsonb)) x
    ) y
    where siret ~ '^[0-9]{14}$' and (tel is not null or email is not null)
    order by siret, tel nulls last
  ), m as (
    select s.* from src s join public.commando_entreprises e on e.siret = s.siret
  ), cnt as (
    select count(*) filter (where m.tel is not null and c.telephone is null) as t,
           count(*) filter (where m.email is not null and c.email is null) as em
      from m left join public.commando_contacts c on c.siret = m.siret
  ), ins as (
    insert into public.commando_contacts as c (siret, telephone, email, source, source_detail)
    select m.siret, m.tel, m.email, case when m.tel is not null then _source end, case when m.tel is not null then _detail end
      from m
    on conflict (siret) do update set
      telephone     = coalesce(c.telephone, excluded.telephone),
      email         = coalesce(c.email, excluded.email),
      source        = case when c.telephone is null and excluded.telephone is not null then excluded.source else c.source end,
      source_detail = case when c.telephone is null and excluded.telephone is not null then excluded.source_detail else c.source_detail end
    where (c.telephone is null and excluded.telephone is not null) or (c.email is null and excluded.email is not null)
    returning 1
  )
  select (select count(*) from src), cnt.t, cnt.em into v_lus, v_tel, v_mail from cnt;

  return jsonb_build_object('lignes', jsonb_array_length(coalesce(_lignes, '[]'::jsonb)), 'siret_distincts', v_lus,
                            'telephones_ajoutes', v_tel, 'emails_ajoutes', v_mail);
end $$;
revoke all on function public.commando_sources_contacts(jsonb, text, text) from public, anon, authenticated;

-- Annonces BODACC → commando_evenements (entreprises de la base).
create or replace function public.commando_sources_bodacc(_annonces jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int; v_par jsonb;
begin
  with a as (
    select x->>'id' as id,
           x->>'familleavis_lib' as fam,
           (select r from jsonb_array_elements_text(case when jsonb_typeof(x->'registre') = 'array' then x->'registre' else '[]'::jsonb end) r
             where replace(r, ' ', '') ~ '^[0-9]{9}$' limit 1) as siren_brut,
           nullif(x->>'dateparution', '')::date as dp,
           x->>'url_complete' as url,
           x->>'commercant' as commercant,
           x->>'cp' as cp,
           lower(coalesce(public.commando_jsonb_sur(x->>'modificationsgenerales')->>'descriptif', '')) as descr,
           public.commando_jsonb_sur(x->>'jugement')->>'nature' as jugement
      from jsonb_array_elements(coalesce(_annonces, '[]'::jsonb)) x
  ), t as (
    select a.*, replace(a.siren_brut, ' ', '') as siren,
           case
             when fam = 'Procédures collectives' then 'procedure'
             when fam = 'Ventes et cessions' then 'rachat'
             when fam = 'Créations' then 'etablissement'
             when descr ~ '(dissolution|cessation)' then 'fermeture'
             when descr ~ '(adresse du siège|transfert)' then 'demenagement'
             when descr ~ 'administration' then 'dirigeant'
             when descr ~ 'capital' then 'capital'
             when descr ~ 'activité' then 'activite'
             else 'autre' end as type
      from a
     where a.id is not null and a.dp is not null
  ), ins as (
    insert into public.commando_evenements as e (id, siren, type, libelle, date_parution, details, url)
    select t.id, t.siren, t.type,
           case t.type
             when 'procedure'     then coalesce(t.jugement, 'Procédure collective')
             when 'rachat'        then 'Rachat de fonds de commerce'
             when 'etablissement' then 'Nouvel établissement'
             when 'fermeture'     then 'Cessation d''activité ou dissolution'
             when 'demenagement'  then 'Déménagement du siège'
             when 'dirigeant'     then 'Changement de dirigeant'
             when 'capital'       then case when t.descr ~ 'augmentation' then 'Augmentation de capital' else 'Modification du capital' end
             when 'activite'      then 'Changement d''activité'
             else coalesce(nullif(left(t.descr, 120), ''), 'Annonce BODACC') end,
           t.dp,
           jsonb_strip_nulls(jsonb_build_object('famille', t.fam, 'descriptif', nullif(t.descr, ''), 'jugement', t.jugement,
                                                'commercant', t.commercant, 'cp', t.cp)),
           t.url
      from t
     where t.siren ~ '^[0-9]{9}$'
       and exists (select 1 from public.commando_entreprises en where en.siren = t.siren)
    on conflict (id) do update set
      siren = excluded.siren, type = excluded.type, libelle = excluded.libelle,
      date_parution = excluded.date_parution, details = excluded.details, url = excluded.url, importe_le = now()
    returning e.type
  )
  select count(*), coalesce(jsonb_object_agg(type, n) filter (where type is not null), '{}'::jsonb)
    into v_n, v_par
    from (select type, count(*) n from ins group by type) z;
  return jsonb_build_object('annonces', jsonb_array_length(coalesce(_annonces, '[]'::jsonb)),
                            'evenements_base', (select coalesce(sum((value)::int), 0) from jsonb_each_text(v_par)),
                            'par_type', v_par);
end $$;
revoke all on function public.commando_sources_bodacc(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Traiter les réponses arrivées (cron toutes les 5 minutes)
-- ------------------------------------------------------------
create or replace function public.commando_sources_traiter()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q record; r record; v_json jsonb; v_res jsonb; v_out jsonb := '[]'::jsonb;
begin
  for q in select * from public.commando_sources_requetes where traite_le is null order by demande_le loop
    select status_code, error_msg, content into r from net._http_response where id = q.id;
    if not found then
      -- Pas de réponse au bout d'une heure : abandon (pg_net purge ses réponses).
      if q.demande_le < now() - interval '1 hour' then
        update public.commando_sources_requetes set traite_le = now(),
               resultat = jsonb_build_object('erreur', 'pas de réponse') where id = q.id;
      end if;
      continue;
    end if;
    begin
      if r.status_code is distinct from 200 then
        v_res := jsonb_build_object('erreur', coalesce(r.error_msg, 'HTTP ' || coalesce(r.status_code::text, '?')));
      else
        v_json := replace(r.content, '\u0000', '')::jsonb;
        if q.source = 'rge' then
          v_res := public.commando_sources_contacts(v_json->'results', 'rge', 'Annuaire RGE (ADEME)');
          v_res := v_res || jsonb_build_object('total_annuaire', v_json->'total');
        elsif q.source = 'finess' then
          v_res := public.commando_sources_contacts(v_json, 'finess', 'FINESS');
        else
          v_res := public.commando_sources_bodacc(v_json);
        end if;
      end if;
    exception when others then
      v_res := jsonb_build_object('erreur', sqlerrm);
    end;
    update public.commando_sources_requetes set traite_le = now(), resultat = v_res where id = q.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('source', q.source, 'resultat', v_res));
  end loop;
  return v_out;
end $$;
revoke all on function public.commando_sources_traiter() from public, anon, authenticated;
grant execute on function public.commando_sources_traiter() to service_role;

-- ------------------------------------------------------------
-- 4) Console : lancer la mise à jour, suivre son état
-- ------------------------------------------------------------
create or replace function public.commando_sources_lancer()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if exists (select 1 from public.commando_sources_requetes
              where traite_le is null and demande_le > now() - interval '15 minutes') then
    raise exception 'Une mise à jour est déjà en cours.';
  end if;
  return public.commando_sources_demander(null);
end $$;
revoke all on function public.commando_sources_lancer() from public, anon;
grant execute on function public.commando_sources_lancer() to authenticated;

create or replace function public.commando_sources_etat()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  perform public.commando_sources_traiter();
  return jsonb_build_object(
    'requetes', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'demande_le', demande_le,
                                    'traite_le', traite_le, 'resultat', resultat) order by demande_le desc), '[]'::jsonb)
                   from (select * from public.commando_sources_requetes order by demande_le desc limit 6) x),
    'telephones', (select coalesce(jsonb_object_agg(coalesce(source, '?'), n), '{}'::jsonb)
                     from (select source, count(*) n from public.commando_contacts where telephone is not null group by 1) y),
    'evenements', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
                     from (select type, count(*) n from public.commando_evenements
                            where date_parution > current_date - 90 group by 1) z),
    'exclues', (select count(distinct e.siret) from public.commando_entreprises e
                 where e.archived_at is null and exists (
                   select 1 from public.commando_evenements ev where ev.siren = e.siren
                      and ((ev.type = 'procedure' and ev.date_parution > current_date - 365)
                        or (ev.type = 'fermeture' and ev.date_parution > current_date - 730)))));
end $$;
revoke all on function public.commando_sources_etat() from public, anon;
grant execute on function public.commando_sources_etat() to authenticated;

-- ------------------------------------------------------------
-- 5) Planification
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('commando_sources_hebdo', '30 2 * * 1', 'select public.commando_sources_demander()');
    perform cron.schedule('commando_sources_traitement', '*/5 * * * *', 'select public.commando_sources_traiter()');
  end if;
end $$;

-- ------------------------------------------------------------
-- 6) Base élargie aux 50 à 99 salariés (tranche 21).
-- ------------------------------------------------------------
update public.commando_parametres
   set tranches_incluses = array(select distinct unnest(tranches_incluses || array['21']) order by 1)
 where id and not ('21' = any(tranches_incluses));
