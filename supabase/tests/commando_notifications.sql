-- ============================================================
--  Rex Commando — tests des notifications (file, destinataires, événements)
-- ------------------------------------------------------------
--  Transaction annulée à la fin. Base : locale avec les profils de Poitiers.
--    psql … -f supabase/tests/commando_notifications.sql
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

-- Abonnements : Sarah (2 appareils), Teo, Scott
select pg_temp.devenir(:'sarah');
select public.commando_push_abonner('https://push.example/sarah-1', 'p1', 'a1', 'Android');
select public.commando_push_abonner('https://push.example/sarah-2', 'p2', 'a2', 'iPhone');
select pg_temp.redevenir_admin();
select pg_temp.devenir(:'teo');
select public.commando_push_abonner('https://push.example/teo', 'p3', 'a3', 'Android');
do $$ begin
  begin perform public.commando_push_abonner('http://pas-https', 'x', 'y', null); assert false, 'N1 URL non https refusée';
  exception when raise_exception then null; end;
  assert (select count(*) from public.commando_push) = 1, 'N1 Teo ne voit que son abonnement';
end $$;
select pg_temp.redevenir_admin();
select pg_temp.devenir(:'scott');
select public.commando_push_abonner('https://push.example/scott', 'p4', 'a4', 'Mac');
select pg_temp.redevenir_admin();

do $$
declare v_sem uuid; v_th uuid; n int; r record;
begin
  -- RDV pris par Sarah en journée : toute l'équipe sauf Sarah
  insert into public.commando_semaines (semaine) values ('2030-W40') returning id into v_sem;
  insert into public.commando_thematiques (semaine_id, titre, ordre, statut) values (v_sem, 'Sauvegarde', 1, 'retenue') returning id into v_th;
  insert into public.commando_entreprises (siret, siren, raison_sociale, code_postal, commune, naf_code, tranche_effectif)
    values ('50000000000011', '500000001', 'N1 CLIENT', '86000', 'Poitiers', '69.20Z', '11');
  insert into public.commando_appels (siret, semaine_id, thematique_id, commercial_id, statut, date_rdv, rdv_statut)
    values ('50000000000011', v_sem, v_th, '4804912a-1c4e-4be4-8df5-9c3218293c4a', 'rdv', now() + interval '2 days', 'prevu');
  -- (le déclencheur appelle commando_notif_rdv ; on la rejoue ici à heure fixe)
  assert public.commando_notif_rdv((select id from public.commando_appels where siret = '50000000000011'), '2030-10-07 22:30:00 Europe/Paris') is null, 'N2 rien la nuit';
  perform public.commando_notif_rdv((select id from public.commando_appels where siret = '50000000000011'), '2030-10-07 15:00:00 Europe/Paris');
  select * into r from public.commando_notifications where type = 'rdv' order by id desc limit 1;
  assert r.titre like '🎉 RDV pour %' and r.corps like 'Sujet : Sauvegarde.%' and r.corps not like '%N1 CLIENT%', 'N2 message RDV sans nom de client : ' || coalesce(r.corps, 'aucun');
  select count(*) into n from public.commando_notif_destinataires(r.id);
  assert n = 2, 'N2 Teo et Scott, pas Sarah : ' || n;
  assert not exists (select 1 from public.commando_notif_destinataires(r.id) d where d.user_id = '4804912a-1c4e-4be4-8df5-9c3218293c4a'), 'N2 pas l''auteur';

  -- Vote ouvert : aux commerciaux (3 appareils : 2 pour Sarah, 1 pour Teo)
  update public.commando_semaines set vote_ouvert_le = now(), vote_fin = now() + interval '30 minutes', vote_nb_choix = 3 where id = v_sem;
  select * into r from public.commando_notifications where type = 'vote_ouvert' order by id desc limit 1;
  assert r.titre = '🗳️ À vous de voter !' and r.corps like 'Choisissez vos 3 sujets préférés%', 'N3 vote ouvert : ' || coalesce(r.corps, 'aucun');
  select count(*) into n from public.commando_notif_destinataires(r.id);
  assert n = 3, 'N3 appareils des commerciaux : ' || n;
  -- Changer l'échéance ne renvoie rien
  update public.commando_semaines set vote_fin = now() + interval '31 minutes' where id = v_sem;
  assert (select count(*) from public.commando_notifications where type = 'vote_ouvert') = 1, 'N3 pas de doublon';

  -- Rappel 30 min avant : seulement ceux qui n'ont pas voté (Sarah a voté)
  insert into public.commando_vote_participations (semaine_id, commercial_id) values (v_sem, '4804912a-1c4e-4be4-8df5-9c3218293c4a');
  perform public.commando_notif_horaires(now());
  assert not exists (select 1 from public.commando_notifications where type = 'vote_rappel'), 'N4 pas de rappel juste après l''ouverture';
  update public.commando_semaines set vote_ouvert_le = now() - interval '2 hours' where id = v_sem;
  perform public.commando_notif_horaires(now());
  select * into r from public.commando_notifications where type = 'vote_rappel' order by id desc limit 1;
  assert r.id is not null, 'N4 rappel de vote';
  select count(*) into n from public.commando_notif_destinataires(r.id);
  assert n = 1 and exists (select 1 from public.commando_notif_destinataires(r.id) d where d.user_id = 'd07ac035-2f09-438c-a845-d017fd92462a'), 'N4 seulement Teo : ' || n;
  perform public.commando_notif_horaires(now());
  assert (select count(*) from public.commando_notifications where type = 'vote_rappel') = 1, 'N4 un seul rappel';

  -- Publication : toute l'équipe, avec les sujets
  update public.commando_semaines set statut = 'publiee', publiee_le = now(), vote_clos_le = now() where id = v_sem;
  select * into r from public.commando_notifications where type = 'listes_publiees' order by id desc limit 1;
  assert r.corps like 'Sauvegarde.%', 'N5 sujets dans le message : ' || coalesce(r.corps, 'aucun');
  select count(*) into n from public.commando_notif_destinataires(r.id);
  assert n = 4, 'N5 tous les appareils : ' || n;

  -- Début du commando : lundi 13 h 50 si la semaine cible est publiée
  update public.commando_semaines set semaine = '2030-W41' where id = v_sem;   -- lundi 7 octobre 2030
  perform public.commando_notif_horaires('2030-10-07 13:40:00 Europe/Paris');
  assert not exists (select 1 from public.commando_notifications where type = 'debut_commando'), 'N6 trop tôt';
  perform public.commando_notif_horaires('2030-10-07 13:52:00 Europe/Paris');
  perform public.commando_notif_horaires('2030-10-07 13:57:00 Europe/Paris');
  assert (select count(*) from public.commando_notifications where type = 'debut_commando') = 1, 'N6 un seul message à 13 h 50';

  -- Veille terminée : au responsable
  insert into public.commando_generations (semaine_id, type, statut) values (v_sem, 'veille', 'en_cours');
  update public.commando_generations set statut = 'terminee' where semaine_id = v_sem;
  select * into r from public.commando_notifications where type = 'veille' order by id desc limit 1;
  assert r.titre = '🔎 Veille terminée', 'N7 veille';
  assert (select count(*) from public.commando_notif_destinataires(r.id)) = 1, 'N7 seulement le responsable';

  -- Un appareil désactivé ne reçoit plus rien
  update public.commando_push set actif = false where endpoint = 'https://push.example/teo';
  assert not exists (select 1 from public.commando_notif_destinataires(r.id) d where d.endpoint = 'https://push.example/teo'), 'N8';
  raise notice 'OK N1-N8 : abonnements, destinataires, RDV, vote, rappel, publication, début, veille';
end $$;

-- Relance : un message resté en attente est réessayé, puis abandonné
do $$
declare v_id bigint;
begin
  insert into public.commando_notifications (type, titre, corps, cible, cree_le) values ('test', 't', 'c', '{}', now() - interval '5 minutes') returning id into v_id;
  assert public.commando_notif_relancer() >= 1, 'N9 relance';
  update public.commando_notifications set tentatives = 3, cree_le = now() - interval '15 minutes' where id = v_id;
  perform public.commando_notif_relancer();
  assert (select etat from public.commando_notifications where id = v_id) = 'echec', 'N9 abandon après 3 tentatives';
  raise notice 'OK N9 : relance et abandon';
end $$;

-- Désabonnement par l'utilisateur
select pg_temp.devenir(:'sarah');
do $$ begin
  assert public.commando_push_desabonner('https://push.example/sarah-2'), 'N10 désabonnement';
  assert not public.commando_push_desabonner('https://push.example/teo'), 'N10 pas l''appareil d''un autre';
  raise notice 'OK N10 : désabonnement';
end $$;
select pg_temp.redevenir_admin();

rollback;
