-- ============================================================
--  Feuille de route — 2/ Données de départ
-- ------------------------------------------------------------
--  Feuilles de la semaine du 09 au 13/11/2026 (point du 06/11),
--  telles que fournies par Scott. Règle : rien n'est inventé ;
--  un champ non fourni reste vide. L'étape n'est renseignée que
--  si le texte la dit faite ; un RDV à venir va dans « prochaine
--  action » (+ date si elle est donnée).
--
--  Idempotente : ne fait rien si une feuille existe déjà pour un
--  commercial cette semaine-là.
-- ============================================================
do $$
declare
  arthur uuid := (select id from public.profiles where email = 'arthur.roulon@rex-rotary.fr');
  sarah  uuid := (select id from public.profiles where email = 'sarah.leveque@rex-rotary.fr');
  teo    uuid := (select id from public.profiles where email = 'teo.caron@rex-rotary.fr');
  s1 constant date := '2026-11-09';   -- semaine de la feuille (S+1)
  s2 constant date := '2026-11-16';
  s3 constant date := '2026-11-23';
  f uuid;
begin
  -- ---------------- Arthur Roulon ----------------
  if arthur is not null and not exists (select 1 from public.fdr_feuilles where commercial_id = arthur and semaine = s1) then
    insert into public.fdr_feuilles (commercial_id, semaine, visites)
    values (arthur, s1, 'SAS Mécanique Maillet') returning id into f;

    insert into public.fdr_pistes (commercial_id, compte, type, gammes, montant, etape, prochaine_action, prochaine_action_date, signature_prevue, chaude) values
      (arthur, 'SAS Giansanti', null, '{}',    3.0, 'r1', 'Audit à caler, relance tél. S+1', null, null, false),
      (arthur, 'GYRAX',         null, '{ged}', 15.0, null, 'R1 le 24/11 à 14h', '2026-11-24', 'apres', false),
      (arthur, 'MQG',           'UP', '{}',    7.7, null, 'Signature (validé oralement le 06/11)', '2026-11-09', 's1', true);

    insert into public.fdr_previsions_mois (commercial_id, mois, montant) values (arthur, '2026-11-01', 25.0)
      on conflict (commercial_id, mois) do nothing;

    insert into public.fdr_rdv (commercial_id, semaine) select arthur, s2 from generate_series(1, 4);
    insert into public.fdr_rdv (commercial_id, semaine) values (arthur, s3);

    insert into public.fdr_engagements (feuille_id, ordre, texte) values
      (f, 1, 'Prendre au minimum 10 RDV, en privilégiant le phone'),
      (f, 2, 'Fixer 3 RDV clients « tournables » pour prendre du CA'),
      (f, 3, 'Relancer la mairie de St-Jean-de-Sauves pour Alex et chiffrer l''ENI');

    insert into public.fdr_besoins (feuille_id, texte) values
      (f, 'Récupérer le copieur Mécanique Maillet'),
      (f, 'Mail pour remplacement du serveur par une GED chez MAROT');
  end if;

  -- ---------------- Sarah Lévêque ----------------
  if sarah is not null and not exists (select 1 from public.fdr_feuilles where commercial_id = sarah and semaine = s1) then
    insert into public.fdr_feuilles (commercial_id, semaine, mois_ajuste_declare, mois_ajuste_note)
    values (sarah, s1, 65.9, 'Piscine Belle retirée') returning id into f;

    insert into public.fdr_pistes (commercial_id, compte, type, gammes, montant, etape, prochaine_action, prochaine_action_date, signature_prevue, chaude) values
      (sarah, 'Agriflor',            'NC', '{}',                9.0, null,    'BCU envoyé, réponse lundi 09/11', '2026-11-09', 's1', true),
      (sarah, 'First',               'CA', '{}',               null, null,    'Attente de réponse, contacter le gérant M. Berton', null, null, false),
      (sarah, 'Proust',              'CA', '{}',               null, null,    'Attente de réponse, contacter le gérant M. Berton', null, null, false),
      (sarah, 'Garage Langlois',     'NC', '{copieur_mps}',    null, null,    'R2 mardi 10/11', '2026-11-10', null, false),
      (sarah, 'Roulottes et Nature', 'NC', '{}',               null, 'audit', 'R2 calé S+2', null, null, false),
      (sarah, 'Maître Gomez',        'NC', '{it,copieur_mps}', 10.0, null,    'R2 lundi 09/11', '2026-11-09', null, true);

    insert into public.fdr_previsions_mois (commercial_id, mois, montant) values (sarah, '2026-11-01', 66.9)
      on conflict (commercial_id, mois) do nothing;

    insert into public.fdr_rdv (commercial_id, semaine, date_rdv, libelle, type) values
      (sarah, s1, '2026-11-09', 'Maître Gomez — R2',          'NC'),
      (sarah, s1, '2026-11-10', 'Garage Langlois — R2',       'NC'),
      (sarah, s1, null,         'Carrière Iribarren — R1',    'NC'),
      (sarah, s2, null,         'Adial — R1',                 'NC'),
      (sarah, s2, null,         'Roulottes et Nature — R2',   'NC'),
      (sarah, s3, null,         'ACF PE2C — audit GED',       'CA');

    insert into public.fdr_engagements (feuille_id, ordre, texte) values
      (f, 1, 'Relancer M. Berton (First et Proust)'),
      (f, 2, 'Relancer M. Durousseau lundi (Agriflor)'),
      (f, 3, 'Passer voir Promo Dessin pour se présenter');
  end if;

  -- ---------------- Téo Caron ----------------
  if teo is not null and not exists (select 1 from public.fdr_feuilles where commercial_id = teo and semaine = s1) then
    insert into public.fdr_feuilles (commercial_id, semaine, mois_ajuste_declare)
    values (teo, s1, 57.4) returning id into f;

    insert into public.fdr_pistes (commercial_id, compte, type, gammes, montant, etape, prochaine_action, prochaine_action_date, signature_prevue, blocage, chaude) values
      (teo, 'Batisport',          'NC',  '{}',  1.5, null, 'Pas de R2',               null,         null, 'Relecture par l''associé', true),
      (teo, 'Poitou Paysage',     'NC',  '{}', 10.0, null, 'En attente',              null,         null, null, false),
      (teo, 'Les Ages',           'UP',  '{}', 13.9, null, 'R2 avec Anaïs jeudi 12/11', '2026-11-12', null, null, true),
      (teo, 'Notaire Lencloître', 'NC',  '{}', null, null, 'R2 pour signature mardi 24/11', '2026-11-24', null, null, true),
      (teo, 'Ingrandes',          'RNV', '{}', null, null, 'R2 pour signature le 26/11',  '2026-11-26', null, null, true);

    insert into public.fdr_previsions_mois (commercial_id, mois, montant) values (teo, '2026-11-01', 15.5)
      on conflict (commercial_id, mois) do nothing;

    insert into public.fdr_rdv (commercial_id, semaine) select teo, s1 from generate_series(1, 2);
    insert into public.fdr_rdv (commercial_id, semaine) select teo, s2 from generate_series(1, 3);

    insert into public.fdr_engagements (feuille_id, ordre, texte) values
      (f, 1, 'Prendre RDV avec M. Leleu (wifi + Zyxel, ne répond ni aux mails ni aux SMS)'),
      (f, 2, 'Vendredi, RDV Mme Savary : préparer une nouvelle offre et ressortir avec un audit placé'),
      (f, 3, 'Lundi matin, bonne thématique pour prendre 6 RDV (absent 2 jours)');

    insert into public.fdr_besoins (feuille_id, texte) values (f, 'Travail d''étude Ingrandes');
  end if;
end $$;
