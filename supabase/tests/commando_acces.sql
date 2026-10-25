-- ============================================================
--  Rex Commando — tests d'accès (RLS)
-- ------------------------------------------------------------
--  À exécuter dans une transaction annulée (rollback final) sur une
--  base où les profils de Poitiers existent (branche ou local).
--  Chaque « assert » échoue bruyamment si une règle est violée.
--
--    psql … -f supabase/tests/commando_acces.sql
-- ============================================================
begin;

-- Jeu de données minimal (en tant que propriétaire, hors RLS).
insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif)
values ('12345678900011', '123456789', 'TEST SARL', '86000', 'Poitiers', '43.22A', '03')
on conflict (siret) do nothing;

-- Identifiants (voir profiles)
\set scott  '28f7068b-a34b-45a3-a566-96558a8bf6dd'
\set sarah  '4804912a-1c4e-4be4-8df5-9c3218293c4a'
\set teo    'd07ac035-2f09-438c-a845-d017fd92462a'
\set leger  '8271b9af-654f-47db-9abe-d617a00a9c38'

-- Helper : se faire passer pour un utilisateur authentifié.
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

-- ------------------------------------------------------------
-- 1) Un non-membre (Alexandre LEGER) ne voit aucune ligne nulle part.
-- ------------------------------------------------------------
select pg_temp.devenir(:'leger');
do $$
declare n int;
begin
  select count(*) into n from public.commando_membres;       assert n = 0, 'non-membre : membres visibles';
  select count(*) into n from public.commando_secteurs;      assert n = 0, 'non-membre : secteurs visibles';
  select count(*) into n from public.commando_codes_postaux; assert n = 0, 'non-membre : codes postaux visibles';
  select count(*) into n from public.commando_entreprises;   assert n = 0, 'non-membre : entreprises visibles';
  select count(*) into n from public.commando_parametres;    assert n = 0, 'non-membre : paramètres visibles';
  select count(*) into n from public.commando_semaines;      assert n = 0, 'non-membre : semaines visibles';
  select count(*) into n from public.commando_thematiques;   assert n = 0, 'non-membre : thématiques visibles';
  select count(*) into n from public.commando_ciblages;      assert n = 0, 'non-membre : ciblages visibles';
  select count(*) into n from public.commando_appels;        assert n = 0, 'non-membre : appels visibles';
  select count(*) into n from public.commando_imports;       assert n = 0, 'non-membre : imports visibles';
  select count(*) into n from public.commando_generations;   assert n = 0, 'non-membre : générations visibles';
  select count(*) into n from public.commando_contacts;      assert n = 0, 'non-membre : contacts visibles';
  select count(*) into n from public.commando_clients_siren; assert n = 0, 'non-membre : clients visibles';
  -- et ne peut rien écrire
  begin
    insert into public.commando_appels (siret, commercial_id, statut) values ('12345678900011', '8271b9af-654f-47db-9abe-d617a00a9c38', 'refus');
    assert false, 'non-membre : insertion d''un appel acceptée';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.commando_semaines (semaine) values ('2026-W44');
    assert false, 'non-membre : création de semaine acceptée';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 1 : un non-membre ne voit rien et n''écrit rien';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 2) Un commercial (Sarah) : lit le référentiel, écrit ses appels,
--    ne touche ni aux secteurs, ni aux paramètres, ni aux imports.
-- ------------------------------------------------------------
select pg_temp.devenir(:'sarah');
do $$
declare n int;
begin
  select count(*) into n from public.commando_secteurs;      assert n = 4,  'commercial : secteurs';
  select count(*) into n from public.commando_codes_postaux; assert n = 51, 'commercial : codes postaux';
  select count(*) into n from public.commando_entreprises;   assert n >= 1, 'commercial : entreprises';
  select count(*) into n from public.commando_parametres;    assert n = 1,  'commercial : paramètres lisibles';
  select count(*) into n from public.commando_imports;       assert n = 0,  'commercial : imports doivent être masqués';
  select count(*) into n from public.commando_generations;   assert n = 0,  'commercial : générations doivent être masquées';

  -- Ses propres appels : oui
  insert into public.commando_appels (siret, commercial_id, statut) values ('12345678900011', '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'injoignable');
  -- Un appel au nom d'un autre : non
  begin
    insert into public.commando_appels (siret, commercial_id, statut) values ('12345678900011', 'd07ac035-2f09-438c-a845-d017fd92462a', 'refus');
    assert false, 'commercial : appel au nom d''un autre accepté';
  exception when insufficient_privilege then null; end;
  -- Contact : oui (avec updated_by = soi)
  insert into public.commando_contacts (siret, telephone, updated_by) values ('12345678900011', '05 49 00 00 00', '4804912a-1c4e-4be4-8df5-9c3218293c4a');
  -- Secteur : non
  begin
    update public.commando_secteurs set commercial_id = null where code = '63';
    -- sans erreur mais zéro ligne affectée : on vérifie
    perform 1 from public.commando_secteurs where code = '63' and commercial_id is null;
    assert not found, 'commercial : réaffectation de secteur acceptée';
  exception when insufficient_privilege then null; end;
  -- Paramètres : non
  begin
    update public.commando_parametres set objectif_rdv_semaine = 99;
    perform 1 from public.commando_parametres where objectif_rdv_semaine = 99;
    assert not found, 'commercial : modification des paramètres acceptée';
  exception when insufficient_privilege then null; end;
  -- Entreprises : aucune écriture
  begin
    update public.commando_entreprises set est_client = true where siret = '12345678900011';
    perform 1 from public.commando_entreprises where siret = '12345678900011' and est_client;
    assert not found, 'commercial : modification d''entreprise acceptée';
  exception when insufficient_privilege then null; end;
  begin
    update public.commando_entreprises set raison_sociale = 'X' where siret = '12345678900011';
    assert false, 'commercial : colonne protégée modifiable';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 2 : un commercial lit, enregistre ses appels, ne paramètre rien';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 3) Le responsable (Scott) : paramètre, voit les imports, édite les appels.
-- ------------------------------------------------------------
select pg_temp.devenir(:'scott');
do $$
declare n int;
begin
  update public.commando_parametres set objectif_rdv_semaine = 6;
  select objectif_rdv_semaine into n from public.commando_parametres; assert n = 6, 'responsable : paramètres';
  update public.commando_secteurs set commercial_id = null where code = '63';
  perform 1 from public.commando_secteurs where code = '63' and commercial_id is null; assert found, 'responsable : secteurs';
  update public.commando_entreprises set est_client = true where siret = '12345678900011';
  perform 1 from public.commando_entreprises where siret = '12345678900011' and est_client; assert found, 'responsable : est_client';
  insert into public.commando_semaines (semaine) values ('2026-W44');
  insert into public.commando_thematiques (semaine_id, titre, origine) select id, 'Test', 'manuelle' from public.commando_semaines where semaine = '2026-W44';
  -- Thématique proposée d'une semaine brouillon : invisible pour un commercial (test 4)
  update public.commando_appels set note = 'vu par le responsable' where siret = '12345678900011';
  perform 1 from public.commando_appels where note = 'vu par le responsable'; assert found, 'responsable : édition d''un appel';
  raise notice 'OK 3 : le responsable paramètre et supervise';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 4) Thématiques : un commercial ne voit que les retenues publiées.
-- ------------------------------------------------------------
select pg_temp.devenir(:'teo');
do $$
declare n int;
begin
  select count(*) into n from public.commando_thematiques; assert n = 0, 'commercial : thématique brouillon visible';
end $$;
select pg_temp.redevenir_admin();
update public.commando_thematiques set statut = 'retenue';
update public.commando_semaines set statut = 'publiee';
select pg_temp.devenir(:'teo');
do $$
declare n int;
begin
  select count(*) into n from public.commando_thematiques; assert n = 1, 'commercial : thématique retenue publiée invisible';
  raise notice 'OK 4 : visibilité des thématiques';
end $$;
select pg_temp.redevenir_admin();

rollback;
