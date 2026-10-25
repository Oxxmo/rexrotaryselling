# Mission : « Rex Commando » dans RexSeller

Tu travailles dans le dépôt de **RexSeller**, l'application des commerciaux Rex-Rotary. La base de données est le projet Supabase « RexSeller » (ref `chryjpudxhfboutymyvf`, région eu-west-3). Elle contient déjà des données de production (`profiles`, `rendez_vous`, `tickets`) : traite-la avec prudence.

Trois fichiers accompagnent ce prompt :
- `secteurs_commando.csv` : la répartition des codes postaux par secteur et par commercial ;
- `PROMPT_VEILLE.md` : le prompt système de la veille IA hebdomadaire ;
- `thematiques_exemple.json` : le format de sortie attendu de la veille, qui sert aussi de jeu de test.

---

## 1. Objectif

Chaque lundi matin, l'agence de Poitiers organise un commando d'appels de prospection. **Rex Commando** est un nouvel onglet de RexSeller qui accompagne ce commando de bout en bout :

1. Le responsable lance une veille IA qui lui propose 5 thématiques d'actualité, chacune reliée aux offres Rex-Rotary, avec une analyse de la concurrence, des règles de ciblage et des trames d'appel.
2. Il en retient 3.
3. L'application classe alors automatiquement les entreprises de chaque secteur en vert, orange ou rouge selon les règles de chaque thématique.
4. Les commerciaux appellent avec la trame adaptée à chaque entreprise et notent le résultat de chaque appel.
5. Après chaque rendez-vous, ils confirment s'il a bien eu lieu.
6. Le tableau de bord montre si les cibles vertes produisent réellement plus de rendez-vous.

Objectif métier : **5 RDV par commercial et par semaine**.

Utilisateurs :
- **Responsable** : Scott Heitgen (rôle `ro` dans `profiles`). Il a seul accès à la console administrateur.
- **Commerciaux de l'équipe de Poitiers** : Sarah Lévêque, Téo Caron et Arthur.

---

## 2. Avant d'écrire du code : STOP

1. Explore le dépôt : stack front, routing, authentification et rôles, conventions (migrations, Edge Functions, styles), structure des onglets existants.
2. Lis le schéma Supabase et les policies RLS existantes. Vérifie la valeur exacte du champ `agence` pour l'équipe de Poitiers et retrouve les profils de Scott, Sarah, Téo et Arthur.
3. Consulte la documentation à jour de l'API Claude (https://docs.claude.com) : modèles disponibles, outil de recherche web côté serveur (nom exact, version, paramètres), format des citations renvoyées.
4. Présente-moi un plan : fichiers créés ou modifiés, migrations, policies, fonctions serveur, job hebdomadaire, ordre de livraison, et les questions de la section 16.

**Attends ma validation avant de coder.**

---

## 3. Accès restreint

- L'onglet n'est visible que des utilisateurs listés dans `commando_membres`. Les autres utilisateurs de RexSeller ne voient ni l'onglet ni les données.
- La restriction est appliquée **côté base, par des policies RLS**, et pas seulement en masquant l'onglet.
- Scott a le rôle `responsable` ; Sarah, Téo et Arthur ont le rôle `commercial`.
- La console administrateur et le déclenchement de la veille IA sont réservés au rôle `responsable`, y compris côté serveur.

---

## 4. Secteurs

Le fichier `secteurs_commando.csv` (séparateur `;`) contient les colonnes `code_postal`, `ville`, `secteur_code`, `secteur_nom` et `commercial` pour 51 codes postaux.

| Code | Secteur | Commercial |
|---|---|---|
| 63 | Ouest | Sarah Lévêque |
| 64 | Est | Téo Caron |
| NO | Nord-Ouest | Arthur |
| 65 | Centre-Sud | aucun (secteur libre) |

- Le code `NO` est provisoire : le Nord-Ouest n'a pas encore de code interne. Il doit pouvoir être modifié.
- Le code postal 37160 (Buxeuil) est hors du département 86. **Ne filtre pas sur le département : filtre sur la liste des codes postaux.**
- Depuis la console, le responsable peut réaffecter un secteur à un autre commercial et un code postal à un autre secteur.

---

## 5. Base d'entreprises

Source : l'API Recherche d'entreprises (api.gouv.fr), gratuite et sans clé. **Vérifie sa documentation à jour** (filtres, pagination, limites de débit) avant d'écrire l'import.

- **Niveau** : l'établissement (SIRET), actif, situé dans un code postal de la liste.
- **Tranches d'effectif INSEE retenues par défaut** : 02 (3 à 5), 03 (6 à 9), 11 (10 à 19) et 12 (20 à 49). La tranche 21 (50 à 99) est disponible en option, désactivée par défaut.
- **Effectif non renseigné** : ces établissements ne sont pas inclus par défaut, mais ils sont comptés dans le rapport d'import. Attention, c'est un piège connu : les tranches SIRENE sont déclaratives et parfois anciennes. Affiche toujours l'année de l'effectif.
- **Champs à récupérer** : SIRET, SIREN, raison sociale, enseigne, code et libellé NAF, tranche et année de l'effectif, date de création de l'unité légale, adresse, code postal, commune, et le ou les dirigeants (nom, prénom, qualité) quand l'API les fournit.
- **Ancienneté** : calculée à partir de la date de création de l'unité légale, en trois classes paramétrables : `moins_3`, `3_5`, `plus_5`.
- **Téléphone et e-mail** : ils ne figurent pas dans l'open data. Prévois des champs que les commerciaux peuvent remplir eux-mêmes.
- **Clients existants** : prévois un champ `est_client` et un import de liste de SIREN clients (je fournirai le fichier). Les clients sont exclus des listes d'appel par défaut.
- **RGPD** : prévois un champ `opposition` (« ne plus contacter ») qui exclut définitivement l'entreprise. Ne stocke que les données utiles à l'appel.

---

## 6. Mise à jour hebdomadaire de la base

- Un job planifié tourne chaque dimanche soir : pg_cron et une Edge Function, ou le mécanisme déjà utilisé dans le projet.
- Le job est **idempotent** : relancé deux fois, il ne crée aucun doublon.
- Les nouvelles entreprises sont marquées « nouvelle cette semaine ».
- Les établissements fermés sont archivés, jamais supprimés, pour conserver l'historique des appels.
- Un rapport d'import est consultable dans la console : entreprises ajoutées, archivées et exclues (avec la raison), par secteur.

---

## 7. Console administrateur

### 7.1 Paramétrage (une fois, puis à la demande)

- **Fiche Rex-Rotary** : au premier lancement, la veille IA fait une recherche sur le site public de Rex-Rotary et rédige un brouillon de fiche (offres, services, offre d'entrée). Le responsable la corrige et la valide. Seule la fiche validée est utilisée par la veille hebdomadaire.
- **Concurrents** : une liste modifiable de concurrents à surveiller.
- **Consignes commerciales** : un texte modifiable, injecté dans chaque veille. Valeurs par défaut :
  - offre d'entrée : un audit gratuit de 30 minutes plutôt qu'une vente directe ;
  - conclusion : proposer deux créneaux précis plutôt qu'une question ouverte ;
  - ton : apporter de la clarté, ne pas faire peur ;
  - angle signature : les copieurs connectés sont une faille réseau souvent oubliée.

### 7.2 Le lundi matin

1. **Lancer la veille.** Un bouton déclenche la fonction serveur décrite en section 8. La génération est asynchrone : affiche son état (en cours, terminée, en erreur).
2. **Examiner les 5 propositions.** Pour chacune, la console affiche :
   - le titre, l'offre Rex associée et la raison d'agir maintenant ;
   - les sources, cliquables et datées, avec un badge « vérifiée » ou « non vérifiée » (voir section 8) ;
   - l'analyse de la concurrence et l'angle Rex ;
   - les règles de couleur et un **aperçu des compteurs** (nombre d'entreprises vertes, orange, rouges et non classées, par secteur) calculé avant publication ;
   - les trames d'appel par couleur et les objections ;
   - les hypothèses, clairement séparées des faits.
3. **Ajuster.** Le responsable peut modifier n'importe quel champ, régénérer une seule proposition ou ajouter une thématique écrite à la main.
4. **Retenir 3 thématiques et publier.** Les entreprises sont alors classées pour chaque thématique et chaque secteur, et les listes apparaissent chez les commerciaux.

### 7.3 Suivi

- Revue des nouvelles entreprises de la semaine, avec la possibilité d'en exclure.
- Revue des RDV pris et de leur confirmation.
- Accès au tableau de bord d'efficacité (section 11).
- Gestion des secteurs, des membres, de la fiche Rex, des concurrents et des consignes.

---

## 8. Fonction serveur de veille IA

- **Appel** : une Edge Function appelle l'API Messages d'Anthropic avec l'outil de recherche web côté serveur. Modèle suggéré : Claude Sonnet 5.5 (`claude-sonnet-5-5`), à confirmer dans la documentation.
- **Clé API** : stockée dans les secrets Supabase. Jamais dans le code ni côté navigateur.
- **Autorisation** : seul un utilisateur `responsable` peut déclencher la fonction, et la fonction le vérifie elle-même.
- **Prompt système** : le contenu de `PROMPT_VEILLE.md`, versionné. Les variables entre doubles accolades sont remplies par la fonction : fiche Rex validée, concurrents, consignes, thématiques des 8 dernières semaines, performance passée (section 11) et répartition de la base (codes NAF présents avec leurs effectifs, tranches, classes d'ancienneté).
- **Validation de la sortie** :
  - le JSON est validé contre un schéma. S'il est invalide, la fonction fait une seule nouvelle tentative, puis affiche l'erreur ;
  - chaque URL citée doit figurer parmi les résultats de recherche réellement renvoyés par l'API pendant cette génération. Sinon, la source est marquée « non vérifiée » dans la console ;
  - une thématique sans source datée de moins de 14 jours est signalée ;
  - une règle qui utilise un champ inconnu est rejetée.
- **Coût et traçabilité** : chaque génération est enregistrée (modèle, version du prompt, jetons consommés, coût estimé, durée, erreurs). La console affiche le coût du mois. Limite : 5 générations par semaine, paramétrable.

---

## 9. Moteur de couleurs

- Les règles sont évaluées dans l'ordre. La première qui correspond donne la couleur.
- Une entreprise sans règle correspondante est « non classée », jamais rouge par défaut. Le nombre de non classées est affiché, car il révèle les trous des règles.
- Conditions possibles : `naf_prefixes`, `naf_exclus`, `tranches`, `anciennete`. Les conditions d'une règle se combinent en ET ; les valeurs d'une même liste se combinent en OU.
- **Le calcul est déterministe** et fait par l'application, sans appel à une IA par entreprise : à données identiques, la couleur est identique.
- À la publication, la couleur, la règle appliquée et sa raison sont **figées** pour chaque entreprise et chaque thématique (instantané). C'est ce qui permet de mesurer l'efficacité des couleurs.

---

## 10. Écran commercial

- **Ma liste** : son secteur, avec chaque entreprise affichée **une seule fois**, sous la thématique où elle a la meilleure couleur. On n'appelle pas la même entreprise trois fois dans la semaine. Tri : vert, puis orange, puis rouge ; à couleur égale, les « nouvelles » d'abord, puis l'ancienneté de 3 à 5 ans.
- **Vue par thématique** : les 3 thématiques en onglets, pour qui veut travailler un sujet à la fois.
- **Filtres** : couleur, thématique, tranche, ancienneté, nouvelle, déjà appelée.
- **Fiche entreprise** : raison sociale, activité, tranche, ancienneté, dirigeant, adresse, champs téléphone et e-mail modifiables, et surtout **la trame correspondant à la couleur de l'entreprise**, avec les variables remplies, la raison de la couleur et les objections de la thématique.
- **Résultat d'appel en un clic** : injoignable, rappeler, refus, **RDV pris** (avec la date). Une note libre est possible. L'appel enregistre la thématique utilisée.
- **Confirmation du RDV** : une fois la date passée, un bandeau demande au commercial si le RDV a eu lieu (honoré, annulé, reporté).
- **Entreprises déjà appelées** depuis moins de N semaines (paramètre, 8 par défaut) : elles sont signalées et placées en bas de liste.
- **Secteur libre** : comportement à confirmer (section 16).
- L'écran doit être utilisable sur mobile.

---

## 11. Tableau de bord d'efficacité

- Par couleur, par thématique, par règle, par commercial et par semaine : nombre d'appels, RDV pris, taux de RDV, RDV honorés.
- RDV de la semaine par commercial face à l'objectif de 5.
- Un avertissement « échantillon insuffisant » s'affiche sous 30 appels : un taux calculé sur 10 appels ne prouve rien.
- Ces mêmes chiffres alimentent la variable `{{performance}}` de la veille suivante.
- Export CSV.

---

## 12. Modèle de données proposé

À adapter aux conventions du projet. RLS activé sur toutes les tables. **Ne modifie pas `profiles`, `rendez_vous` ni `tickets`.**

- `commando_membres` (user_id → profiles, role : responsable | commercial)
- `commando_secteurs` (code, nom, commercial_id nullable)
- `commando_codes_postaux` (code_postal, ville, secteur_code)
- `commando_entreprises` (siret PK, siren, champs de la section 5, est_client, opposition, first_seen_at, last_seen_at, archived_at)
- `commando_imports` (date, compteurs, détail en jsonb)
- `commando_parametres` (fiche_rex, fiche_rex_validee_le, concurrents, consignes, limites, paramètres d'affichage)
- `commando_semaines` (semaine ISO, statut : brouillon | publiée)
- `commando_generations` (semaine_id, statut, modèle, version du prompt, jetons, coût estimé, durée, erreurs, réponse brute)
- `commando_thematiques` (semaine_id, generation_id nullable, origine : ia | manuelle, statut : proposée | retenue | écartée, titre, offre_rex, pourquoi_maintenant, sources jsonb, concurrence jsonb, regles jsonb, trames jsonb, objections jsonb, hypotheses jsonb, modifiée_par)
- `commando_ciblages` (semaine_id, thematique_id, siret, couleur, index de la règle, raison) : l'instantané de la section 9
- `commando_appels` (siret, semaine_id, thematique_id, commercial_id, statut, date_rdv, rdv_statut : prévu | honoré | annulé | reporté, note, couleur_au_moment, horodatages)

---

## 13. Critères d'acceptation

1. Un compte absent de `commando_membres` ne voit pas l'onglet, et une requête directe sur les tables `commando_*` lui renvoie zéro ligne. Un commercial ne peut ni ouvrir la console ni déclencher la veille.
2. Chaque entreprise importée appartient à exactement un secteur. Un code postal inconnu apparaît comme anomalie dans le rapport d'import.
3. Le fichier `thematiques_exemple.json` passe la validation de schéma, et je peux recalculer à la main les couleurs de 5 entreprises tirées au hasard.
4. Pour chaque thématique publiée, chaque entreprise a exactement une couleur ou le statut « non classée », et les compteurs sont affichés.
5. Dans « Ma liste », aucune entreprise n'apparaît deux fois.
6. Une source inventée (URL absente des résultats de recherche) est bien marquée « non vérifiée ». Fais le test avec une sortie truquée.
7. Cocher « RDV pris » met à jour les totaux immédiatement, et la confirmation du RDV apparaît une fois la date passée.
8. Relancer l'import hebdomadaire ne crée aucun doublon.
9. Le moteur de règles et la validation de la sortie IA sont couverts par des tests automatisés.

---

## 14. Points d'arrêt : consulte-moi avant de…

- lancer toute migration sur la base de production. Travaille d'abord sur une branche Supabase ou en local ;
- modifier une table ou une policy existante ;
- lancer le premier import complet. Montre-moi d'abord les compteurs sur un seul code postal (86000) ;
- faire le premier appel réel à l'API Claude. Montre-moi d'abord le prompt complet tel qu'il sera envoyé, variables remplies, et une estimation du coût par génération ;
- ajouter toute autre dépendance ou API payante ;
- déployer.

Et si une donnée ou une API ne se comporte pas comme décrit ici, arrête-toi et signale-le-moi plutôt que de contourner le problème.

---

## 15. Ordre de livraison suggéré

1. Tables, accès, secteurs, import de la base, rapport d'import.
2. Moteur de couleurs et import manuel de `thematiques_exemple.json`.
3. Écran commercial, résultats d'appel, confirmation des RDV.
4. Console : revue, ajustement, publication.
5. Fonction de veille IA, avec ses validations et son suivi des coûts.
6. Tableau de bord d'efficacité.

Chaque étape doit être utilisable seule, pour que le commando puisse démarrer avant la fin du chantier.

---

## 16. Questions à me poser dans ton plan

- Le secteur libre (Centre-Sud) doit-il être visible par toute l'équipe, ou seulement par moi pour que je distribue les entreprises ?
- Quel délai avant de rappeler une entreprise (8 semaines par défaut ?), et ce délai dépend-il du statut (refus ou injoignable) ?
- Faut-il inclure la tranche 50 à 99 par défaut ?

---

## 17. Hors périmètre de la V1

- Enrichissement automatique des contacts (téléphone) pour les cibles vertes.
- Création d'un livret de découverte (`rendez_vous`) pré-rempli quand un RDV est pris.
- Ajustement automatique des règles à partir des résultats : en V1, l'IA s'en sert pour ses propositions, mais c'est toujours moi qui valide.
