/*
 * Rex Seller — Structure du livret de découverte Rex-Rotary
 * Chaque question du livret imprimé est reprise ici, section par section,
 * sans en omettre une seule. Voir /root livret « Livret de découverte ».
 *
 * Types de champ supportés :
 *   text      -> saisie courte
 *   textarea  -> saisie longue
 *   number    -> nombre (unit optionnel)
 *   date      -> date
 *   rating    -> note de 1 à 10
 *   yesno     -> Oui / Non (+ précision optionnelle)
 *   checklist -> cases à cocher multiples
 *   table     -> tableau (rows = intitulés de ligne, cols = nb de colonnes)
 *   note      -> texte d'aide affiché (pas de saisie)
 */

const BOOKLET = [
  {
    id: "infos",
    title: "Informations générales",
    icon: "🏢",
    intro: "Coordonnées du rendez-vous et de l'entreprise.",
    fields: [
      { id: "date_rdv", label: "Date du rendez-vous", type: "date", key: true },
      { id: "societe", label: "Nom de la société", type: "text", key: true },
      { id: "statut", label: "Statut de l'entreprise (Asso / Public / SA / etc.)", type: "text" },
      { id: "contact", label: "Contact", type: "text" },
      { id: "fonction", label: "Fonction", type: "text" },
      { id: "date_creation", label: "Date de création de l'entreprise", type: "text" },
      { id: "nb_salaries", label: "Nombre de salariés", type: "number" },
      { id: "secteur", label: "Secteur d'activité", type: "text" },
      { id: "commercial_dedie", label: "Votre commercial dédié", type: "text" },
      { id: "technicien_dedie", label: "Votre technicien dédié", type: "text" }
    ]
  },

  {
    id: "entreprise",
    title: "Votre entreprise",
    icon: "🧭",
    fields: [
      { id: "ent_secteur", label: "Secteur d'activité", type: "textarea" },
      { id: "ent_sites", label: "Combien de sites, filiales avez-vous ? (Emplacements)", type: "textarea" },
      { id: "ent_services", label: "Combien de services / salariés avez-vous ?", type: "textarea" },
      { id: "ent_sedentaires", label: "Combien de vos employés sont-ils sédentaires ?", type: "text" },
      { id: "ent_mobiles", label: "Combien de vos employés sont mobiles ?", type: "text" },
      { id: "ent_typo_clients", label: "Quels types de clients adressez-vous ? (privé / public / typologie)", type: "textarea" },
      { id: "ent_nb_clients", label: "Combien avez-vous de clients ?", type: "text" },
      { id: "ent_projets", label: "Quels sont vos projets de développement ? (nvx sites / services / produits, etc.)", type: "textarea" },
      { id: "ent_valeur", label: "Quelle est votre valeur ajoutée ? (votre marque de fabrique)", type: "textarea" },
      { id: "ent_decision", label: "Quel est votre circuit décisionnel ? (qui signe ?)", type: "textarea" }
    ]
  },

  {
    id: "demat",
    title: "Dématérialisation",
    icon: "📄",
    fields: [
      { id: "dem_partage_interne", label: "Comment partagez-vous vos documents en interne ? (salariés / services)", type: "textarea" },
      { id: "dem_partage_externe", label: "Comment partagez-vous vos documents en externe ? (clients / fournisseurs)", type: "textarea" },
      { id: "dem_validations", label: "Quels sont vos process de validation ? (congés, commandes, factures, etc.)", type: "textarea" },
      { id: "dem_cout_facture", label: "Connaissez-vous le coût moyen du traitement d'une facture fournisseur ?", type: "textarea", hint: "Coût estimé ≈ 14 € (courrier 0,9 € · saisie 1,4 € · validation 5,4 € · paiement 2,8 € · archivage 1,5 € · gestion litiges 1,8 €)" },
      { id: "dem_nb_factures_four", label: "Nombre de factures fournisseurs traitées par mois ?", type: "text" },
      { id: "dem_nb_factures_cli", label: "Nombre de factures clients envoyées par mois ?", type: "text" },
      { id: "dem_nb_courriers", label: "Nombre de courriers reçus / envoyés ?", type: "text" },
      { id: "dem_bulletins", label: "Comment traitez-vous l'envoi des bulletins de salaires ?", type: "textarea" },
      { id: "dem_acces_distance", label: "Comment faites-vous pour accéder à vos documents en dehors de vos locaux ?", type: "textarea" },
      { id: "dem_apres_num", label: "Que faites-vous des documents après numérisation ?", type: "textarea" },
      { id: "dem_chronophage", label: "Quelles sont les tâches chronophages que vous réalisez ? (recherche, diffusion, tri, archivage, etc.)", type: "textarea" },
      { id: "dem_volume_num", label: "Quel type de document et quel volume de numérisation faites-vous quotidiennement ?", type: "textarea" },
      { id: "dem_archives_num", label: "Vos archives sont-elles numérisées ?", type: "textarea" },
      { id: "dem_reglementation", label: "La réglementation liée à votre métier vous impose de conserver certains documents : lesquels et pour quelle durée de conservation ?", type: "textarea" },
      { id: "dem_notes", label: "Notes", type: "textarea" },
      { id: "dem_prochain_rdv", label: "Date du prochain RDV ?", type: "text" }
    ]
  },

  {
    id: "info_infra",
    title: "Infrastructure informatique",
    icon: "💻",
    fields: [
      { id: "inf_note", label: "Note du parc informatique", type: "rating" },
      { id: "inf_gestionnaire", label: "Gestionnaire de l'informatique (interne / externe / Nom / relation)", type: "textarea" },
      { id: "inf_serveurs", label: "Nombre de serveurs ? (modèles ?)", type: "textarea" },
      { id: "inf_pc", label: "Nombre de PC ? (modèles ?)", type: "textarea" },
      { id: "inf_office", label: "Version pack Office (logiciels / version Pro / Familial)", type: "textarea" },
      { id: "inf_metiers", label: "Logiciels métiers", type: "textarea" },
      { id: "inf_distance", label: "Travail à distance", type: "textarea" },
      { id: "inf_maintenance", label: "Contrat de maintenance", type: "textarea" },
      { id: "inf_budget", label: "Budget annuel ?", type: "text" },
      { id: "inf_rdv_audit", label: "Rendez-vous audit ?", type: "yesno", withDate: true }
    ]
  },

  {
    id: "securite",
    title: "Sécurité & Sauvegarde",
    icon: "🔒",
    fields: [
      { id: "sec_politique", label: "Avez-vous une politique de sécurité de votre réseau interne ?", type: "textarea" },
      { id: "sec_protection", label: "Comment protégez-vous l'accès au réseau et/ou vos postes informatiques ? (antivirus pro)", type: "textarea" },
      { id: "sec_sauv_serveurs", label: "Comment sauvegardez-vous vos serveurs ?", type: "textarea" },
      { id: "sec_sauv_postes", label: "Comment sauvegardez-vous vos postes ?", type: "textarea" },
      { id: "sec_sauv_sensibles", label: "Comment sauvegardez-vous vos données sensibles ?", type: "textarea" },
      { id: "sec_sauv_patrimoine", label: "Comment sauvegardez-vous votre patrimoine informatique ?", type: "textarea" },
      { id: "sec_sauv_mails", label: "Comment sauvegardez-vous vos mails ?", type: "textarea" },
      { id: "sec_types_donnees", label: "Quels types de données sauvegardez-vous ?", type: "textarea" },
      { id: "sec_perte", label: "Avez-vous déjà perdu des données ? (cryptolocker)", type: "yesno", withPrecision: true },
      { id: "sec_types_perdus", label: "Quel(s) type(s) de données ont été concernés ?", type: "textarea" },
      { id: "sec_rdv_audit", label: "Rendez-vous audit ?", type: "yesno", withDate: true }
    ]
  },

  {
    id: "telephonie",
    title: "Téléphonie & Liens Internet",
    icon: "📞",
    fields: [
      { id: "tel_note", label: "Note de satisfaction de votre prestataire actuel", type: "rating" },
      { id: "tel_pourquoi", label: "Pourquoi ?", type: "textarea" },
      { id: "tel_operateur", label: "Quel est votre opérateur actuel ?", type: "text" },
      { id: "tel_techno", label: "Quelle(s) technologie(s) utilisez-vous ? (Fibre / ADSL / SDSL / VDSL / 4G)", type: "text" },
      { id: "tel_appels_manques", label: "Manquez-vous régulièrement des appels ?", type: "textarea" },
      { id: "tel_postes_fixe", label: "De combien de postes disposez-vous en fixe ?", type: "text" },
      { id: "tel_lignes_mobiles", label: "De combien de lignes mobiles disposez-vous ?", type: "text" },
      { id: "tel_fonctionnalites", label: "Quelles fonctionnalités complémentaires souhaiteriez-vous pour installation ?", type: "textarea", hint: "Standard / transfert d'appel / renvoi d'appel / message d'accueil / traçabilité des appels / menu vocal / répondeur / conserver vos lignes fixes en télétravail, etc." },
      { id: "tel_debit_montant", label: "Test de débit — Débit montant", type: "text", hint: "speedtest.net/fr" },
      { id: "tel_debit_descendant", label: "Test de débit — Débit descendant", type: "text" },
      { id: "tel_absences", label: "Comment gérez-vous les absences ou horaires de fermeture lorsque vous recevez des appels ?", type: "textarea" },
      { id: "tel_tracabilite", label: "Quelle traçabilité avez-vous de vos appels lorsque vous les manquez ?", type: "textarea" },
      { id: "tel_centrex", label: "Connaissez-vous les avantages de la technologie CENTREX ?", type: "textarea" },
      { id: "tel_budget", label: "Quel est votre budget actuel ?", type: "text" },
      { id: "tel_contrats", label: "Récupérer les contrats + date de RDV avec les référents", type: "textarea" }
    ]
  },

  {
    id: "impression",
    title: "Impression",
    icon: "🖨️",
    fields: [
      { id: "imp_fournisseur", label: "Quel est votre fournisseur actuel ?", type: "text" },
      {
        id: "imp_materiel", label: "Matériel(s) mis en place", type: "table",
        rows: ["Modèles", "Type (A4/A3 · N&B/CLR)", "Options", "Début location", "Montant loyer", "Maintenance"],
        cols: 3, colLabel: "Machine"
      },
      { id: "imp_volume", label: "Volume N&B / CLR en %", type: "text" },
      { id: "imp_copies_mois", label: "Nombre de copies / impressions mensuel ?", type: "text" },
      { id: "imp_types_docs", label: "Quels types de documents imprimez-vous ?", type: "textarea" },
      { id: "imp_dest", label: "Vos impressions sont-elles plutôt destinées à l'interne ou à l'externe ?", type: "textarea" },
      { id: "imp_soustraitance", label: "Sous-traitez-vous l'impression de certains documents ?", type: "textarea" },
      { id: "imp_scan", label: "Scannez-vous beaucoup ?", type: "textarea" },
      { id: "imp_budget_trim", label: "Quel est votre budget trimestriel ?", type: "text" },
      { id: "imp_contrat_factures", label: "Prendre contrat et factures (échéancier, pages supp.)", type: "yesno" },
      { id: "imp_ameliorer", label: "Que voudriez-vous voir améliorer ?", type: "textarea" },
      { id: "imp_criteres", label: "Selon vous, quels critères priment ?", type: "textarea", hint: "Coût de fonctionnement · qualité de service · suivi commercial · technologie du produit · traitement des déchets…" },
      { id: "imp_notes", label: "Notes", type: "textarea" }
    ]
  },

  {
    id: "communication",
    title: "Communication",
    icon: "📣",
    fields: [
      { id: "com_int_comment", label: "Interne — Comment communiquez-vous ? (entre sites / services)", type: "textarea" },
      { id: "com_int_outils", label: "Interne — Quels outils utilisez-vous ?", type: "textarea" },
      { id: "com_int_formation", label: "Interne — Comment formez-vous les salariés ?", type: "textarea" },
      { id: "com_ext_comment", label: "Externe — Comment communiquez-vous auprès de vos prospects / clients / fournisseurs ?", type: "textarea" },
      { id: "com_ext_outils", label: "Externe — Quels outils utilisez-vous ?", type: "textarea" },
      { id: "com_ext_budget", label: "Externe — Quel est votre budget ?", type: "text" },
      { id: "com_ext_budget_four", label: "Vos fournisseurs peuvent-ils vous allouer un budget communication ?", type: "textarea" },
      { id: "com_idee", label: "Idée : communiquer pour augmenter les ventes ?", type: "textarea" }
    ]
  },

  {
    id: "validation",
    title: "Validation du projet",
    icon: "✅",
    fields: [
      { id: "val_audit", label: "Audit ?", type: "yesno", withDate: true, dateLabel: "Date de l'audit" },
      { id: "val_pb1", label: "Problématique rencontrée n°1 (priorité)", type: "text" },
      { id: "val_pb2", label: "Problématique rencontrée n°2 (priorité)", type: "text" },
      { id: "val_pb3", label: "Problématique rencontrée n°3 (priorité)", type: "text" },
      {
        id: "val_projets", label: "Projets à présenter, hiérarchisés par ordre d'intérêt", type: "table",
        rows: ["Informatique", "Sécurité & Sauvegarde", "Téléphonie & Liens Internet", "Impression", "Dématérialisation", "Communication"],
        cols: 4, columns: ["Ordre", "Solution(s) envisagée(s)", "Budget estimé", "Date planifiée"], rowHeader: "Gamme"
      },
      { id: "val_demarrage", label: "Date de démarrage pour anticiper la date de signature (vs livraison)", type: "text" },
      { id: "val_processus", label: "Quel est votre processus de décision ?", type: "textarea" },
      { id: "val_critere1", label: "Critère de choix n°1", type: "text" },
      { id: "val_critere2", label: "Critère de choix n°2", type: "text" },
      { id: "val_critere3", label: "Critère de choix n°3", type: "text" },
      { id: "val_nego", label: "Qu'est-ce qui a fait la différence lors de la dernière négociation ?", type: "textarea" },
      { id: "val_prochain_rdv", label: "Date du prochain RDV ?", type: "text" },
      { id: "val_scoring", label: "Avez-vous pensé à scorer l'entreprise auprès d'un établissement financier ?", type: "textarea" },
      {
        id: "val_checklist", label: "Avant de partir", type: "checklist",
        options: [
          "Faire le tour des locaux",
          "Récupérer des docs pour préparer le R2 (contrat de location, échéancier, contrat de service, factures…)",
          "Demander une recommandation / cooptation"
        ]
      }
    ]
  }
];

/* ------------------------------------------------------------------ */
/*  Affaire — les 11 critères du CRM + champs de l'affaire            */
/* ------------------------------------------------------------------ */

// Les 11 critères tels que saisis dans le CRM (bloc « Détail »)
const AFFAIRE_CRITERES = [
  { id: "cr_signataire", label: "Le signataire" },
  { id: "cr_influenceur", label: "L'influenceur clé" },
  { id: "cr_besoin", label: "Besoin / solution proposée" },
  { id: "cr_motivation", label: "Motivation d'achat" },
  { id: "cr_quand", label: "Quand veut-il être équipé" },
  { id: "cr_relance", label: "Type et date de prochaine relance" },
  { id: "cr_leaseur", label: "Leaseur" },
  { id: "cr_etude", label: "Étude réalisée ou pas" },
  { id: "cr_propo", label: "Propo remise ou pas" },
  { id: "cr_accelerateur", label: "Accélérateur défini" },
  { id: "cr_obstacle", label: "Obstacle" }
];

// Échelle de maturité CRÉER / MÛRIR / SIGNER
const MATURITE = [
  { value: 20, label: "20 % — Affaire en devenir", desc: "RDV découverte planifié · 1 besoin identifié & 1er scoring fait" },
  { value: 50, label: "50 % — RDV signature non planifié", desc: "Il me manque des infos essentielles" },
  { value: 70, label: "70 % — Affaire qualifiée", desc: "Scoring ajusté" },
  { value: 79, label: "79 % — RDV signature planifié", desc: "Je suis confiant mais pas certain" },
  { value: 80, label: "80 % — Forte probabilité", desc: "Je le sens bien, forte proba de signature" },
  { value: 100, label: "100 % — Affaire gagnée", desc: "Bravo, c'est signé ! Reste à suivre la saisie ADV" }
];

// Types d'affaire (avec CA en K€), repris du CRM
const TYPES_AFFAIRE = [
  { id: "ta_renouv", label: "Renouvellement de machine" },
  { id: "ta_parc_copieur", label: "Nouveau parc copieur" },
  { id: "ta_solution_info", label: "Solution informatique / GED" },
  { id: "ta_parc_info", label: "Parc informatique" },
  { id: "ta_site", label: "Site internet" },
  { id: "ta_telephonie", label: "Téléphonie" },
  { id: "ta_docuware", label: "Docuware" },
  { id: "ta_pp", label: "PP" }
];

// Suivi de l'affaire (cases à cocher du CRM)
const SUIVI_AFFAIRE = [
  { id: "su_ouverture", label: "Ouverture projet avec direction" },
  { id: "su_besoin", label: "Besoin identifié" },
  { id: "su_etude", label: "Étude chiffrée" },
  { id: "su_accord", label: "Accord financier" },
  { id: "su_propal", label: "Proposition remise au client" }
];

const RESULTAT_AFFAIRE = ["Affaire en cours", "Affaire gagnée", "Affaire perdue", "Affaire annulée"];
