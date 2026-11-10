-- ============================================================
--  Feuille de route — tests des droits (RLS + gardes) et calculs
-- ------------------------------------------------------------
--  Tout se passe dans une transaction annulée (rollback final) :
--  aucune donnée n'est laissée en base. Les comptes sont retrouvés
--  par email (équipe de Poitiers) ; le « non-membre » est n'importe
--  quel profil absent de commando_membres.
--  Les données de test portent sur la semaine du 07/01/2030 pour ne
--  jamais croiser les vraies feuilles.
--
--    psql … -f supabase/tests/fdr_acces.sql
--  (s'exécute aussi tel quel depuis l'éditeur SQL de Supabase)
-- ============================================================
begin;

create or replace function pg_temp.uid(_email text) returns uuid language sql stable as $$
  select id from public.profiles where email = _email;
$$;
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
-- Identifiants mémorisés dans des réglages de transaction (lisibles
-- dans les blocs DO quel que soit le rôle courant).
select set_config('fdr.scott',  pg_temp.uid('scott.heitgen@rex-rotary.fr')::text, true),
       set_config('fdr.sarah',  pg_temp.uid('sarah.leveque@rex-rotary.fr')::text, true),
       set_config('fdr.teo',    pg_temp.uid('teo.caron@rex-rotary.fr')::text, true),
       set_config('fdr.autre',  (select p.id from public.profiles p
                                  where not exists (select 1 from public.commando_membres m where m.user_id = p.id)
                                  limit 1)::text, true);

-- Données de départ (propriétaire, hors RLS) : une feuille de Téo.
insert into public.fdr_feuilles (commercial_id, semaine) values (current_setting('fdr.teo')::uuid, '2030-01-07');
insert into public.fdr_pistes (commercial_id, compte, montant, signature_prevue, chaude)
values (current_setting('fdr.teo')::uuid, 'PISTE TEO', 5.0, 's1', true);

-- ------------------------------------------------------------
-- 1) Non-membre : ne voit rien, n'écrit rien.
-- ------------------------------------------------------------
select pg_temp.devenir(current_setting('fdr.autre')::uuid);
do $$
declare n int;
begin
  select count(*) into n from public.fdr_feuilles;          assert n = 0, 'non-membre : feuilles visibles';
  select count(*) into n from public.fdr_pistes;            assert n = 0, 'non-membre : pistes visibles';
  select count(*) into n from public.fdr_pistes_historique; assert n = 0, 'non-membre : historique visible';
  select count(*) into n from public.fdr_rdv;               assert n = 0, 'non-membre : RDV visibles';
  select count(*) into n from public.fdr_engagements;       assert n = 0, 'non-membre : engagements visibles';
  select count(*) into n from public.fdr_besoins;           assert n = 0, 'non-membre : besoins visibles';
  select count(*) into n from public.fdr_previsions_mois;   assert n = 0, 'non-membre : prévisions visibles';
  select count(*) into n from public.fdr_feuilles_resume;   assert n = 0, 'non-membre : résumés visibles';
  begin
    insert into public.fdr_feuilles (commercial_id, semaine) values (current_setting('fdr.autre')::uuid, '2030-01-07');
    assert false, 'non-membre : création de sa propre feuille acceptée';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.fdr_pistes (commercial_id, compte) values (current_setting('fdr.autre')::uuid, 'X');
    assert false, 'non-membre : création de piste acceptée';
  exception when insufficient_privilege then null; end;
  raise notice 'OK 1 : un non-membre ne voit rien et n''écrit rien';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 2) Commercial (Sarah) : sa feuille uniquement ; ni « décidé au
--    point », ni « traité », ni correction du mois initial.
-- ------------------------------------------------------------
select pg_temp.devenir(current_setting('fdr.sarah')::uuid);
do $$
declare n int; f uuid; p uuid; b uuid;
begin
  select count(*) into n from public.fdr_feuilles where semaine = '2030-01-07'; assert n = 0, 'commercial : voit la feuille d''un collègue';
  select count(*) into n from public.fdr_pistes where compte = 'PISTE TEO';     assert n = 0, 'commercial : voit la piste d''un collègue';

  insert into public.fdr_feuilles (commercial_id, semaine) values (current_setting('fdr.sarah')::uuid, '2030-01-07') returning id into f;
  insert into public.fdr_pistes (commercial_id, compte, type, gammes, montant, signature_prevue, chaude)
    values (current_setting('fdr.sarah')::uuid, 'Test SA', 'NC', '{it,copieur_mps}', 9.0, 's1', true) returning id into p;
  insert into public.fdr_pistes (commercial_id, compte, montant, signature_prevue)
    values (current_setting('fdr.sarah')::uuid, 'Test mois', 4.5, 'mois');
  insert into public.fdr_pistes (commercial_id, compte, montant, signature_prevue)
    values (current_setting('fdr.sarah')::uuid, 'Test après', 20.0, 'apres');
  insert into public.fdr_engagements (feuille_id, ordre, texte) values (f, 1, 'Engagement 1'), (f, 2, 'Engagement 2'), (f, 3, 'Engagement 3');
  insert into public.fdr_besoins (feuille_id, texte) values (f, 'Besoin test') returning id into b;
  insert into public.fdr_rdv (commercial_id, semaine, libelle, type) values (current_setting('fdr.sarah')::uuid, '2030-01-07', 'R1 test', 'NC');
  insert into public.fdr_rdv (commercial_id, date_rdv, libelle, type) values (current_setting('fdr.sarah')::uuid, '2030-01-16', 'Audit test', 'Audit');
  insert into public.fdr_rdv (commercial_id, semaine) values (current_setting('fdr.sarah')::uuid, '2030-01-21');
  insert into public.fdr_previsions_mois (commercial_id, mois, montant) values (current_setting('fdr.sarah')::uuid, '2030-01-01', 30.0);

  begin
    insert into public.fdr_engagements (feuille_id, ordre, texte) values (f, 4, 'Engagement 4');
    assert false, 'commercial : 4e engagement accepté';
  exception when check_violation then null; end;
  begin
    insert into public.fdr_pistes (commercial_id, compte) values (current_setting('fdr.teo')::uuid, 'Pour Téo');
    assert false, 'commercial : piste créée pour un collègue';
  exception when insufficient_privilege then null; end;
  begin
    update public.fdr_pistes set decide_au_point = 'décidé par Sarah' where id = p;
    assert false, 'commercial : « décidé au point » modifié';
  exception when insufficient_privilege then null; end;
  begin
    update public.fdr_besoins set traite = true where id = b;
    assert false, 'commercial : besoin marqué traité';
  exception when insufficient_privilege then null; end;
  update public.fdr_previsions_mois set montant = 99 where commercial_id = current_setting('fdr.sarah')::uuid;
  get diagnostics n = row_count; assert n = 0, 'commercial : mois initial corrigé';
  begin
    update public.fdr_feuilles set statut = 'figee' where id = f;
    assert false, 'commercial : feuille figée par le commercial';
  exception when insufficient_privilege then null; end;
  delete from public.fdr_feuilles where id = f;
  get diagnostics n = row_count; assert n = 0, 'commercial : feuille supprimée';
  update public.fdr_pistes set compte = 'piraté' where compte = 'PISTE TEO';
  get diagnostics n = row_count; assert n = 0, 'commercial : piste d''un collègue modifiée';

  -- Étape suivante et signature en 1 clic → historique + semaine de clôture
  update public.fdr_pistes set etape = 'r1' where id = p;
  update public.fdr_pistes set etape = 'r2' where id = p;
  select count(*) into n from public.fdr_pistes_historique where piste_id = p and champ = 'etape'; assert n = 2, 'historique des étapes';
  raise notice 'OK 2 : un commercial n''agit que sur sa feuille, dans ses droits';
end $$;

-- 3) Calculs (vus par Sarah) : S+1 = 9,0 ; mois ajusté = 13,5 ;
--    mois initial = 30,0 ; RDV : S+1 1 NC, S+2 1 Audit, S+3 1 sans détail.
do $$
declare r record;
begin
  select * into r from public.fdr_feuilles_resume where commercial_id = current_setting('fdr.sarah')::uuid and semaine = '2030-01-07';
  assert r.prevision_s1 = 9.0,         'calcul : prévision S+1 = ' || r.prevision_s1;
  assert r.mois_ajuste_calcule = 13.5, 'calcul : mois ajusté = ' || r.mois_ajuste_calcule;
  assert r.mois_initial = 30.0,        'calcul : mois initial = ' || coalesce(r.mois_initial::text, 'null');
  assert r.pistes_chaudes = 1,         'calcul : pistes chaudes';
  assert r.besoins_non_traites = 1,    'calcul : besoins non traités';
  assert (r.rdv->'s1'->>'NC')::int = 1,          'calcul : RDV S+1 NC';
  assert (r.rdv->'s2'->>'Audit')::int = 1,       'calcul : RDV S+2 Audit (date du 16/01 → semaine du 14/01)';
  assert (r.rdv->'s3'->>'sans_detail')::int = 1, 'calcul : RDV S+3 sans détail';
  assert (r.rdv->'s1'->>'total')::int = 1,       'calcul : total S+1';
  -- Une piste signée sort des prévisions
  update public.fdr_pistes set statut = 'signee' where compte = 'Test SA';
  select * into r from public.fdr_feuilles_resume where commercial_id = current_setting('fdr.sarah')::uuid and semaine = '2030-01-07';
  assert r.prevision_s1 = 0, 'calcul : piste signée encore comptée';
  assert (select clos_semaine = public.fdr_semaine_courante() from public.fdr_pistes where compte = 'Test SA'), 'semaine de clôture non posée';
  raise notice 'OK 3 : prévisions et compteurs de RDV';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 4) Manager (Scott) : voit tout, décide, traite, corrige, fige.
-- ------------------------------------------------------------
select pg_temp.devenir(current_setting('fdr.scott')::uuid);
do $$
declare n int;
begin
  select count(*) into n from public.fdr_feuilles where semaine = '2030-01-07'; assert n = 2, 'manager : ne voit pas toutes les feuilles';
  update public.fdr_pistes set decide_au_point = 'Relancer lundi' where compte = 'Test mois';
  get diagnostics n = row_count; assert n = 1, 'manager : « décidé au point » refusé';
  update public.fdr_besoins set traite = true where texte = 'Besoin test';
  assert (select traite_par = current_setting('fdr.scott')::uuid from public.fdr_besoins where texte = 'Besoin test'), 'manager : traité non horodaté';
  update public.fdr_previsions_mois set montant = 31.0 where commercial_id = current_setting('fdr.sarah')::uuid;
  get diagnostics n = row_count; assert n = 1, 'manager : correction du mois initial refusée';
  update public.fdr_pistes set compte = 'PISTE TEO (corrigée)' where compte = 'PISTE TEO';
  get diagnostics n = row_count; assert n = 1, 'manager : correction d''une piste refusée';
  update public.fdr_feuilles set statut = 'figee', fige_le = now()
   where commercial_id = current_setting('fdr.sarah')::uuid and semaine = '2030-01-07';
  get diagnostics n = row_count; assert n = 1, 'manager : gel refusé';
  raise notice 'OK 4 : le manager voit et édite tout';
end $$;
select pg_temp.redevenir_admin();

-- ------------------------------------------------------------
-- 5) Feuille figée : le commercial ne peut plus que renseigner
--    « tenu / non tenu » sur ses engagements.
-- ------------------------------------------------------------
select pg_temp.devenir(current_setting('fdr.sarah')::uuid);
do $$
declare n int;
begin
  begin
    update public.fdr_feuilles set visites = 'modif' where commercial_id = current_setting('fdr.sarah')::uuid and semaine = '2030-01-07';
    assert false, 'figée : feuille modifiée';
  exception when insufficient_privilege then null; end;
  begin
    update public.fdr_engagements set texte = 'modif' where texte = 'Engagement 1';
    assert false, 'figée : texte d''engagement modifié';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.fdr_engagements where texte = 'Engagement 2';
    assert false, 'figée : engagement supprimé';
  exception when insufficient_privilege then null; end;
  update public.fdr_engagements set tenu = 'non_tenu', tenu_commentaire = 'pas eu le temps' where texte = 'Engagement 1';
  get diagnostics n = row_count; assert n = 1, 'figée : « tenu / non tenu » refusé';
  raise notice 'OK 5 : feuille figée';
end $$;
select pg_temp.redevenir_admin();

rollback;
