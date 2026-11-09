-- ============================================================
--  Rex Commando — tests de « Ma liste » (blocs, complément, fiches
--  passées, verrou) et des annuaires publics (RGE, FINESS, BODACC)
-- ------------------------------------------------------------
--  Transaction annulée à la fin. Base : locale avec les profils de Poitiers.
--    psql … -f supabase/tests/commando_liste.sql
-- ============================================================
begin;

\set scott  '28f7068b-a34b-45a3-a566-96558a8bf6dd'
\set sarah  '4804912a-1c4e-4be4-8df5-9c3218293c4a'
\set teo    'd07ac035-2f09-438c-a845-d017fd92462a'

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

-- Jeu de données : 86000 (secteur 63) appartient à Sarah, 86100 (64) à Teo.
update public.commando_secteurs set commercial_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a' where code = '63';
update public.commando_secteurs set commercial_id = 'd07ac035-2f09-438c-a845-d017fd92462a' where code = '64';
update public.commando_parametres set plancher_fiches_neuves = 5;
insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif, date_creation_ul) values
  ('40000000000011','400000001','A1 CABINET VERT','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('40000000000022','400000002','A2 CABINET VERT','86000','Poitiers','69.20Z','03', current_date - 3000),
  ('40000000000033','400000003','A3 NEGOCE ORANGE','86000','Poitiers','46.90Z','11', current_date - 3000),
  ('40000000000044','400000004','A4 BOULANGERIE','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000055','400000005','A5 BOULANGERIE DIRIGEANT','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000066','400000006','A6 BOULANGERIE TEL','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000077','400000007','A7 BOULANGERIE','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000088','400000008','A8 BOULANGERIE','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000099','400000009','A9 BOULANGERIE EN DIFFICULTE','86000','Poitiers','10.71C','03', current_date - 3000),
  ('40000000000101','400000010','A10 CABINET A RAPPELER','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('40000000000111','400000011','A11 CABINET INJOIGNABLE','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('40000000000121','400000012','A12 CABINET REFUS','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('40000000000131','400000013','A13 CABINET A PASSER','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('40000000000141','400000014','A14 CABINET EN LIQUIDATION','86000','Poitiers','69.20Z','11', current_date - 3000),
  ('41000000000011','410000001','T1 TEO','86100','Châtellerault','69.20Z','11', current_date - 3000);
insert into public.commando_contacts (siret, telephone, source) values ('40000000000066', '05 49 00 00 66', 'osm');
insert into public.commando_evenements (id, siren, type, libelle, date_parution, url) values
  ('B1', '400000005', 'dirigeant', 'Changement de dirigeant', current_date - 20, 'https://www.bodacc.fr/x'),
  ('B2', '400000014', 'procedure', 'Jugement d''ouverture de liquidation judiciaire', current_date - 30, null),
  ('B3', '400000004', 'dirigeant', 'Changement de dirigeant', current_date - 200, null);   -- trop ancien : pas de signal

delete from public.commando_semaines where semaine = '2030-W20';
insert into public.commando_semaines (semaine, statut) values ('2030-W20', 'brouillon');
insert into public.commando_thematiques (semaine_id, titre, ordre, statut, regles, trames)
select s.id, x.titre, x.ordre, 'retenue', x.regles::jsonb, '{"vert":{"accroche":"Bonjour"}}'::jsonb
  from public.commando_semaines s,
       (values ('L sujet cabinets', 1, '[{"couleur":"vert","si":{"naf_prefixes":["69"]},"raison":"cabinets"},{"couleur":"orange","si":{"naf_prefixes":["46"]},"raison":"négoce"}]'),
               ('L sujet deux', 2, '[{"couleur":"vert","si":{"naf_prefixes":["99"]},"raison":"rien"}]'),
               ('L sujet trois', 3, '[{"couleur":"rouge","si":{"naf_prefixes":["84"]},"raison":"admin"}]')) x(titre, ordre, regles)
 where s.semaine = '2030-W20';
select public.commando_publier_interne((select id from public.commando_semaines where semaine = '2030-W20'), :'scott');
-- Historique d'appels
insert into public.commando_appels (siret, semaine_id, commercial_id, statut, date_rappel, created_at)
select x.siret, null, '4804912a-1c4e-4be4-8df5-9c3218293c4a', x.statut, x.rappel, now() - x.il_y_a
  from (values ('40000000000101', 'rappeler', current_date - 1, interval '8 days'),
               ('40000000000111', 'injoignable', null::date, interval '20 days'),
               ('40000000000121', 'refus', null::date, interval '2 days')) x(siret, statut, rappel, il_y_a);

-- ------------------------------------------------------------
-- L1) Blocs, couleurs, complément
-- ------------------------------------------------------------
select pg_temp.devenir(:'sarah');
do $$
declare v_sem uuid; r record; n int; a text[];
begin
  select id into v_sem from public.commando_semaines where semaine = '2030-W20';
  select * into r from public.commando_ma_liste(v_sem) order by ordre limit 1;
  assert r.siret = '40000000000101' and r.bloc = 'rappel', 'L1 le rappel échu est en tête : ' || r.siret || ' ' || r.bloc;
  select count(*) into n from public.commando_ma_liste(v_sem) where bloc = 'neuve' and couleur in ('vert', 'orange');
  assert n = 4, 'L1 4 fiches neuves vertes ou orange (A1, A2, A3, A13) : ' || n;
  select count(*) into n from public.commando_ma_liste(v_sem) where complement;
  assert n = 1, 'L1 complément = plancher 5 − 4 neuves = 1 : ' || n;
  select * into r from public.commando_ma_liste(v_sem) where complement;
  assert r.siret = '40000000000055' and r.signal = 'Changement de dirigeant' and r.priorite >= 4,
    'L1 le complément choisit la fiche avec un événement récent : ' || r.siret;
  assert (select signal from public.commando_ma_liste(v_sem) where siret = '40000000000044') is null, 'L1 événement trop ancien : pas de signal';
  -- Ordre : rappel, puis vertes, orange, complément, non classées
  select array_agg(bloc || ':' || case when complement then 'compl' else coalesce(couleur, 'nc') end order by ordre) into a
    from public.commando_ma_liste(v_sem) where bloc in ('rappel', 'neuve');
  assert array_position(a, 'neuve:vert') < array_position(a, 'neuve:orange')
     and array_position(a, 'neuve:orange') < array_position(a, 'neuve:compl')
     and array_position(a, 'neuve:compl') < array_position(a, 'neuve:nc'),
    'L1 ordre des couleurs : ' || a::text;
  -- Relance, attente, exclusion BODACC, périmètre
  assert (select bloc from public.commando_ma_liste(v_sem) where siret = '40000000000111') = 'relance', 'L1 injoignable ancien → relance';
  assert (select bloc || deja_appelee::text from public.commando_ma_liste(v_sem) where siret = '40000000000121') = 'attentetrue', 'L1 refus récent → attente';
  assert not exists (select 1 from public.commando_ma_liste(v_sem) where siret = '40000000000141'), 'L1 liquidation judiciaire exclue';
  assert not exists (select 1 from public.commando_ma_liste(v_sem) where siret = '41000000000011'), 'L1 Sarah ne voit pas le secteur de Teo';
  -- Compteurs de l'en-tête
  assert (public.commando_ma_semaine(v_sem)->>'a_appeler')::int = 6
     and (public.commando_ma_semaine(v_sem)->>'rappels')::int = 1
     and (public.commando_ma_semaine(v_sem)->>'complement')::int = 1,
    'L1 compteurs : ' || public.commando_ma_semaine(v_sem)::text;
  -- Ancienne signature : mêmes lignes hors fiches passées, même ordre
  assert (select siret from public.commando_liste(v_sem) limit 1) = '40000000000101', 'L1 commando_liste suit le même ordre';
  -- Vue par thématique : jamais de complément
  assert not exists (select 1 from public.commando_ma_liste(v_sem, (select id from public.commando_thematiques where titre = 'L sujet cabinets')) where complement),
    'L1 pas de complément dans la vue par thématique';
  raise notice 'OK L1 : blocs, couleurs, complément, exclusions, compteurs';
end $$;

-- ------------------------------------------------------------
-- L2) Passer une fiche, annuler
-- ------------------------------------------------------------
do $$
declare v_sem uuid; r jsonb; n int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2030-W20';
  r := public.commando_passer('40000000000131', 'hors_cible');
  assert (r->>'jusqua')::date = current_date + 56, 'L2 passée 8 semaines : ' || r::text;
  assert (select bloc from public.commando_ma_liste(v_sem) where siret = '40000000000131') = 'passee', 'L2 bloc passée';
  assert not exists (select 1 from public.commando_liste(v_sem) where siret = '40000000000131'), 'L2 absente de l''ancienne liste';
  -- Une neuve verte de moins : le complément prend une fiche de plus
  select count(*) into n from public.commando_ma_liste(v_sem) where complement;
  assert n = 2, 'L2 complément recalculé : ' || n;
  r := public.commando_passer('40000000000088', 'fermee');
  assert (r->>'jusqua')::date = current_date + 364, 'L2 fermée : 52 semaines';
  assert public.commando_passer_annuler('40000000000131'), 'L2 annulation';
  assert (select bloc from public.commando_ma_liste(v_sem) where siret = '40000000000131') = 'neuve', 'L2 de retour en neuve';
  begin
    perform public.commando_passer('41000000000011', 'autre');
    assert false, 'L2 passer une fiche de Teo devait échouer';
  exception when insufficient_privilege then null; end;
  begin
    perform public.commando_passer('40000000000044', 'n_importe_quoi');
    assert false, 'L2 raison inconnue devait échouer';
  exception when raise_exception then null; end;
  raise notice 'OK L2 : passer, annuler, périmètre';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- L3) Stock par commercial (console) et verrou des sujets retenus
-- ------------------------------------------------------------
select pg_temp.devenir(:'scott');
do $$
declare v_sem uuid; r jsonb; s jsonb;
begin
  select id into v_sem from public.commando_semaines where semaine = '2030-W20';
  r := public.commando_stock_semaine(v_sem);
  select x into s from jsonb_array_elements(r->'secteurs') x where x->>'code' = '63';
  -- A1, A2, A13 vertes ; A3 orange (A10, A11, A12 déjà appelées ; A14 exclue ; A8 passée)
  assert (s->>'vert')::int = 3 and (s->>'orange')::int = 1 and (s->>'complement')::int = 1,
    'L3 stock du secteur 63 : ' || s::text;
  -- Sans appel dans la semaine : le responsable peut encore changer les sujets
  update public.commando_thematiques set statut = 'proposee' where titre = 'L sujet trois';
  update public.commando_thematiques set statut = 'retenue' where titre = 'L sujet trois';
  raise notice 'OK L3 : stock par commercial';
end $$;
select pg_temp.redevenir_admin();
insert into public.commando_appels (siret, semaine_id, commercial_id, statut)
  select '40000000000011', id, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'injoignable' from public.commando_semaines where semaine = '2030-W20';
select pg_temp.devenir(:'scott');
do $$
begin
  begin
    update public.commando_thematiques set statut = 'ecartee' where titre = 'L sujet trois';
    assert false, 'L4 le verrou devait refuser';
  exception when insufficient_privilege then null; end;
  -- Les sujets non retenus restent modifiables
  raise notice 'OK L4 : sujets retenus verrouillés après les premiers appels';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- L5) Annuaires : numéros (RGE, FINESS) et annonces BODACC
-- ------------------------------------------------------------
do $$
declare r jsonb;
begin
  assert public.commando_tel_formater('0549440652') = '05 49 44 06 52', 'L5 format 10 chiffres';
  assert public.commando_tel_formater('+33 5 49 44 06 52') = '05 49 44 06 52', 'L5 format +33';
  assert public.commando_tel_formater('05.49.44.06.52') = '05 49 44 06 52', 'L5 format avec points';
  assert public.commando_tel_formater('  ') is null, 'L5 vide';
  -- RGE : A4 sans numéro reçoit le sien ; A6 garde son numéro OSM mais reçoit l'e-mail ; siret inconnu ignoré
  r := public.commando_sources_contacts('[
      {"siret":"40000000000044","telephone":"0549000044","email":"Contact@A4.fr"},
      {"siret":"40000000000066","telephone":"0549999999","email":"a6@a6.fr"},
      {"siret":"99999999999999","telephone":"0549000000"},
      {"siret":"40000000000077","telephone":"","email":"pas-un-mail"}]'::jsonb, 'rge', 'Annuaire RGE (ADEME)');
  assert (r->>'telephones_ajoutes')::int = 1 and (r->>'emails_ajoutes')::int = 2, 'L5 compteurs RGE : ' || r::text;
  assert (select telephone || '|' || email || '|' || source from public.commando_contacts where siret = '40000000000044') = '05 49 00 00 44|contact@a4.fr|rge', 'L5 A4';
  assert (select telephone || '|' || email || '|' || source from public.commando_contacts where siret = '40000000000066') = '05 49 00 00 66|a6@a6.fr|osm', 'L5 A6 garde son numéro';
  assert not exists (select 1 from public.commando_contacts where siret = '40000000000077'), 'L5 A7 : rien d''exploitable';
  -- Rejouer la même source ne change rien
  r := public.commando_sources_contacts('[{"siret":"40000000000044","telephone":"0549000044"}]'::jsonb, 'rge', 'x');
  assert (r->>'telephones_ajoutes')::int = 0, 'L5 idempotent';
  -- BODACC : procédure collective → exclusion ; dirigeant → signal ; entreprise hors base ignorée
  r := public.commando_sources_bodacc(('[
      {"id":"C1","familleavis_lib":"Procédures collectives","registre":["400000007","400 000 007"],"dateparution":"' || (current_date - 3) || '",
       "jugement":"{\"nature\": \"Jugement d''ouverture d''une procédure de redressement judiciaire\"}","url_complete":"https://www.bodacc.fr/c1"},
      {"id":"C2","familleavis_lib":"Modifications diverses","registre":["400000003"],"dateparution":"' || (current_date - 5) || '",
       "modificationsgenerales":"{\"descriptif\": \"modification survenue sur l''adresse du siège\"}"},
      {"id":"C3","familleavis_lib":"Modifications diverses","registre":["123456789"],"dateparution":"' || (current_date - 5) || '",
       "modificationsgenerales":"{\"descriptif\": \"modification survenue sur l''administration\"}"},
      {"id":"C4","familleavis_lib":"Modifications diverses","registre":["400000002"],"dateparution":"' || (current_date - 6) || '",
       "modificationsgenerales":"pas du json"}]')::jsonb);
  assert (r->>'evenements_base')::int = 3, 'L5 3 annonces de la base : ' || r::text;
  assert (select type || '|' || libelle from public.commando_evenements where id = 'C1') = 'procedure|Jugement d''ouverture d''une procédure de redressement judiciaire', 'L5 C1';
  assert (select type || '|' || libelle from public.commando_evenements where id = 'C2') = 'demenagement|Déménagement du siège', 'L5 C2';
  assert (select type from public.commando_evenements where id = 'C4') = 'autre', 'L5 C4 JSON invalide toléré';
  assert not exists (select 1 from public.commando_evenements where id = 'C3'), 'L5 hors base ignorée';
  assert not (select eligible from public.commando_entreprises_v where siret = '40000000000077'), 'L5 A7 en redressement : non éligible';
  raise notice 'OK L5 : numéros des annuaires et annonces BODACC';
end $$;

-- L6) Chaîne pg_net : demande, réponses, traitement
create sequence pg_temp.ids start 900001;
create or replace function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
begin
  insert into net.calls(url, headers) values (url, headers);
  return nextval('pg_temp.ids');
end $$;
do $$
declare r jsonb; t jsonb;
begin
  r := public.commando_sources_demander(30);
  assert (select count(*) from public.commando_sources_requetes where traite_le is null) = 3, 'L6 trois requêtes';
  assert exists (select 1 from net.calls where url like '%bodacc%dateparution%3E%3Ddate%27' || to_char(current_date - 30, 'YYYY-MM-DD') || '%27%'), 'L6 URL BODACC encodée';
  insert into net._http_response (id, status_code, content) values
    ((r->>'rge')::bigint, 200, '{"total":1,"results":[{"siret":"40000000000088","telephone":"05 49 00 00 88","email":"a8@a8.fr","nom_entreprise":"A8\u0000"}]}'),
    ((r->>'finess')::bigint, 200, '[{"siret":"40000000000055","telephone":"0549000055","rs":"A5"}]'),
    ((r->>'bodacc')::bigint, 500, null);
  t := public.commando_sources_traiter();
  assert jsonb_array_length(t) = 3, 'L6 trois traitements : ' || t::text;
  assert (select telephone from public.commando_contacts where siret = '40000000000088') = '05 49 00 00 88', 'L6 numéro RGE';
  assert (select source from public.commando_contacts where siret = '40000000000055') = 'finess', 'L6 numéro FINESS';
  assert (select resultat->>'erreur' from public.commando_sources_requetes where id = (r->>'bodacc')::bigint) = 'HTTP 500', 'L6 erreur HTTP gardée';
  assert jsonb_array_length(public.commando_sources_traiter()) = 0, 'L6 rien à refaire';
  raise notice 'OK L6 : chaîne pg_net';
end $$;

-- L7) Console et veille
select pg_temp.devenir(:'scott');
do $$
declare r jsonb;
begin
  r := public.commando_sources_etat();
  assert (r->'telephones'->>'rge')::int >= 2 and (r->>'exclues')::int >= 2, 'L7 état des sources : ' || r::text;
  r := public.commando_repartition_base();
  assert r ? 'jamais_appelees' and jsonb_array_length(r->'naf_vert_recents') >= 1, 'L7 répartition pour la veille';
  assert exists (select 1 from jsonb_array_elements(r->'naf_vert_recents') x where x->'naf_vert' ? '69'), 'L7 métiers verts récents';
  raise notice 'OK L7 : état des sources et données de la veille';
end $$;
select pg_temp.redevenir_admin();
select pg_temp.devenir(:'sarah');
do $$
begin
  begin
    perform public.commando_sources_etat();
    assert false, 'L8 un commercial ne lit pas l''état des sources';
  exception when insufficient_privilege then null; end;
  begin
    perform public.commando_stock_semaine((select id from public.commando_semaines where semaine = '2030-W20'));
    assert false, 'L8 un commercial ne lit pas le stock';
  exception when insufficient_privilege then null; end;
  raise notice 'OK L8 : fonctions de la console réservées au responsable';
end $$;
select pg_temp.redevenir_admin();

rollback;
