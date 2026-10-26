-- ============================================================
--  Rex Commando — 11/ Lieux OpenStreetMap (cache des téléphones)
-- ------------------------------------------------------------
--  Les serveurs publics Overpass sont souvent saturés : interroger
--  OpenStreetMap code postal par code postal est trop fragile. On ne fait
--  donc qu'UNE requête pour toute la Vienne (tous les lieux portant un
--  téléphone), conservée ici, puis le rapprochement avec nos entreprises
--  se fait sans aucun appel externe. Rafraîchie chaque semaine par pg_cron
--  (ou à la demande depuis la console). Les deux tiers des lieux n'ont pas
--  de code postal dans OSM : il est déduit de leurs coordonnées grâce à la
--  Base Adresse Nationale (api-adresse.data.gouv.fr, gratuite).
--  Données © les contributeurs OpenStreetMap (ODbL).
-- ============================================================
create table if not exists public.commando_osm_lieux (
  id           text primary key,                 -- node/123, way/456, relation/789
  nom          text not null,
  telephone    text not null,                    -- tel que publié dans OSM
  site_web     text,
  numero       text,                             -- addr:housenumber (minuscules)
  code_postal  text,                             -- addr:postcode, ou déduit des coordonnées (BAN)
  commune      text,                             -- addr:city
  lat          double precision,
  lon          double precision,
  cp_source    text,                             -- osm ou ban
  maj_le       timestamptz not null default now()
);
comment on column public.commando_osm_lieux.cp_source is 'osm (addr:postcode du lieu) ou ban (déduit des coordonnées par la Base Adresse Nationale).';
create index if not exists commando_osm_lieux_cp_idx on public.commando_osm_lieux (code_postal);
alter table public.commando_osm_lieux enable row level security;
-- Lecture par les membres du commando (la fiche affiche la provenance) ;
-- écriture réservée à l'Edge Function (clé service_role).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_osm_lieux' and policyname = 'commando_osm_lieux_lecture') then
    create policy commando_osm_lieux_lecture on public.commando_osm_lieux
      for select to authenticated using (public.commando_est_membre(auth.uid()));
  end if;
end $$;
comment on table public.commando_osm_lieux is 'Lieux OpenStreetMap de la Vienne portant un téléphone (© contributeurs OSM, ODbL). Rempli par commando-telephones.';

-- Rafraîchissement hebdomadaire : lundi 02 h UTC (avant la semaine de commando),
-- quand les serveurs Overpass sont les moins chargés.
create or replace function public.commando_cron_osm()
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url    text := (select functions_base_url from public.commando_parametres where id);
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'commando_cron_secret' limit 1);
begin
  if v_url is null or v_secret is null then
    raise warning 'commando_cron_osm : URL des fonctions ou secret Vault manquant';
    return;
  end if;
  perform net.http_post(
    url     := v_url || '/commando-telephones',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-commando-secret', v_secret),
    body    := '{"rafraichir":true,"rapprocher":true}'::jsonb,
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'commando_cron_osm : %', sqlerrm;
end $$;
revoke all on function public.commando_cron_osm() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_osm_hebdo')
      where exists (select 1 from cron.job where jobname = 'commando_osm_hebdo');
    perform cron.schedule('commando_osm_hebdo', '0 2 * * 1', 'select public.commando_cron_osm()');
  end if;
end $$;
