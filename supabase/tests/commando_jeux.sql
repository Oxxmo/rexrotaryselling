-- ============================================================
--  Rex Commando — tests des jeux (premier RDV, pronostic, ligue, Fidèle)
-- ------------------------------------------------------------
--  Transaction annulée à la fin. Base : locale avec les profils de Poitiers.
--    psql … -f supabase/tests/commando_jeux.sql
-- ============================================================
begin;

\set scott  '28f7068b-a34b-45a3-a566-96558a8bf6dd'
\set sarah  '4804912a-1c4e-4be4-8df5-9c3218293c4a'
\set teo    'd07ac035-2f09-438c-a845-d017fd92462a'
\set arthur 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea'

create or replace function pg_temp.devenir(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', _uid::text, true);
end $$;
create or replace function pg_temp.redevenir_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Jeu de données : le secteur NO (86110) est libre ; 86000 appartient à Sarah.
update public.commando_secteurs set commercial_id = null where code = 'NO';
update public.commando_secteurs set commercial_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a' where code = '63';
insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif, date_creation_ul, dirigeants) values
  ('20000000000011','200000001','L1 GRANDE','86110','Neuville','43.22A','12', current_date - 3000, '[{"nom":"A","prenom":"B"}]'),
  ('20000000000022','200000002','L2 MOYENNE','86110','Neuville','62.01Z','11', current_date - 3000, '[{"nom":"A","prenom":"B"}]'),
  ('20000000000033','200000003','L3 PETITE','86110','Neuville','56.10A','03', current_date - 3000, '[]'),
  ('20000000000044','200000004','L4 TPE','86110','Neuville','43.22A','02', current_date - 3000, '[]'),
  ('20000000000055','200000005','L5 JEUNE','86110','Neuville','62.02A','11', current_date - 400, '[{"nom":"A","prenom":"B"}]'),
  ('20000000000066','200000006','L6 AUTRE','86110','Neuville','70.10Z','03', current_date - 3000, '[]'),
  ('20000000000077','200000007','L7 ENCORE','86110','Neuville','43.99C','03', current_date - 3000, '[]'),
  ('20000000000088','200000008','L8 CLIENT','86110','Neuville','43.22A','12', current_date - 3000, '[]'),
  ('20000000000099','200000009','L9 DEJA APPELEE','86110','Neuville','43.22A','12', current_date - 3000, '[]'),
  ('30000000000011','300000001','S1 SARAH','86000','Poitiers','43.22A','03', current_date - 3000, '[]'),
  ('30000000000022','300000002','S2 SARAH','86000','Poitiers','43.22A','03', current_date - 3000, '[]'),
  ('30000000000033','300000003','S3 SARAH','86000','Poitiers','43.22A','03', current_date - 3000, '[]');
-- Réserve de fiches du secteur libre (petites, sans dirigeant : L1 et L2 restent les meilleures).
insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif, date_creation_ul, dirigeants)
  select '2100000000' || lpad(i::text, 4, '0'), '21000000' || lpad(i::text, 1, '0'), 'R' || i || ' RESERVE', '86110', 'Neuville', '43.22A', '02', current_date - 3000, '[]'::jsonb
    from generate_series(10, 24) i;
update public.commando_entreprises set est_client = true where siret = '20000000000088';
delete from public.commando_semaines where semaine in ('2026-W44');
insert into public.commando_semaines (semaine, statut) values ('2026-W44', 'brouillon');
-- L9 a été appelée récemment : jamais attribuée en récompense.
insert into public.commando_appels (siret, semaine_id, commercial_id, statut, created_at)
  select '20000000000099', id, '28f7068b-a34b-45a3-a566-96558a8bf6dd', 'refus', now() - interval '10 days' from public.commando_semaines where semaine = '2026-W44';

-- Jeux ouverts à toute heure pour la suite du test (le J0 vérifie la restriction horaire).
update public.commando_parametres set jeux = jeux || '{"heures": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]}'::jsonb;

-- ------------------------------------------------------------
-- 1) Premier RDV de l'heure et RDV bonus
-- ------------------------------------------------------------
do $$
declare v_sem uuid; r jsonb; n int; n2 int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  -- Sarah prend le premier RDV du créneau, Teo le second, Sarah un troisième.
  insert into public.commando_appels (siret, semaine_id, commercial_id, statut, date_rdv, rdv_statut, created_at) values
    ('30000000000011', v_sem, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'rdv', now() + interval '3 days', 'prevu', public.commando_creneau(now()) + interval '5 minutes'),
    ('30000000000022', v_sem, 'd07ac035-2f09-438c-a845-d017fd92462a', 'rdv', now() + interval '3 days', 'prevu', public.commando_creneau(now()) + interval '6 minutes'),
    ('30000000000033', v_sem, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'rdv', now() + interval '4 days', 'prevu', public.commando_creneau(now()) + interval '7 minutes');
  r := public.commando_jeux_resoudre();
  assert (r->>'premier_rdv')::int = 5, 'J1 premier RDV : 5 fiches attendues, ' || r::text;
  assert (r->>'rdv_bonus')::int = 2, 'J1 bonus : 2 fiches attendues (Teo + 2e RDV de Sarah), ' || r::text;
  select count(*) into n from public.commando_recompenses where commercial_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a' and statut = 'attribuee';
  assert n = 6, 'J1 Sarah : 6 fiches, ' || n;
  select count(*) into n from public.commando_recompenses where commercial_id = 'd07ac035-2f09-438c-a845-d017fd92462a' and statut = 'attribuee';
  assert n = 1, 'J1 Teo : 1 fiche, ' || n;
  -- Fiches du secteur libre uniquement, distinctes, jamais le client ni la déjà appelée.
  select count(distinct siret), count(*) into n, n2 from public.commando_recompenses where statut = 'attribuee';
  assert n = n2 and n = 7, 'J1 fiches distinctes : ' || n || '/' || n2;
  assert not exists (select 1 from public.commando_recompenses where siret in ('20000000000088', '20000000000099')), 'J1 client ou déjà appelée attribuée';
  assert not exists (select 1 from public.commando_recompenses r join public.commando_entreprises e on e.siret = r.siret where e.code_postal <> '86110'), 'J1 fiche hors secteur libre';
  -- La première fiche de Sarah est la meilleure : L1 (12 salariés, dirigeant) ou L2.
  assert exists (select 1 from public.commando_recompenses where commercial_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a' and siret in ('20000000000011', '20000000000022')), 'J1 meilleures fiches non attribuées en premier';
  -- Relancer ne double rien.
  r := public.commando_jeux_resoudre();
  assert (r->>'premier_rdv')::int = 0 and (r->>'rdv_bonus')::int = 0, 'J1 résolution non idempotente : ' || r::text;
  raise notice 'OK J1 : premier RDV de l''heure (5 fiches) et bonus (1 fiche par RDV)';
end $$;

-- ------------------------------------------------------------
-- 2) Pronostic
-- ------------------------------------------------------------
-- Le test ne dépend pas de l'heure : fenêtre de pronostic portée à 60 minutes.
update public.commando_parametres set jeux = jeux || '{"delai_pronostic_min": 60}'::jsonb;
-- Un RDV hors créneau de jeu (créneaux = 14, 15, 16 h) ne rapporte rien ; le test force ensuite toutes les heures.
do $$
declare v_sem uuid; r jsonb; n int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  update public.commando_parametres set jeux = jeux || '{"heures": [3]}'::jsonb;
  insert into public.commando_appels (siret, semaine_id, commercial_id, statut, date_rdv, rdv_statut, created_at) values
    ('20000000000055', v_sem, 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea', 'rdv', now() + interval '6 days', 'prevu', public.commando_creneau(now() - interval '5 hours') + interval '2 minutes');
  r := public.commando_jeux_resoudre();
  select count(*) into n from public.commando_recompenses where commercial_id = 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea';
  -- Le créneau (now − 5 h) ne vaut 3 h que dans un cas sur 24 : on vérifie seulement qu'un créneau non listé ne rapporte rien.
  if extract(hour from ((now() - interval '5 hours') at time zone 'Europe/Paris')) <> 3 then
    assert n = 0, 'J0 RDV hors créneau de jeu récompensé : ' || n;
  end if;
  delete from public.commando_appels where siret = '20000000000055';
  update public.commando_parametres set jeux = jeux || '{"heures": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]}'::jsonb;
  raise notice 'OK J0 : un RDV hors créneau de jeu ne rapporte pas de fiches';
end $$;
select pg_temp.devenir(:'arthur');
do $$
declare v_sem uuid; r jsonb; ok boolean := false;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  r := public.commando_pronostic(v_sem, 2);
  assert (r->>'annonce')::int = 2, 'J2 pronostic enregistré';
  r := public.commando_pronostic(v_sem, 3);   -- modifiable tant que le délai court
  assert (select annonce from public.commando_pronostics where commercial_id = 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea' and creneau = public.commando_creneau(now())) = 3, 'J2 pronostic modifié';
  begin perform public.commando_pronostic(v_sem, 9); exception when others then ok := true; end;
  assert ok, 'J2 pronostic hors bornes accepté';
end $$;
select pg_temp.devenir(:'sarah');
do $$
declare v_sem uuid; ok boolean := false;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  begin perform public.commando_pronostic(v_sem, 1); exception when others then ok := true; end;
  assert ok, 'J2 Sarah a déjà un RDV sur le créneau : pronostic accepté à tort';
end $$;
select pg_temp.redevenir_admin();
do $$
declare v_sem uuid; r jsonb; p record;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  -- Deux créneaux passés : Arthur tient son pronostic sur le premier (1 annoncé, 1 RDV), pas sur le second (3 annoncés, 1 RDV).
  insert into public.commando_pronostics (commercial_id, semaine_id, creneau, annonce) values
    ('bae7f6a3-2952-4a33-9b96-56f4b38eb8ea', v_sem, public.commando_creneau(now() - interval '3 hours'), 1),
    ('bae7f6a3-2952-4a33-9b96-56f4b38eb8ea', v_sem, public.commando_creneau(now() - interval '2 hours'), 3);
  insert into public.commando_appels (siret, semaine_id, commercial_id, statut, date_rdv, rdv_statut, created_at) values
    ('20000000000066', v_sem, 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea', 'rdv', now() + interval '5 days', 'prevu', public.commando_creneau(now() - interval '3 hours') + interval '20 minutes'),
    ('20000000000077', v_sem, 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea', 'rdv', now() + interval '5 days', 'prevu', public.commando_creneau(now() - interval '2 hours') + interval '20 minutes');
  r := public.commando_jeux_resoudre();
  assert (r->>'fiche_mystere')::int = 1, 'J2 une fiche mystère attendue : ' || r::text;
  select * into p from public.commando_pronostics where creneau = public.commando_creneau(now() - interval '3 hours');
  assert p.reussi and p.rdv_realises = 1 and p.resolu_le is not null, 'J2 pronostic 1 : réussi attendu';
  select * into p from public.commando_pronostics where creneau = public.commando_creneau(now() - interval '2 hours');
  assert not p.reussi and p.rdv_realises = 1, 'J2 pronostic 2 : échec attendu';
  assert (select count(*) from public.commando_recompenses where type = 'fiche_mystere' and commercial_id = 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea') = 1, 'J2 fiche mystère';
  -- Le pronostic du créneau courant n'est pas encore résolu.
  assert (select resolu_le from public.commando_pronostics where creneau = public.commando_creneau(now())) is null, 'J2 créneau courant résolu trop tôt';
  raise notice 'OK J2 : pronostic (délai, bornes, résolution, fiche mystère)';
end $$;

-- ------------------------------------------------------------
-- 3) Validation des RDV par le responsable, Fidèle, ligue
-- ------------------------------------------------------------
do $$
declare v_sem uuid; v_lundi date;
begin
  select id, public.commando_lundi(semaine) into v_sem, v_lundi from public.commando_semaines where semaine = '2026-W44';
  -- RDV honorés la semaine précédente : Teo 2 (dont 1 non validé), Sarah 1 validé.
  insert into public.commando_appels (siret, semaine_id, commercial_id, statut, date_rdv, rdv_statut, created_at) values
    ('20000000000011', null, 'd07ac035-2f09-438c-a845-d017fd92462a', 'rdv', (v_lundi - 3)::timestamptz + interval '10 hours', 'honore', now() - interval '12 days'),
    ('20000000000022', null, 'd07ac035-2f09-438c-a845-d017fd92462a', 'rdv', (v_lundi - 4)::timestamptz + interval '10 hours', 'honore', now() - interval '12 days'),
    ('20000000000033', null, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'rdv', (v_lundi - 5)::timestamptz + interval '10 hours', 'honore', now() - interval '12 days');
end $$;
select pg_temp.devenir(:'sarah');
do $$
declare ok boolean := false; v_id uuid;
begin
  select id into v_id from public.commando_appels where siret = '20000000000033' and statut = 'rdv';
  begin perform public.commando_rdv_valider(v_id, 'honore'); exception when others then ok := true; end;
  assert ok, 'J3 un commercial a pu valider un RDV';
end $$;
select pg_temp.devenir(:'scott');
do $$
declare v_sem uuid; r jsonb; v_id uuid; v_c jsonb;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  r := public.commando_ligue(v_sem);
  assert (r->>'a_valider')::int >= 3, 'J3 RDV à valider : ' || (r->>'a_valider');
  assert r->>'fidele' is null, 'J3 Fidèle sans validation : ' || coalesce(r->>'fidele', 'null');
  -- Scott valide les RDV de Teo (2) et de Sarah (1).
  for v_id in select id from public.commando_appels where siret in ('20000000000011', '20000000000022', '20000000000033') and statut = 'rdv' loop
    perform public.commando_rdv_valider(v_id, 'honore');
  end loop;
  assert (select count(*) from public.commando_appels where rdv_valide_le is not null and rdv_valide_par = '28f7068b-a34b-45a3-a566-96558a8bf6dd') = 3, 'J3 validations enregistrées';
  r := public.commando_ligue(v_sem);
  assert r->>'fidele' = 'd07ac035-2f09-438c-a845-d017fd92462a', 'J3 Fidèle = Teo attendu : ' || coalesce(r->>'fidele', 'null');
  select x into v_c from jsonb_array_elements(r->'classement') x where x->>'commercial_id' = '4804912a-1c4e-4be4-8df5-9c3218293c4a';
  assert (v_c->>'rdv')::int = 2 and (v_c->>'honores_valides')::int = 1, 'J3 Sarah : 2 RDV et 1 honoré validé attendus : ' || v_c::text;
  -- L'Ouvreur est Arthur : son RDV de test (créneau d'il y a 3 h) est le premier de la semaine.
  select x into v_c from jsonb_array_elements(r->'classement') x where x->>'commercial_id' = 'bae7f6a3-2952-4a33-9b96-56f4b38eb8ea';
  assert v_c->'badges' ? 'ouvreur', 'J3 Arthur : badge Ouvreur attendu : ' || v_c::text;
  assert (r->>'total_rdv')::int = 5, 'J3 total RDV semaine = 5 : ' || (r->>'total_rdv');
  assert jsonb_array_length(r->'creneaux') = 3, 'J3 3 créneaux avec RDV attendus';
  raise notice 'OK J3 : validation des RDV, Fidèle, classement et badges';
end $$;

-- ------------------------------------------------------------
-- 4) Publication : le Fidèle reçoit ses fiches (plafond respecté) ; reprise sur annulation ; état pour un commercial
-- ------------------------------------------------------------
do $$
declare v_sem uuid; n int; r jsonb;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  update public.commando_parametres set jeux = jeux || '{"fiches_fidele": 3, "max_fiches_semaine": 3}'::jsonb;
  update public.commando_semaines set statut = 'publiee' where id = v_sem;
  select count(*) into n from public.commando_recompenses where type = 'fidele' and commercial_id = 'd07ac035-2f09-438c-a845-d017fd92462a' and semaine_id = v_sem;
  assert n = 2, 'J4 Fidèle : plafond 3 − 1 bonus déjà reçu = 2 fiches attendues, ' || n;
  update public.commando_semaines set statut = 'brouillon' where id = v_sem;
  update public.commando_semaines set statut = 'publiee' where id = v_sem;
  assert (select count(*) from public.commando_recompenses where type = 'fidele') = 2, 'J4 republication : pas de nouvelles fiches Fidèle';
  -- Sarah annule son premier RDV : ses 5 fiches « premier RDV » sont reprises.
  update public.commando_appels set rdv_statut = 'annule' where siret = '30000000000011';
  r := public.commando_jeux_resoudre();
  assert (r->>'reprises')::int = 5, 'J4 reprises attendues : 5, ' || r::text;
  assert (select count(*) from public.commando_recompenses where commercial_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a' and statut = 'attribuee') = 1, 'J4 il reste 1 fiche à Sarah';
  raise notice 'OK J4 : fiches du Fidèle à la publication, plafond, reprise sur annulation';
end $$;
select pg_temp.devenir(:'teo');
do $$
declare v_sem uuid; e jsonb; n int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  e := public.commando_jeux_etat(v_sem);
  assert (e->>'nb_recompenses_semaine')::int = 3, 'J5 Teo : 3 récompenses, ' || (e->>'nb_recompenses_semaine');
  assert jsonb_array_length(e->'recompenses') = 3, 'J5 fiches récompensées renvoyées';
  assert (e->'creneau'->>'premier_rdv') is not null and (e->'creneau'->'premier_rdv'->>'commercial_id') = 'd07ac035-2f09-438c-a845-d017fd92462a', 'J5 premier RDV du créneau = Teo (celui de Sarah a été annulé)';
  assert (e->'creneau'->>'peut_pronostiquer')::boolean = false, 'J5 Teo a un RDV sur le créneau : ne peut plus pronostiquer';
  -- RLS : Teo ne voit que ses propres récompenses.
  select count(*) into n from public.commando_recompenses;
  assert n = 3, 'J5 RLS récompenses : ' || n;
  raise notice 'OK J5 : état des jeux pour un commercial, RLS';
end $$;
select pg_temp.redevenir_admin();

rollback;
