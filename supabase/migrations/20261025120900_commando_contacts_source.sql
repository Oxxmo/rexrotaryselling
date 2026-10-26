-- ============================================================
--  Rex Commando — 10/ Téléphones : source et site web
-- ------------------------------------------------------------
--  La base Sirene ne contient aucun téléphone. L'Edge Function
--  « commando-telephones » les cherche gratuitement dans OpenStreetMap
--  (requêtes Overpass par code postal, rapprochement par nom et adresse)
--  et ne remplit que les fiches sans téléphone saisi par un commercial.
--  Données © les contributeurs OpenStreetMap (ODbL) : la source est
--  conservée pour l'attribution.
-- ============================================================
alter table public.commando_contacts
  add column if not exists site_web text,
  add column if not exists source text check (source is null or source in ('manuel', 'osm')),
  add column if not exists source_detail text;
comment on column public.commando_contacts.source is 'manuel (saisi par un commercial) ou osm (trouvé dans OpenStreetMap).';
