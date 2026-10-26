-- ============================================================
--  Rex Commando — 12/ Requête Overpass depuis la base (pg_net)
-- ------------------------------------------------------------
--  Le serveur public overpass-api.de refuse (HTTP 406, nginx) toute
--  requête dont le User-Agent porte le suffixe ajouté par le runtime des
--  Edge Functions Supabase (« SupabaseEdgeRuntime »). Les requêtes émises
--  par la base via pg_net passent. L'Edge Function commando-telephones
--  demande donc la requête à la base, attend la réponse, puis la base
--  l'importe elle-même dans commando_osm_lieux (JSON parsé en SQL : rien
--  ne transite par PostgREST). Fonctions réservées à service_role.
-- ============================================================

-- Lance la requête Overpass (toute la Vienne, lieux avec téléphone, centre
-- des objets) et renvoie l'identifiant pg_net de la requête.
create or replace function public.commando_osm_demander()
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_q   text := '[out:json][timeout:90][bbox:46.0,-0.2,47.2,1.25];(nwr["phone"];nwr["contact:phone"];);out center;';
  v_url text;
  v_id  bigint;
begin
  v_url := 'https://overpass-api.de/api/interpreter?data=' ||
           replace(replace(replace(replace(replace(replace(replace(v_q,
             '%', '%25'), '[', '%5B'), ']', '%5D'), '"', '%22'), ';', '%3B'), ' ', '%20'), ',', '%2C');
  select net.http_get(
           url := v_url,
           headers := '{"User-Agent":"RexSeller-Commando/1.0 (Rex-Rotary Poitiers; github.com/Oxxmo/rexrotaryselling)"}'::jsonb,
           timeout_milliseconds := 100000)
    into v_id;
  return v_id;
end $$;
revoke all on function public.commando_osm_demander() from public, anon, authenticated;
grant execute on function public.commando_osm_demander() to service_role;

-- État d'une requête : prête ou non, code HTTP, erreur réseau, taille.
create or replace function public.commando_osm_reponse(_id bigint)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('pret', true, 'status', r.status_code, 'erreur', r.error_msg,
                               'taille', length(r.content), 'apercu', left(r.content, 200))
       from net._http_response r where r.id = _id),
    jsonb_build_object('pret', false));
$$;
revoke all on function public.commando_osm_reponse(bigint) from public, anon, authenticated;
grant execute on function public.commando_osm_reponse(bigint) to service_role;

-- Importe la réponse Overpass dans commando_osm_lieux. Un code postal OSM
-- (addr:postcode) l'emporte ; sinon on garde celui déjà déduit par la BAN.
-- Renvoie les compteurs et l'horodatage « maj_le » posé sur les lignes.
create or replace function public.commando_osm_importer(_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_maj     timestamptz := now();
  v_status  int;
  v_content text;
  v_total   int := 0;
  v_cp      int := 0;
begin
  select status_code, content into v_status, v_content from net._http_response where id = _id;
  if v_status is distinct from 200 or v_content is null then
    raise exception 'Réponse Overpass indisponible (statut %)', v_status;
  end if;

  with e as (
    select e->>'type' as type, e->>'id' as oid, e->'tags' as t,
           coalesce((e->'center'->>'lat')::double precision, (e->>'lat')::double precision) as lat,
           coalesce((e->'center'->>'lon')::double precision, (e->>'lon')::double precision) as lon
      from jsonb_array_elements((v_content::jsonb)->'elements') e
  ), lieux as (
    select type || '/' || oid as id,
           trim(coalesce(t->>'name', t->>'brand', t->>'operator')) as nom,
           trim(coalesce(t->>'phone', t->>'contact:phone')) as telephone,
           coalesce(t->>'website', t->>'contact:website') as site_web,
           lower(t->>'addr:housenumber') as numero,
           nullif(trim(t->>'addr:postcode'), '') as code_postal,
           t->>'addr:city' as commune,
           lat, lon
      from e
     where coalesce(t->>'name', t->>'brand', t->>'operator') is not null
       and coalesce(t->>'phone', t->>'contact:phone') is not null
  ), ins as (
    insert into public.commando_osm_lieux as x (id, nom, telephone, site_web, numero, code_postal, commune, lat, lon, cp_source, maj_le)
    select id, nom, telephone, site_web, numero, code_postal, commune, lat, lon,
           case when code_postal is not null then 'osm' end, v_maj
      from lieux
    on conflict (id) do update set
      nom = excluded.nom, telephone = excluded.telephone, site_web = excluded.site_web,
      numero = excluded.numero, lat = excluded.lat, lon = excluded.lon,
      code_postal = coalesce(excluded.code_postal, case when x.cp_source = 'ban' then x.code_postal end),
      commune     = coalesce(excluded.commune, x.commune),
      cp_source   = case when excluded.code_postal is not null then 'osm' when x.cp_source = 'ban' then 'ban' end,
      maj_le      = v_maj
    returning code_postal
  )
  select count(*), count(code_postal) into v_total, v_cp from ins;

  return jsonb_build_object('lieux', v_total, 'avec_code_postal', v_cp, 'maj_le', v_maj);
end $$;
revoke all on function public.commando_osm_importer(bigint) from public, anon, authenticated;
grant execute on function public.commando_osm_importer(bigint) to service_role;

-- Applique en une seule requête les codes postaux déduits par la BAN
-- (lignes {id, code_postal, commune}) aux lieux qui n'en ont pas.
create or replace function public.commando_osm_geocode_appliquer(_lignes jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.commando_osm_lieux x
     set code_postal = l.code_postal, commune = coalesce(x.commune, l.commune), cp_source = 'ban'
    from jsonb_to_recordset(_lignes) as l(id text, code_postal text, commune text)
   where x.id = l.id and x.code_postal is null and l.code_postal ~ '^\d{5}$';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.commando_osm_geocode_appliquer(jsonb) from public, anon, authenticated;
grant execute on function public.commando_osm_geocode_appliquer(jsonb) to service_role;
