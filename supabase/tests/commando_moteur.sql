-- ============================================================
--  Rex Commando — tests du moteur de couleurs et de la publication
-- ------------------------------------------------------------
--  Transaction annulée à la fin. Base : branche Supabase ou local
--  avec les profils de Poitiers.  psql … -f supabase/tests/commando_moteur.sql
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

-- ------------------------------------------------------------
-- 1) Moteur : cas unitaires (règles de thematiques_exemple.json)
-- ------------------------------------------------------------
do $$
declare
  regles jsonb := '[
    {"couleur":"rouge","si":{"tranches":["21"]},"raison":"grande"},
    {"couleur":"orange","si":{"naf_prefixes":["62","63"]},"raison":"numérique"},
    {"couleur":"vert","si":{"tranches":["02","03"]},"raison":"petite"},
    {"couleur":"vert","si":{"tranches":["11"],"naf_prefixes":["41","42","43","45"]},"raison":"artisan 10-19"},
    {"couleur":"orange","si":{"tranches":["11","12"]},"raison":"intermédiaire"}]'::jsonb;
  r jsonb;
begin
  r := public.commando_couleur(regles, '43.22A', '03', 'plus_5');
  assert r->>'couleur' = 'vert' and (r->>'regle_index')::int = 2, 'E1 attendu vert règle 2 : ' || r::text;
  r := public.commando_couleur(regles, '62.01Z', '21', '3_5');
  assert r->>'couleur' = 'rouge' and (r->>'regle_index')::int = 0, 'E2 attendu rouge règle 0 : ' || r::text;
  r := public.commando_couleur(regles, '62.02A', '03', 'moins_3');
  assert r->>'couleur' = 'orange' and (r->>'regle_index')::int = 1, 'E3 : la règle orange (ordre) l''emporte sur la verte : ' || r::text;
  r := public.commando_couleur(regles, '43.22A', '11', 'plus_5');
  assert r->>'couleur' = 'vert' and (r->>'regle_index')::int = 3, 'E4 : ET entre tranche et NAF : ' || r::text;
  r := public.commando_couleur(regles, '56.10A', '12', 'plus_5');
  assert r->>'couleur' = 'orange' and (r->>'regle_index')::int = 4, 'E5 : OU dans la liste des tranches : ' || r::text;
  r := public.commando_couleur(regles, '56.10A', '01', 'plus_5');
  assert r->>'couleur' is null and r->>'regle_index' is null, 'E6 : non classée, jamais rouge par défaut : ' || r::text;
  r := public.commando_couleur(regles, '70.10Z', null, null);
  assert r->>'couleur' is null, 'E7 : tranche inconnue → non classée : ' || r::text;
  -- naf_exclus et préfixes avec point
  r := public.commando_couleur('[{"couleur":"vert","si":{"naf_prefixes":["43"],"naf_exclus":["43.22"]},"raison":"x"}]', '43.22A', '03', null);
  assert r->>'couleur' is null, 'E8 : naf_exclus doit écarter 43.22A';
  r := public.commando_couleur('[{"couleur":"vert","si":{"naf_prefixes":["43.2"]},"raison":"x"}]', '43.22A', '03', null);
  assert r->>'couleur' = 'vert', 'E9 : préfixe 43.2 doit couvrir 43.22A';
  r := public.commando_couleur('[{"couleur":"vert","si":{"anciennete":["3_5"]},"raison":"x"}]', '43.22A', '03', 'plus_5');
  assert r->>'couleur' is null, 'E10 : ancienneté hors liste';
  r := public.commando_couleur('[{"couleur":"vert","si":{},"raison":"tout"}]', null, null, null);
  assert r->>'couleur' = 'vert', 'E11 : règle sans condition = attrape-tout';
  -- déterminisme : deux appels identiques, même résultat
  assert public.commando_couleur(regles, '43.22A', '11', 'plus_5') = public.commando_couleur(regles, '43.22A', '11', 'plus_5'), 'déterminisme';
  raise notice 'OK 1 : moteur de couleurs (11 cas)';
end $$;

-- ------------------------------------------------------------
-- 2) Validation des règles
-- ------------------------------------------------------------
do $$
begin
  assert public.commando_valider_regles('[{"couleur":"vert","si":{"tranches":["02"]},"raison":"x"}]') is null, 'V1 valide';
  assert public.commando_valider_regles('[{"couleur":"bleu","si":{"tranches":["02"]},"raison":"x"}]') is not null, 'V2 couleur inconnue';
  assert public.commando_valider_regles('[{"couleur":"vert","si":{"chiffre_affaires":["x"]},"raison":"x"}]') is not null, 'V3 champ inconnu rejeté';
  assert public.commando_valider_regles('[{"couleur":"vert","si":{"tranches":["99"]},"raison":"x"}]') is not null, 'V4 tranche inconnue';
  assert public.commando_valider_regles('[{"couleur":"vert","si":{"anciennete":["vieux"]},"raison":"x"}]') is not null, 'V5 ancienneté inconnue';
  assert public.commando_valider_regles('[{"couleur":"vert","si":{"naf_prefixes":["ABC"]},"raison":"x"}]') is not null, 'V6 préfixe NAF invalide';
  assert public.commando_valider_regles('{"couleur":"vert"}') is not null, 'V7 pas une liste';
  assert public.commando_valider_regles('[{"couleur":"vert","raison":"x"}]') is not null, 'V8 bloc si manquant';
  raise notice 'OK 2 : validation des règles (8 cas)';
end $$;

-- La contrainte CHECK refuse une thématique avec un champ inconnu.
insert into public.commando_semaines (semaine) values ('2026-W44');
do $$
begin
  begin
    insert into public.commando_thematiques (semaine_id, titre, regles)
    select id, 'Mauvaise', '[{"couleur":"vert","si":{"chiffre_affaires":["x"]},"raison":"x"}]' from public.commando_semaines where semaine = '2026-W44';
    assert false, 'la contrainte CHECK aurait dû refuser la règle';
  exception when check_violation then null; end;
  raise notice 'OK 3 : contrainte CHECK sur les règles';
end $$;

-- ------------------------------------------------------------
-- 3) Import du fichier d'exemple + publication + Ma liste
-- ------------------------------------------------------------
-- Entreprises fictives (hors RLS) : 86000 = secteur 63 (Sarah), 86100 = 64 (Teo), 86300 = 65 (libre)
insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif, date_creation_ul, nouvelle_semaine) values
  ('10000000000011','100000000','E1 PLOMBERIE','86000','Poitiers','43.22A','03', current_date - 3000, null),
  ('10000000000022','100000000','E2 LOGICIELS','86000','Poitiers','62.01Z','21', current_date - 1500, null),
  ('10000000000033','100000003','E3 CONSEIL INFO','86000','Poitiers','62.02A','03', current_date - 400, null),
  ('10000000000044','100000004','E4 BATIMENT','86000','Poitiers','43.22A','11', current_date - 3000, null),
  ('10000000000055','100000005','E5 RESTAURANT','86000','Poitiers','56.10A','12', current_date - 3000, null),
  ('10000000000066','100000006','E6 CAFE','86000','Poitiers','56.10A','01', current_date - 3000, null),
  ('10000000000077','100000007','E7 HOLDING','86000','Poitiers','70.10Z',null, current_date - 3000, null),
  ('10000000000088','100000008','E8 PLOMBERIE JEUNE','86000','Poitiers','43.22A','03', current_date - 1500, '2026-W44'),
  ('10000000000099','100000009','E9 CHATELLERAULT','86100','Châtellerault','43.22A','03', current_date - 3000, null),
  ('10000000000100','100000010','E10 CLIENT','86000','Poitiers','43.22A','03', current_date - 3000, null),
  ('10000000000111','100000011','E11 CHAUVIGNY','86300','Chauvigny','43.22A','03', current_date - 3000, null);
update public.commando_entreprises set est_client = true where siret = '10000000000100';
delete from public.commando_semaines where semaine = '2026-W44';

select pg_temp.devenir(:'scott');
do $$
declare v_sem uuid; v_th uuid; r jsonb; n int;
begin
  v_sem := public.commando_importer_thematiques('{
  "_commentaire": "Fichier de test au format de sortie de la veille IA. Une vraie génération contient 5 propositions. Contenu à valider par Scott avant tout usage réel.",
  "semaine": "2026-W44",
  "genere_le": "2026-10-26T07:30:00+01:00",
  "thematiques": [
    {
      "id": "facturation-electronique",
      "titre": "Facturation électronique : se préparer à l''émission de septembre 2027",
      "offre_rex": "GED / dématérialisation",
      "pourquoi_maintenant": "La réception des factures électroniques est obligatoire pour toutes les entreprises assujetties à la TVA depuis le 1er septembre 2026. L''émission le devient au 1er septembre 2027 pour les PME, TPE et micro-entreprises.",
      "sources": [
        {
          "url": "https://www.previssima.fr/actualite/facturation-electronique-ce-qui-change-pour-les-entreprises-des-le-1er-septembre-2026.html",
          "titre": "Facturation électronique : ce qui change pour les entreprises dès le 1er septembre 2026",
          "date": "2026-09-01"
        }
      ],
      "concurrence": {
        "constat": "Exemple de test : à remplacer par la veille concurrentielle réelle.",
        "angle_rex": "Exemple de test : à remplacer par l''angle différenciant proposé par la veille.",
        "sources": []
      },
      "regles": [
        {
          "couleur": "rouge",
          "si": { "tranches": ["21"] },
          "raison": "Structure plus grande, souvent dotée d''un service comptable interne"
        },
        {
          "couleur": "orange",
          "si": { "naf_prefixes": ["62", "63"] },
          "raison": "Activité numérique, souvent déjà outillée"
        },
        {
          "couleur": "vert",
          "si": { "tranches": ["02", "03"] },
          "raison": "Petite structure, peu de temps à consacrer à l''administratif"
        },
        {
          "couleur": "vert",
          "si": { "tranches": ["11"], "naf_prefixes": ["41", "42", "43", "45"] },
          "raison": "Activité artisanale et opérationnelle de 10 à 19 salariés"
        },
        {
          "couleur": "orange",
          "si": { "tranches": ["11", "12"] },
          "raison": "Structure intermédiaire, niveau de préparation variable"
        }
      ],
      "trames": {
        "vert": {
          "accroche": "Bonjour, {commercial} de Rex-Rotary à Poitiers. Depuis le 1er septembre, {raison_sociale} doit pouvoir recevoir des factures électroniques, et l''émission deviendra obligatoire en septembre 2027.",
          "questions_decouverte": [
            "Aujourd''hui, comment recevez-vous et classez-vous vos factures fournisseurs ?",
            "Qui s''en occupe chez vous, et combien de temps cela prend-il par mois ?",
            "Votre expert-comptable vous a-t-il déjà parlé de la plateforme que vous utiliserez ?"
          ],
          "argument": "Nous aidons les structures de votre taille à mettre de l''ordre dans ce circuit, sans changer leurs habitudes du jour au lendemain.",
          "conclusion": "Je vous propose 30 minutes pour faire le point : plutôt mardi matin ou jeudi après-midi ?"
        },
        "orange": {
          "accroche": "Bonjour, {commercial} de Rex-Rotary à Poitiers. Pour une structure de {tranche} salariés comme {raison_sociale}, la question est surtout de savoir si votre circuit de factures fournisseurs est prêt.",
          "questions_decouverte": [
            "Vos factures fournisseurs arrivent-elles déjà au format électronique ?",
            "Où sont-elles archivées aujourd''hui ?"
          ],
          "argument": "Nous vérifions avec vous ce qui est en place et ce qui manque avant l''échéance de 2027.",
          "conclusion": "Je vous propose 30 minutes pour en parler : plutôt mardi matin ou jeudi après-midi ?"
        },
        "rouge": {
          "accroche": "Bonjour, {commercial} de Rex-Rotary à Poitiers. Vous êtes sans doute déjà organisés pour la facturation électronique.",
          "questions_decouverte": [
            "La réception et l''archivage de vos factures sont-ils entièrement en place ?"
          ],
          "argument": "Un regard extérieur permet souvent de repérer ce qui peut encore être simplifié.",
          "conclusion": "Je vous propose 30 minutes pour le vérifier ensemble : plutôt mardi matin ou jeudi après-midi ?"
        }
      },
      "objections": [
        {
          "objection": "C''est mon expert-comptable qui gère ça.",
          "reponse": "C''est très bien. Notre rôle est complémentaire : nous regardons comment les factures circulent chez vous avant d''arriver chez lui."
        },
        {
          "objection": "On a jusqu''en 2027, on verra plus tard.",
          "reponse": "Pour l''émission, oui. Mais la réception est déjà obligatoire depuis septembre : c''est le bon moment pour vérifier que tout fonctionne."
        }
      ],
      "hypotheses": [
        "Les petites structures artisanales seraient moins préparées que les autres : à confirmer par les taux de RDV."
      ]
    }
  ]
}
'::jsonb);
  select id into v_th from public.commando_thematiques where semaine_id = v_sem and cle = 'facturation-electronique';
  assert v_th is not null, 'thématique importée';
  -- critère 3 : le fichier d'exemple passe la validation
  assert (select statut from public.commando_semaines where id = v_sem) = 'brouillon', 'semaine en brouillon';

  -- Aperçu des compteurs avant publication (entreprises éligibles : E1..E9, E11 ; E10 client exclue)
  r := public.commando_apercu_compteurs(v_th);
  assert (r->'total'->>'total')::int = 10, 'aperçu total 10 : ' || r::text;
  assert (r->'total'->>'vert')::int = 5, 'aperçu vert 5 (E1,E4,E8,E9,E11) : ' || r::text;
  assert (r->'total'->>'orange')::int = 2, 'aperçu orange 2 (E3,E5) : ' || r::text;
  assert (r->'total'->>'rouge')::int = 1, 'aperçu rouge 1 (E2) : ' || r::text;
  assert (r->'total'->>'non_classee')::int = 2, 'aperçu non classées 2 (E6,E7) : ' || r::text;
  assert (r->'par_secteur'->'63'->>'total')::int = 8, 'aperçu secteur 63 : ' || r::text;

  -- Publication impossible sans 3 thématiques retenues
  update public.commando_thematiques set statut = 'retenue' where id = v_th;
  begin
    perform public.commando_publier(v_sem);
    assert false, 'publication avec 1 seule thématique acceptée';
  exception when others then
    assert sqlerrm like '%exactement 3%', 'message attendu : ' || sqlerrm;
  end;
  -- Deux thématiques manuelles : T2 (vert pour 62.*, sinon rien) et T3 (orange pour tout 3_5, rouge sinon)
  insert into public.commando_thematiques (semaine_id, titre, origine, statut, ordre, regles) values
    (v_sem, 'T2 numérique', 'manuelle', 'retenue', 2, '[{"couleur":"vert","si":{"naf_prefixes":["62"]},"raison":"numérique = vert"}]'),
    (v_sem, 'T3 ancienneté', 'manuelle', 'retenue', 3, '[{"couleur":"orange","si":{"anciennete":["3_5"]},"raison":"3 à 5 ans"},{"couleur":"rouge","si":{},"raison":"le reste"}]');
  r := public.commando_publier(v_sem);
  assert (r->>'entreprises')::int = 10, 'publication : 10 entreprises : ' || r::text;
  select count(*) into n from public.commando_ciblages where semaine_id = v_sem;
  assert n = 30, 'critère 4 : 10 entreprises × 3 thématiques = 30 ciblages, trouvé ' || n;
  -- chaque entreprise a exactement une couleur ou non classée par thématique
  select count(*) into n from (select siret, thematique_id, count(*) from public.commando_ciblages where semaine_id = v_sem group by 1,2 having count(*) <> 1) x;
  assert n = 0, 'unicité (siret, thématique)';
  assert (select couleur from public.commando_ciblages where semaine_id = v_sem and thematique_id = v_th and siret = '10000000000066') is null, 'E6 non classée figée';
  assert (select regle_index from public.commando_ciblages where semaine_id = v_sem and thematique_id = v_th and siret = '10000000000044') = 3, 'E4 règle 3 figée';
  raise notice 'OK 4 : import du fichier d''exemple, aperçu, publication (30 ciblages)';
end $$;
select pg_temp.redevenir_admin();

-- Ma liste de Sarah (secteur 63 = 86000) : chaque entreprise une seule fois, meilleure couleur
select pg_temp.devenir(:'sarah');
do $$
declare v_sem uuid; n int; r record; prev_rang int := 0; rang int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  select count(*) into n from public.commando_liste(v_sem);
  assert n = 8, 'Sarah voit 8 entreprises de 86000 (E1..E8 ; E10 cliente exclue) : ' || n;
  select count(*) into n from (select siret from public.commando_liste(v_sem) group by siret having count(*) > 1) x;
  assert n = 0, 'critère 5 : aucune entreprise en double';
  -- E2 : rouge en T1, vert en T2 → affichée verte sous T2
  select * into r from public.commando_liste(v_sem) where siret = '10000000000022';
  assert r.couleur = 'vert' and r.thematique_titre = 'T2 numérique', 'E2 sous sa meilleure couleur : ' || r.couleur || ' / ' || r.thematique_titre;
  -- E6 : non classée T1, non classée T2, rouge T3 → rouge
  select * into r from public.commando_liste(v_sem) where siret = '10000000000066';
  assert r.couleur = 'rouge', 'E6 rouge via T3';
  -- Tri : vert → orange → rouge, et les nouvelles d'abord à couleur égale
  for r in select * from public.commando_liste(v_sem) loop
    rang := case r.couleur when 'vert' then 1 when 'orange' then 2 when 'rouge' then 3 else 4 end;
    assert rang >= prev_rang, 'tri par couleur';
    prev_rang := rang;
  end loop;
  select siret into r from public.commando_liste(v_sem) limit 1;
  assert r.siret = '10000000000088', 'la nouvelle E8 est en tête des vertes';
  -- Vue par thématique T1 : E6 non classée
  select count(*) into n from public.commando_liste(v_sem, (select id from public.commando_thematiques where cle = 'facturation-electronique'));
  assert n = 8, 'vue thématique T1 : 8 lignes';
  -- Secteur libre (86300) invisible pour Sarah, 86100 aussi
  assert not exists (select 1 from public.commando_liste(v_sem) where siret in ('10000000000099','10000000000111')), 'Sarah ne voit ni l''Est ni le secteur libre';
  raise notice 'OK 5 : Ma liste (unicité, meilleure couleur, tri, périmètre)';
end $$;

-- Un appel « refus » bloque l'entreprise 8 semaines : elle passe en bas, signalée
do $$
declare v_sem uuid; r record;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  insert into public.commando_appels (siret, semaine_id, commercial_id, statut, couleur_au_moment)
    values ('10000000000088', v_sem, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'refus', 'vert');
  select * into r from public.commando_liste(v_sem) where siret = '10000000000088';
  assert r.deja_appelee and r.bloquee_jusqua = current_date + 56, 'E8 bloquée 8 semaines après refus';
  select siret into r from public.commando_liste(v_sem) order by 1 desc limit 1; -- juste pour forcer l'évaluation
  assert (select siret from public.commando_liste(v_sem) limit 1) <> '10000000000088', 'E8 n''est plus en tête';
  assert (select (public.commando_ma_semaine(v_sem))->>'appels')::int = 1, 'compteur d''appels';
  raise notice 'OK 6 : délai de rappel et compteurs';
end $$;
select pg_temp.redevenir_admin();

-- Scott (responsable) voit le secteur libre, et lui seul
select pg_temp.devenir(:'scott');
do $$
declare v_sem uuid; n int;
begin
  select id into v_sem from public.commando_semaines where semaine = '2026-W44';
  select count(*) into n from public.commando_liste(v_sem);
  assert n = 1 and (select siret from public.commando_liste(v_sem)) = '10000000000111', 'le responsable voit le secteur libre (E11) : ' || n;
  raise notice 'OK 7 : secteur libre réservé au responsable';
end $$;
select pg_temp.redevenir_admin();

rollback;
