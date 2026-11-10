-- ============================================================
--  Rex Commando — tests du pilote automatique du lundi
-- ------------------------------------------------------------
--  Transaction annulée à la fin. Base : locale avec les profils de Poitiers.
--    psql … -f supabase/tests/commando_pilote.sql
-- ============================================================
begin;

\set scott  '28f7068b-a34b-45a3-a566-96558a8bf6dd'
\set sarah  '4804912a-1c4e-4be4-8df5-9c3218293c4a'

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

update public.commando_parametres
   set fiche_rex = 'Fiche Rex de test', fiche_rex_validee_le = now(),
       pilote = '{"actif": true, "jour": 1, "heure_veille": "07:00", "cloture_vote": "13:30", "nb_choix": 3, "auto_publier": true}';
delete from public.commando_semaines where semaine = '2030-W30';

do $$
declare r jsonb; v_sem uuid; g record; s record;
begin
  -- Lundi 22 juillet 2030 (heure de Paris)
  r := public.commando_pilote_tick('2030-07-22 06:40:00 Europe/Paris');
  assert r->>'action' = 'aucune' and r->>'raison' like 'avant%', 'T1 trop tôt : ' || r::text;
  r := public.commando_pilote_tick('2030-07-23 08:00:00 Europe/Paris');
  assert r->>'raison' = 'pas le jour du commando', 'T1 mardi : ' || r::text;

  -- 7 h 05 : la veille part toute seule, en attente du cron de relance
  r := public.commando_pilote_tick('2030-07-22 07:05:00 Europe/Paris');
  assert r->>'action' = 'veille_lancee', 'T2 veille lancée : ' || r::text;
  select id into v_sem from public.commando_semaines where semaine = '2030-W30';
  select * into g from public.commando_generations where semaine_id = v_sem;
  assert g.statut = 'en_cours' and g.type = 'veille' and g.etat->>'phase' = 'recherche' and (g.etat->>'en_vol')::boolean = false
     and g.lancee_par = '28f7068b-a34b-45a3-a566-96558a8bf6dd', 'T2 génération prête pour le cron : ' || g.etat::text;

  -- 7 h 15 : veille en cours, rien d'autre
  r := public.commando_pilote_tick('2030-07-22 07:15:00 Europe/Paris');
  assert r->>'action' = 'aucune' and (select count(*) from public.commando_generations where semaine_id = v_sem) = 1, 'T3 pas de doublon : ' || r::text;

  -- Veille terminée avec 5 sujets : le vote s'ouvre jusqu'à 13 h 30
  update public.commando_generations set statut = 'terminee', terminee_le = now() where id = g.id;
  insert into public.commando_thematiques (semaine_id, titre, ordre)
    select v_sem, 'Pilote sujet ' || i, i from generate_series(1, 5) i;
  r := public.commando_pilote_tick('2030-07-22 07:25:00 Europe/Paris');
  assert r->>'action' = 'vote_ouvert', 'T4 vote ouvert : ' || r::text;
  select * into s from public.commando_semaines where id = v_sem;
  assert s.vote_fin = '2030-07-22 13:30:00 Europe/Paris'::timestamptz and s.vote_auto_publier and s.vote_auto_retenir
     and s.vote_nb_choix = 3 and s.vote_ouvert_par = '28f7068b-a34b-45a3-a566-96558a8bf6dd', 'T4 réglages du vote';
  r := public.commando_pilote_tick('2030-07-22 07:35:00 Europe/Paris');
  assert r->>'action' = 'aucune', 'T4 rien de plus : ' || r::text;
  assert (select count(*) from public.commando_pilote_journal where semaine = '2030-W30') = 2, 'T4 journal';
  raise notice 'OK T1-T4 : veille à l''heure, puis vote jusqu''à 13 h 30, sans doublon';
end $$;

-- Le responsable a déjà retenu des sujets : le pilote ne touche à rien.
do $$
declare r jsonb; v_sem uuid;
begin
  insert into public.commando_semaines (semaine) values ('2030-W31');
  select id into v_sem from public.commando_semaines where semaine = '2030-W31';
  insert into public.commando_thematiques (semaine_id, titre, ordre, statut)
    select v_sem, 'Manuel ' || i, i, case when i <= 3 then 'retenue' else 'proposee' end from generate_series(1, 5) i;
  r := public.commando_pilote_tick('2030-07-29 08:00:00 Europe/Paris');
  assert r->>'raison' = 'sujets déjà retenus à la main', 'T5 : ' || r::text;
  assert not exists (select 1 from public.commando_generations where semaine_id = v_sem), 'T5 pas de veille';
  -- Pilote coupé
  update public.commando_parametres set pilote = pilote || '{"actif": false}';
  r := public.commando_pilote_tick('2030-08-05 08:00:00 Europe/Paris');
  assert r->>'raison' = 'pilote désactivé', 'T5 coupé';
  -- Fiche Rex non validée : la veille est notée impossible
  update public.commando_parametres set pilote = pilote || '{"actif": true}', fiche_rex_validee_le = null;
  r := public.commando_pilote_tick('2030-08-05 08:00:00 Europe/Paris');
  assert r->>'action' = 'veille_impossible', 'T5 fiche non validée : ' || r::text;
  raise notice 'OK T5 : le pilote laisse la main au responsable';
end $$;

-- Console et points
select pg_temp.devenir(:'scott');
do $$
begin
  assert jsonb_array_length(public.commando_pilote_etat()->'journal') >= 3, 'T6 journal lisible par le responsable';
end $$;
select pg_temp.redevenir_admin();
select pg_temp.devenir(:'sarah');
do $$
declare r jsonb;
begin
  assert public.commando_pilote_etat() is null, 'T6 rien pour un commercial';
  r := public.commando_mes_points((select id from public.commando_semaines where semaine = '2030-W30'));
  assert r ? 'total' and r ? 'semaine', 'T6 points : ' || r::text;
  raise notice 'OK T6 : état du pilote (responsable) et points à la demande';
end $$;
select pg_temp.redevenir_admin();

rollback;
