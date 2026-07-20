/*
 * Rex Seller — Structure du livret de découverte Rex-Rotary
 * Version « Limoges » (livret à jour). Chaque question du livret est reprise
 * ici, section par section, dans l'ordre du document, sans en omettre une seule.
 *
 * Types de champ supportés :
 *   text      -> saisie courte
 *   textarea  -> saisie longue
 *   number    -> nombre
 *   date      -> date
 *   rating    -> note de 1 à 10
 *   yesno     -> Oui / Non (+ date/précision optionnelle)
 *   checklist -> cases à cocher multiples
 *   table     -> tableau (rows = intitulés de ligne, cols = nb de colonnes)
 */

const BOOKLET = [
  {
    id: "infos",
    title: "Votre entreprise",
    icon: "🏢",
    intro: "Coordonnées du rendez-vous et présentation de l'entreprise.",
    fields: [
      { id: "date_rdv", label: "Date du rendez-vous", type: "date" },
      { id: "societe", label: "Nom de la société / statut", type: "text" },
      { id: "contact", label: "Contact", type: "text" },
      { id: "fonction", label: "Fonction", type: "text" },
      { id: "secteur", label: "Secteur d'activité / spécificités / valeurs ajoutées", type: "textarea" },
      { id: "localisation", label: "Localisation du siège, combien de sites", type: "textarea" },
      { id: "salaries", label: "Combien de salariés avez-vous ? (nomades / sédentaires)", type: "textarea" },
      { id: "typo_clients", label: "Quels types de clients adressez-vous ? (privé / public / typologie)", type: "textarea" },
      { id: "projets", label: "Quels sont vos projets de développement ?", type: "textarea" },
      { id: "decisions", label: "Comment se prennent les décisions chez vous ?", type: "textarea" },
      { id: "commercial", label: "Commercial (vous) — pour l'archive", type: "text", optional: true }
    ]
  },

  {
    id: "info_infra",
    title: "Infrastructure informatique",
    icon: "💻",
    fields: [
      { id: "inf_note", label: "Note de votre parc informatique", type: "rating" },
      { id: "inf_ecart10", label: "Qu'est-ce qui vous sépare pour arriver à 10 ?", type: "textarea" },
      { id: "inf_gestionnaire", label: "Gestionnaire de l'informatique, qui fait la maintenance ?", type: "textarea" },
      { id: "inf_pc_serveur", label: "Nombre de PC, serveur ?", type: "textarea" },
      { id: "inf_metiers", label: "Logiciels métiers", type: "textarea" },
      { id: "inf_av_office", label: "Comment faites-vous pour votre antivirus et votre Pack Office ?", type: "textarea" },
      { id: "inf_distance", label: "Travail à distance / télétravail", type: "textarea" },
      { id: "inf_budget", label: "Quel est votre budget lié à l'informatique ?", type: "textarea", hint: "Achat ou location des PC (âge), antivirus, maintenance et dépannages." }
    ]
  },

  {
    id: "securite",
    title: "Sécurité & Sauvegarde",
    icon: "🔒",
    fields: [
      { id: "sec_protection", label: "Comment protégez-vous l'accès au réseau et/ou vos postes informatiques ?", type: "textarea" },
      { id: "sec_sauv_serveurs", label: "Comment sauvegardez-vous vos serveurs ?", type: "textarea" },
      { id: "sec_sauv_postes", label: "Comment sauvegardez-vous vos postes ?", type: "textarea" },
      { id: "sec_sauv_sensibles", label: "Comment sauvegardez-vous vos données sensibles ?", type: "textarea" },
      { id: "sec_sauv_patrimoine", label: "Comment sauvegardez-vous votre patrimoine informatique ?", type: "textarea" },
      { id: "sec_sauv_mails", label: "Comment sauvegardez-vous vos mails ?", type: "textarea" },
      { id: "sec_types_donnees", label: "Quels types de données sauvegardez-vous ?", type: "textarea" },
      { id: "sec_perte", label: "Avez-vous déjà perdu des données ou connaissez-vous quelqu'un à qui c'est arrivé ?", type: "textarea" },
      { id: "sec_sinistre", label: "En cas de sinistre majeur, comment et en combien de temps redressez-vous l'activité ?", type: "textarea" },
      { id: "sec_rgpd", label: "Qu'avez-vous mis en place pour répondre à la RGPD ?", type: "textarea" },
      { id: "sec_rdv_audit", label: "Rendez-vous audit ?", type: "yesno", withDate: true }
    ]
  },

  {
    id: "demat",
    title: "Dématérialisation",
    icon: "📄",
    fields: [
      { id: "dem_partage", label: "Comment partagez-vous vos documents ? (interne et externe)", type: "textarea" },
      { id: "dem_validations", label: "Quels sont vos process de validation ? (congés, commandes, factures, etc.)", type: "textarea" },
      { id: "dem_nb_factures_four", label: "Nombre de factures fournisseurs traitées par mois ?", type: "text" },
      { id: "dem_nb_factures_cli", label: "Nombre de factures clients envoyées par mois ?", type: "text" },
      { id: "dem_nb_courriers", label: "Nombre de courriers reçus / envoyés ?", type: "text" },
      { id: "dem_bulletins", label: "Comment traitez-vous l'envoi des bulletins de salaires ?", type: "textarea" },
      { id: "dem_acces_distance", label: "Comment faites-vous pour accéder à vos documents en dehors de vos locaux ?", type: "textarea" },
      { id: "dem_apres_num", label: "Que faites-vous des documents après numérisation ?", type: "textarea" },
      { id: "dem_chronophage", label: "Quelles sont les tâches chronophages que vous réalisez ? (recherche, diffusion, tri, archivage, etc.)", type: "textarea" },
      { id: "dem_archives_num", label: "Vos archives sont-elles numérisées ?", type: "textarea" },
      { id: "dem_reglementation", label: "La réglementation liée à votre métier vous impose de conserver certains documents : lesquels et pour quelle durée de conservation ?", type: "textarea" },
      { id: "dem_rdv_demo", label: "RDV de démo", type: "text" }
    ]
  },

  {
    id: "impression",
    title: "Impression",
    icon: "🖨️",
    fields: [
      {
        id: "imp_location", label: "LOCATION", type: "table", cols: 3, colLabel: "Machine",
        rows: [
          "Marque / Modèle",
          "Type A3 / Cl",
          "Options",
          "Date début location",
          "Prix indexé du loyer",
          "Volumes inclus dans le loyer",
          "Volumes réels réalisés",
          "Prix indexé de la copie supplémentaire",
          "Coût dépassement copies",
          "Frais divers (toners, écologie, recyclage, maintenance…)",
          "Budget total"
        ]
      },
      {
        id: "imp_achat", label: "ACHAT", type: "table", cols: 3, colLabel: "Imprimante",
        rows: [
          "Modèle imprimante",
          "Type (A4 / Cl) + options",
          "Date et prix d'achat, durée amortissement",
          "Amortissement au trimestre",
          "Fréquence + prix cartouches NB",
          "Coût NB",
          "Fréquence + prix cartouches Cl",
          "Coût Cl",
          "Nombre copies + pourcentage NB / Cl",
          "Changement pièces + prix + fréquence",
          "Amortissement au trimestre (2)",
          "Budget total"
        ]
      },
      { id: "imp_docs", label: "Demander contrat + échéancier + 4 derniers relevés compteur", type: "yesno" }
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
    id: "telephonie",
    title: "Téléphonie & Liens Internet",
    icon: "📞",
    fields: [
      { id: "tel_note", label: "Note de satisfaction de votre prestataire actuel", type: "rating" },
      { id: "tel_pourquoi", label: "Pourquoi ?", type: "textarea" },
      { id: "tel_postes_fixe", label: "De combien de postes disposez-vous en fixe ?", type: "text" },
      { id: "tel_lignes_mobiles", label: "De combien de lignes mobiles disposez-vous ?", type: "text" }
    ]
  },

  {
    id: "validation",
    title: "Validation du projet",
    icon: "✅",
    fields: [
      { id: "val_reformulation", label: "Reformulation des problématiques / besoin + définition de l'objectif budgétaire", type: "textarea" },
      { id: "val_quand", label: "QUAND voulez-vous être équipés ?", type: "text" },
      { id: "val_processus", label: "Quel est votre processus de décision ?", type: "textarea" },
      { id: "val_engagement", label: "Engagement moral", type: "textarea", hint: "« Donc si je vous fais…. au prix de…., alors on bosse ensemble ? » — Si pas validé : « Qu'est-ce qui ferait qu'on travaille ensemble aujourd'hui (hormis le tarif ?) »" },
      {
        id: "val_projets", label: "Projets à présenter, hiérarchisés par ordre d'intérêt", type: "table",
        rows: ["Informatique", "Sécurité & Sauvegarde", "Dématérialisation", "Impression", "Communication", "Téléphonie"],
        cols: 4, columns: ["Ordre", "Solution(s) envisagée(s)", "Budget estimé", "Date planifiée"], rowHeader: "Gamme"
      },
      { id: "val_prochain_rdv", label: "Date du prochain RDV ?", type: "text" },
      { id: "val_audit", label: "Audit ?", type: "yesno", withDate: true, dateLabel: "Date de l'audit" },
      {
        id: "val_checklist", label: "Avant de partir", type: "checklist",
        options: [
          "Faire le tour des locaux (si pas déjà fait)",
          "Récupérer les docs pour préparer le R2 (contrat de location, échéancier, factures…)"
        ]
      }
    ]
  }
];

/* ------------------------------------------------------------------ */
/*  Affaire — les 11 critères du CRM + champs de l'affaire            */
/*  (Provenance : CRM Rex-Rotary — inchangé)                          */
/* ------------------------------------------------------------------ */

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

const MATURITE = [
  { value: 20, label: "20 % — Affaire en devenir", desc: "RDV découverte planifié · 1 besoin identifié & 1er scoring fait" },
  { value: 50, label: "50 % — RDV signature non planifié", desc: "Il me manque des infos essentielles" },
  { value: 70, label: "70 % — Affaire qualifiée", desc: "Scoring ajusté" },
  { value: 79, label: "79 % — RDV signature planifié", desc: "Je suis confiant mais pas certain" },
  { value: 80, label: "80 % — Forte probabilité", desc: "Je le sens bien, forte proba de signature" },
  { value: 100, label: "100 % — Affaire gagnée", desc: "Bravo, c'est signé ! Reste à suivre la saisie ADV" }
];

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

const SUIVI_AFFAIRE = [
  { id: "su_ouverture", label: "Ouverture projet avec direction" },
  { id: "su_besoin", label: "Besoin identifié" },
  { id: "su_etude", label: "Étude chiffrée" },
  { id: "su_accord", label: "Accord financier" },
  { id: "su_propal", label: "Proposition remise au client" }
];

const RESULTAT_AFFAIRE = ["Affaire en cours", "Affaire gagnée", "Affaire perdue", "Affaire annulée"];
