# Rex Commando — plan de réalisation (à valider avant tout code)

Date : 2026-10-25. Branche : `claude/great-mendel-49a219`.
Brief de référence : [`PROMPT_CLAUDE_CODE.md`](PROMPT_CLAUDE_CODE.md), prompt de veille
[`PROMPT_VEILLE.md`](PROMPT_VEILLE.md), jeu de test [`thematiques_exemple.json`](thematiques_exemple.json),
secteurs [`secteurs_commando.csv`](secteurs_commando.csv).

---

## 1. Ce que j'ai constaté (exploration, sans rien modifier)

### 1.1 Le dépôt RexSeller

- **Front statique sans build** : `index.html` + modules vanilla JS chargés par `<script>` (`app.js`,
  `supa.js`, `admin.js`, `tickets.js`, `pilotage.js`, `offline.js`), un seul `css/styles.css`
  (variables de marque `--rex`, composants `.btn`, `.modal`, `.tab`, `.pilot-card`, `.grid`…).
- **Pas de routeur** : une seule page (le livret). Les fonctions annexes (Administration, Pilotage,
  Tickets) sont des **modales** ouvertes depuis le panneau ☰, dont les boutons sont masqués ou
  affichés après connexion (`RexAdmin.onBoot()`, `RexPilotage.onBoot()`…). Chaque module expose
  `window.RexXxx = { onBoot() }`, et `app.js` les appelle à la fin de `boot()`.
- **Couche données** : `js/supa.js` crée le client Supabase et expose `window.RexDB` (profil,
  équipe visible, RDV, tickets, `callAdmin()` pour l'Edge Function). Le profil chargé est
  `profiles.*` (donc `role`, `agence`, `is_dev`).
- **Auth et rôles** : email + mot de passe Supabase ; rôles `rro > ca > ro > commercial` dans
  `public.profiles`, visibilité hiérarchique par la fonction `can_view()` (SECURITY DEFINER) et
  `is_dev()` pour l'administrateur. Sécurité réellement portée par les **policies RLS**.
- **Conventions** : commentaires et libellés en français ; échappement HTML par `esc()` ;
  toasts ; `sw.js` liste les fichiers à mettre en cache (`CACHE = "rexseller-v22"`, `?v=22` sur
  chaque script) ; tout ajout de fichier front doit y être inscrit et la version incrémentée.
- **Edge Function existante** : `supabase/functions/manage-users/index.ts` (Deno, `esm.sh`
  supabase-js, CORS, vérification du JWT puis du rôle en base, `service_role` côté serveur).
- **Migrations** : le dépôt contient un `supabase/schema.sql` monolithique ; les évolutions
  réelles ont été appliquées en base sous forme de migrations nommées (`tickets_system`,
  `usage_stats_function`…). Je propose d'ajouter un dossier `supabase/migrations/` pour Commando.

### 1.2 Le projet Supabase « RexSeller » (`chryjpudxhfboutymyvf`, eu-west-3)

- **Tables `public`** : `profiles` (34 lignes), `rendez_vous` (88), `tickets` (13),
  `_backup_impression_20260921`. RLS activée partout. **Je n'y toucherai pas.**
- **Autres applications cohabitent dans la même base** : schéma `flash` (19 tables, Flash Live PO)
  et schéma `golf` (11 tables). Les noms `commando_*` dans `public` ne créent aucun conflit.
- **Extensions installées** : `pg_cron` 1.6.4, `pg_net` 0.20.4, `pgcrypto`, `supabase_vault`,
  `uuid-ossp`. `pg_jsonschema` et `pgtap` sont disponibles mais pas installés.
- **Jobs pg_cron existants** (`flash_*`) : le mécanisme en place est
  `cron.schedule → fonction SQL → net.http_post(...) → Edge Function`, avec un secret partagé
  dans un en-tête. Je reprends ce mécanisme, mais avec le secret dans **Vault** plutôt qu'en
  clair dans une table (c'est ce que fait Flash dans `flash.settings`, à éviter).
- **Edge Functions déployées** : `manage-users` (RexSeller) et six `flash-*`.
- **Profils de l'équipe de Poitiers** (champ `agence` : `Poitiers` pour Scott, `POITIERS` pour
  les commerciaux — la casse n'est pas homogène, d'où l'intérêt de ne pas filtrer dessus) :

  | Personne | Email | Rôle | id |
  |---|---|---|---|
  | Scott HEITGEN | scott.heitgen@rex-rotary.fr | `ro`, `is_dev = true` | `28f7068b-…-96558a8bf6dd` |
  | Sarah LEVEQUE | sarah.leveque@rex-rotary.fr | `commercial` | `4804912a-…-9c3218293c4a` |
  | Teo CARON | teo.caron@rex-rotary.fr | `commercial` | `d07ac035-…-d017fd92462a` |
  | Arthur ROULON | arthur.roulon@rex-rotary.fr | `commercial` | `bae7f6a3-…-56f4b38eb8ea` |

  Deux autres commerciaux sont rattachés à Scott (Alexandre LEGER, Teddy ROLLAND) : **ils ne
  seront pas membres du commando** sauf indication contraire (question 10.5).

### 1.3 API Claude (documentation lue le 2026-10-25)

- **Modèle** : `claude-sonnet-5-5` existe (2 $ / M jetons en entrée, 10 $ / M en sortie, cache
  0,20 $). Réflexion adaptative activée par défaut ; profondeur réglée par
  `output_config.effort` (je partirai sur `medium`). Pas de pré-remplissage assistant, pas de
  `tool_choice` forcé sur ce modèle.
- **Recherche web côté serveur** : outil `web_search_20260318` (dernière version ; ajoute le
  filtrage dynamique des résultats et le contrôle `response_inclusion`). Paramètres utiles :
  `max_uses`, `user_location` (`country: "FR"`, `city: "Poitiers"`, `timezone: "Europe/Paris"`),
  `allowed_domains`/`blocked_domains`. Tarif : **10 $ pour 1 000 recherches** en plus des jetons.
- **Ce que renvoie l'API** : des blocs `server_tool_use` (la requête), des blocs
  `web_search_tool_result` contenant des `web_search_result` avec `url`, `title`, `page_age`
  (date de dernière mise à jour de la page) et `encrypted_content` ; puis des blocs `text` dont
  certains portent un tableau `citations` (`web_search_result_location` : `url`, `title`,
  `cited_text`). `usage.server_tool_use.web_search_requests` donne le nombre de recherches.
  **C'est l'ensemble des `url` des `web_search_result` qui servira de liste blanche** pour le
  badge « vérifiée / non vérifiée » (critère d'acceptation 6).
- **Contrainte importante** : les *structured outputs* (`output_config.format`) sont
  incompatibles avec les citations (erreur 400), et la recherche web produit toujours des
  citations. Le JSON sera donc demandé par le prompt (comme le fait déjà `PROMPT_VEILLE.md`) et
  **validé par un schéma côté fonction**, avec une seule nouvelle tentative, conformément à la
  section 8 du brief.
- **Limites à prévoir** : une génération dure plusieurs minutes (10 à 15 recherches + ~12 000
  jetons de sortie). Les Edge Functions Supabase ont une limite de temps d'exécution (ordre de
  grandeur : 150 s de CPU, 400 s d'horloge). D'où une génération **asynchrone** (section 5.2).

### 1.4 API Recherche d'entreprises — NON VÉRIFIÉE

L'hôte `recherche-entreprises.api.gouv.fr` (et `api.gouv.fr`) est **refusé par la politique
réseau de cet environnement**. Je n'ai donc pas pu relire la documentation ni tester une requête
sur 86000. Le plan ci-dessous repose sur ma connaissance de l'API, **à confirmer avant d'écrire
l'import** (point d'arrêt explicite du brief) :

- endpoint `GET https://recherche-entreprises.api.gouv.fr/search`, sans clé ;
- filtres : `code_postal`, `etat_administratif=A`, `tranche_effectif_salarie=02,03,11,12`,
  `activite_principale`, `page`, `per_page` (25 max), limite de **10 000 résultats** par requête
  et de l'ordre de **7 requêtes par seconde** ;
- la réponse est au niveau **unité légale** (`siren`, `nom_complet`, `nom_raison_sociale`,
  `activite_principale`, `tranche_effectif_salarie`, `annee_tranche_effectif_salarie`,
  `date_creation`, `dirigeants[]`, `siege`), avec un tableau `matching_etablissements[]`
  (`siret`, `activite_principale`, `tranche_effectif_salarie`, `annee_tranche_effectif_salarie`,
  `etat_administratif`, `adresse`, `code_postal`, `libelle_commune`, `liste_enseignes`,
  `est_siege`, `date_creation`).

**Pièges connus que l'import devra gérer** : le filtre `tranche_effectif_salarie` porte sur
l'unité légale (l'établissement a sa propre tranche, souvent `NN` ou vide) ; les
`matching_etablissements` d'une grande entreprise peuvent être tronqués ; le filtre
`code_postal` renvoie des établissements hors de la liste si une entreprise a plusieurs sites
(d'où l'anomalie « code postal inconnu » du critère 2).

Pour lever ce blocage : ajouter `recherche-entreprises.api.gouv.fr` aux domaines autorisés de
l'environnement cloud (menu de l'environnement → Edit → Network access), ou passer en accès
réseau large. Les Edge Functions, elles, auront accès à l'API sans réglage.

---

## 2. Architecture cible

```
RexSeller (front statique)             Supabase « RexSeller »
┌──────────────────────────┐           ┌──────────────────────────────────────────┐
│ index.html               │  RLS      │ public.commando_* (12 tables)            │
│  + vue « Commando »      │◄────────► │ fonctions SQL : moteur de couleurs,      │
│ js/commando.js (commerc.)│  RPC      │   aperçu, publication, ma liste, stats   │
│ js/commando-console.js   │           │ pg_cron : commando_import_hebdo (dim. soir)│
│ css/commando.css         │           │ Vault : secret du job                    │
└──────────────────────────┘           └──────┬───────────────────────┬───────────┘
                                   JWT resp.  │                       │ secret
                              ┌───────────────▼─────┐   ┌─────────────▼─────────┐
                              │ EF commando-veille   │   │ EF commando-import    │
                              │ → API Claude         │   │ → API Recherche       │
                              │   (web_search)       │   │   d'entreprises       │
                              └──────────────────────┘   └───────────────────────┘
```

Principes :

- **La base porte la sécurité** : appartenance au commando et rôle vérifiés par deux fonctions
  SQL (`commando_est_membre(uid)`, `commando_est_responsable(uid)`) utilisées dans toutes les
  policies, et re-vérifiés par les Edge Functions.
- **Le moteur de couleurs vit en SQL** (fonction immuable), unique implémentation : il sert
  à l'aperçu des compteurs, à la publication (instantané) et aux tests. Le navigateur n'a jamais
  à recalculer une couleur : il lit l'instantané.
- **Les écritures des commerciaux** passent par des tables qui leur sont dédiées (`commando_appels`,
  `commando_contacts`), jamais par `commando_entreprises` (alimentée uniquement par l'import).

---

## 3. Modèle de données et sécurité

Toutes les tables sont dans `public`, préfixées `commando_`, RLS activée, `grant` limités au
rôle `authenticated`. Aucune modification de `profiles`, `rendez_vous`, `tickets`.

| Table | Colonnes principales | Lecture | Écriture |
|---|---|---|---|
| `commando_membres` | `user_id` PK → profiles, `role` (`responsable`/`commercial`), `created_at` | membres | responsable |
| `commando_secteurs` | `code` PK (`63`, `64`, `65`, `NO`… modifiable), `nom`, `commercial_id` null → profiles, `ordre` | membres | responsable |
| `commando_codes_postaux` | `code_postal` PK, `ville`, `secteur_code` → secteurs (`on update cascade`) | membres | responsable |
| `commando_entreprises` | `siret` PK, `siren`, `raison_sociale`, `enseigne`, `naf_code`, `naf_libelle`, `tranche_effectif` (null si inconnue), `annee_effectif`, `date_creation_ul`, `adresse`, `code_postal`, `commune`, `dirigeants` jsonb (nom, prénom, qualité), `est_siege`, `est_client`, `nouvelle_semaine` (semaine ISO de première apparition), `first_seen_at`, `last_seen_at`, `archived_at`, `archive_raison`, `exclu_le`, `exclu_par`, `exclu_raison` | membres (hors archivées, sauf console) | import (service role) ; responsable pour `est_client` / exclusion |
| `commando_contacts` | `siret` PK → entreprises, `telephone`, `email`, `opposition` bool, `opposition_le`, `note`, `updated_by`, `updated_at` | membres | membres (upsert) |
| `commando_clients_siren` | `siren` PK, `importe_le`, `importe_par` | responsable | responsable (import de la liste clients) |
| `commando_imports` | `id`, `lance_le`, `termine_le`, `declencheur` (`cron`/`manuel`), `statut`, `codes_postaux` (périmètre), `compteurs` jsonb (par secteur : vues, ajoutées, réactivées, archivées, exclues par raison, effectif non renseigné), `anomalies` jsonb (codes postaux inconnus…), `erreur` | responsable | service role |
| `commando_parametres` | ligne unique : `fiche_rex`, `fiche_rex_brouillon`, `fiche_rex_validee_le`, `concurrents` jsonb, `consignes` (texte, valeurs par défaut du brief), `tranches_incluses` (`{02,03,11,12}`), `inclure_effectif_inconnu` (faux), `bornes_anciennete` (`{moins_3: 3, plus_5: 5}`), `delai_rappel_semaines` (8), `limite_generations_semaine` (5), `modele`, `secteur_libre_visible_par` (`equipe`/`responsable`), `updated_at`, `updated_by` | membres (lecture partielle via vue : les commerciaux n'ont pas besoin de la fiche) | responsable |
| `commando_semaines` | `id`, `semaine` (`2026-W44`, unique), `statut` (`brouillon`/`publiee`), `publiee_le`, `publiee_par` | membres | responsable / fonction de publication |
| `commando_generations` | `id`, `semaine_id`, `statut` (`en_cours`/`terminee`/`erreur`), `modele`, `prompt_version`, `prompt_envoye`, `reponse_brute` jsonb, `urls_recherche` jsonb, `jetons_entree`, `jetons_sortie`, `jetons_cache`, `nb_recherches`, `cout_estime`, `duree_ms`, `erreur`, `lancee_par`, `lancee_le`, `terminee_le` | responsable | Edge Function |
| `commando_thematiques` | `id`, `semaine_id`, `generation_id` null, `origine` (`ia`/`manuelle`), `statut` (`proposee`/`retenue`/`ecartee`), `ordre`, `cle` (l'`id` du JSON), `titre`, `offre_rex`, `pourquoi_maintenant`, `sources` jsonb (chaque source porte `verifiee` bool), `concurrence` jsonb, `regles` jsonb, `trames` jsonb, `objections` jsonb, `hypotheses` jsonb, `alertes` jsonb (ex. « aucune source de moins de 14 jours »), `modifiee_par`, `modifiee_le` | membres : seulement `retenue` d'une semaine `publiee` ; responsable : tout | responsable (édition), Edge Function (création) |
| `commando_ciblages` | PK (`thematique_id`, `siret`), `semaine_id`, `couleur` (`vert`/`orange`/`rouge`/null = non classée), `regle_index`, `raison`, `secteur_code` figé | membres | fonction de publication uniquement |
| `commando_appels` | `id`, `siret`, `semaine_id`, `thematique_id`, `commercial_id`, `statut` (`injoignable`/`rappeler`/`refus`/`rdv`), `date_rdv`, `rdv_statut` (`prevu`/`honore`/`annule`/`reporte`), `note`, `couleur_au_moment`, `regle_index_au_moment`, `created_at`, `updated_at` | membres (le responsable voit tout, un commercial voit les appels de son secteur) | commercial : ses propres appels ; responsable : tous |

Compléments :

- **Vue `commando_entreprises_v`** (`security_invoker`) : entreprise + `secteur_code` +
  `commercial_id` (via le code postal) + classe d'ancienneté calculée + `est_nouvelle` +
  contact + date du dernier appel. C'est la source des écrans.
- **Un compte absent de `commando_membres`** obtient zéro ligne sur toutes les tables
  `commando_*` (critère 1) : chaque policy commence par `commando_est_membre(auth.uid())`.
- **Index** : `entreprises(code_postal)`, `entreprises(siren)`, `entreprises(naf_code)`,
  `ciblages(semaine_id, siret)`, `appels(siret, created_at desc)`, `appels(commercial_id, semaine_id)`.
- **Données initiales** (migration de seed) : les 4 membres, les 4 secteurs, les 51 codes
  postaux du CSV (dont 37160 hors 86), les paramètres par défaut.

---

## 4. Fonctions SQL (RPC)

| Fonction | Rôle | Qui |
|---|---|---|
| `commando_est_membre(uid)`, `commando_est_responsable(uid)` | helpers RLS, SECURITY DEFINER, `search_path` figé | policies |
| `commando_anciennete(date_creation, bornes jsonb)` | classe `moins_3` / `3_5` / `plus_5` | vue, moteur |
| `commando_couleur(regles jsonb, naf text, tranche text, anciennete text)` | **moteur de couleurs** : règles évaluées dans l'ordre, conditions en ET, valeurs en OU, préfixes NAF par `like`, première règle gagnante, sinon `null` (non classée). Fonction `immutable` : même entrée, même sortie | aperçu, publication, tests |
| `commando_valider_regles(regles jsonb)` | rejette tout champ inconnu (`naf_prefixes`, `naf_exclus`, `tranches`, `anciennete` seulement), valeurs hors liste, couleur inconnue | édition console, Edge Function |
| `commando_apercu_compteurs(thematique_id)` | compteurs vert/orange/rouge/non classée par secteur, **avant publication**, sur les entreprises éligibles (actives, non client, sans opposition, non exclues) | responsable |
| `commando_publier(semaine_id)` | vérifie le rôle, exactement 3 thématiques `retenue`, calcule et fige `commando_ciblages` pour chaque thématique × entreprise éligible, passe la semaine en `publiee`. Transactionnelle | responsable |
| `commando_ma_liste(semaine_id)` | pour l'appelant : entreprises de son secteur (et du secteur libre selon décision), **une seule fois**, sous la thématique où sa couleur est la meilleure ; tri vert → orange → rouge, puis nouvelles, puis ancienneté `3_5` ; entreprises appelées depuis moins de N semaines en bas, signalées | commercial, responsable |
| `commando_vue_thematique(semaine_id, thematique_id)` | même chose, pour une thématique | idem |
| `commando_stats(depuis date)` | appels, RDV pris, taux, RDV honorés par couleur / thématique / règle / commercial / semaine ; RDV de la semaine face à l'objectif 5 ; drapeau « échantillon < 30 » | responsable (et chaque commercial pour ses propres chiffres) |
| `commando_repartition_base()` | codes NAF présents avec effectifs, répartition par tranche et ancienneté → variable `{{repartition_base}}` | Edge Function |
| `commando_cron_import()` | appelée par pg_cron : `net.http_post` vers l'Edge Function avec le secret lu dans Vault | pg_cron |

---

## 5. Fonctions serveur (Edge Functions, Deno)

### 5.1 `commando-import`

- **Déclencheurs** : pg_cron chaque dimanche 21 h (Paris) via le secret partagé ; ou le responsable
  depuis la console (JWT vérifié puis rôle vérifié en base). Paramètres : `codes_postaux`
  (sous-ensemble, pour le test sur 86000), `dry_run` (compteurs sans écriture).
- **Algorithme** : pour chaque code postal de `commando_codes_postaux`, pagination complète de
  l'API avec les tranches paramétrées (plus les « non renseignées » si activé), à ≤ 5 requêtes/s ;
  pour chaque établissement **actif** dont le code postal est dans la liste : `upsert` sur
  `siret` (jamais de doublon : critère 8), `last_seen_at = now()`, `nouvelle_semaine` posée à la
  première apparition ; établissements de la liste **non revus** et fermés selon l'API →
  `archived_at` (jamais supprimés) ; `est_client` recalculé depuis `commando_clients_siren`.
- **Rapport** (`commando_imports`) : ajoutées, réactivées, archivées, exclues avec raison
  (client, opposition, effectif non renseigné, tranche hors périmètre, hors liste de codes
  postaux), anomalies, par secteur. L'année de l'effectif est toujours stockée et affichée.
- **Idempotence** : relancer deux fois le même dimanche ne change que `last_seen_at`.

### 5.2 `commando-veille`

- **Autorisation** : JWT obligatoire, puis `commando_est_responsable` vérifié en base. Limite de
  générations par semaine lue dans `commando_parametres`.
- **Exécution asynchrone** : la fonction crée la ligne `commando_generations` (`en_cours`),
  répond immédiatement `202`, puis travaille en tâche de fond (`EdgeRuntime.waitUntil`). La
  console interroge la ligne toutes les 5 s (ou via Realtime). Une génération `en_cours` depuis
  plus de 10 minutes est affichée « en erreur » (garde-fou contre la limite de temps).
- **Appel Claude** : SDK officiel `@anthropic-ai/sdk` (import `npm:`), `client.messages.stream()`
  pour éviter les délais d'attente HTTP, modèle `claude-sonnet-5-5`, `max_tokens` 32 000,
  `output_config.effort = "medium"`, outil `web_search_20260318` avec `max_uses` 15 et
  `user_location` Poitiers/FR. Clé lue dans `Deno.env.get("ANTHROPIC_API_KEY")`, posée par
  `supabase secrets set` (jamais dans le code ni le navigateur).
- **Prompt** : `PROMPT_VEILLE.md` embarqué tel quel dans la fonction, avec un numéro de version
  explicite ; variables `{{…}}` remplacées par la fiche validée, les concurrents, les consignes,
  les thématiques des 8 dernières semaines, `commando_stats` et `commando_repartition_base`.
- **Validation de la sortie** (module partagé `_shared/validation.ts`, testé) :
  1. extraction du JSON depuis la concaténation des blocs `text` ; validation par schéma (Zod) :
     5 thématiques, champs obligatoires, 3 trames, couleurs valides, règles n'utilisant que les
     champs connus (une règle avec un champ inconnu → thématique rejetée). Invalide → **une**
     nouvelle tentative, puis statut `erreur` avec le détail ;
  2. chaque `sources[].url` et `concurrence.sources[].url` est comparée (normalisée) à l'ensemble
     des `url` des blocs `web_search_result` de cette génération : présente → `verifiee: true`,
     sinon `false` (badge « non vérifiée ») ;
  3. thématique sans source datée de moins de 14 jours → `alertes` ;
  4. `stop_reason: "refusal"` ou `max_tokens` → erreur explicite.
- **Traçabilité** : modèle, version du prompt, prompt complet envoyé, réponse brute, jetons
  (entrée, sortie, cache), nombre de recherches, coût estimé, durée, erreurs. La console affiche
  le coût du mois.
- **Régénérer une seule proposition** : même fonction avec `thematique_id`, prompt réduit
  (« remplace la thématique X, en évitant les autres retenues »), 1 élément attendu.
- **Première utilisation** : mode `fiche_rex` qui recherche sur le site public de Rex-Rotary
  (`allowed_domains` limité au domaine Rex-Rotary) et rédige le brouillon de fiche.

**Estimation de coût par génération** (hypothèses : 12 recherches, ~50 000 jetons d'entrée
dont les résultats de recherche, ~20 000 jetons de sortie réflexion comprise) :

| Poste | Montant |
|---|---|
| Entrée 50 k × 2 $/M | 0,10 $ |
| Sortie 20 k × 10 $/M | 0,20 $ |
| 12 recherches × 0,01 $ | 0,12 $ |
| **Total** | **≈ 0,45 $** (fourchette 0,30 à 0,80 $) |

Soit environ 2 $ par semaine au plafond de 5 générations. Je vous montrerai le prompt complet
rempli et ce calcul actualisé avant le premier appel réel (point d'arrêt du brief).

### 5.3 Secrets et déploiement

- `ANTHROPIC_API_KEY` : secret de fonction (Dashboard → Edge Functions → Secrets).
- Le secret du job est stocké dans **Vault** (`commando_cron_secret`, `vault.create_secret`) et lu par
  `commando_cron_import()`.
- `commando-import` : `verify_jwt = false` (appel cron) mais exige soit le secret, soit un JWT
  de responsable. `commando-veille` : `verify_jwt = true`.
- Déploiement par la CLI Supabase ou le tableau de bord, documenté dans
  `supabase/functions/README.md` (comme `manage-users`).

---

## 6. Front : l'onglet « Commando »

- **Accès** : au démarrage, `supa.js` lit `commando_membres` pour l'utilisateur (zéro ligne pour
  un non-membre). `RexDB.commando()` expose `{ membre, role }`. Un petit onglet « 🎯 Commando »
  apparaît dans la barre du haut (à gauche du ☰) uniquement pour les membres ; rien n'est
  affiché aux autres, ni dans le menu ☰ ni dans les « Nouveautés ».
- **Une vue plein écran** (`<section id="commandoView">`) qui remplace le livret, avec un bouton
  « ← Livret » pour revenir. Sous-onglets :
  1. **Ma liste** (commerciaux et responsable) ;
  2. **Par thématique** (3 onglets) ;
  3. **Console** (responsable seulement ; le bouton n'existe pas pour les autres et la base
     refuse de toute façon) ;
  4. **Tableau de bord** (responsable ; chaque commercial voit ses propres chiffres).
- **Fichiers** : `js/commando.js` (écran commercial, fiche, résultats d'appel, confirmation
  des RDV), `js/commando-console.js` (paramétrage, lancement, examen, ajustement, publication,
  suivi, imports), `css/commando.css` (cartes colorées vert/orange/rouge, bandeau de
  confirmation, barre d'actions mobile). Ajout dans `index.html`, `sw.js` (version 23) et le
  bloc « Nouveautés ».
- **Fiche entreprise** : raison sociale, activité, tranche + année, ancienneté, dirigeant,
  adresse, téléphone / e-mail éditables (table `commando_contacts`), **trame de la couleur
  figée** avec variables remplies (`{commercial}`, `{raison_sociale}`, `{tranche}`,
  `{anciennete}`, `{naf_libelle}`, `{dirigeant}`), raison de la couleur, objections.
- **Résultat d'appel en un clic** : 4 boutons + date pour « RDV pris » + note ; enregistre la
  thématique, la couleur et la règle au moment de l'appel. Les totaux de l'en-tête se mettent à
  jour immédiatement (critère 7).
- **Confirmation des RDV** : bandeau en haut de « Ma liste » listant les RDV dont la date est
  passée et `rdv_statut = prevu` : honoré / annulé / reporté (nouvelle date).
- **Filtres** : couleur, thématique, tranche, ancienneté, nouvelle, déjà appelée.
- **Mobile** : cartes empilées, actions accessibles au pouce, même gabarit que le livret.
- Hors périmètre V1 : pas de mode hors-ligne pour cet onglet (les données sont partagées).

---

## 7. Tests automatisés

- `supabase/tests/commando_moteur.sql` : tests du moteur de couleurs en SQL (blocs `do $$ …
  assert … $$`), exécutables dans l'éditeur SQL ou par la CLI. Cas : ordre des règles, ET entre
  conditions, OU dans une liste, `naf_exclus`, tranche inconnue, non classée, règle invalide
  rejetée. Les 5 règles de `thematiques_exemple.json` sont rejouées sur des entreprises
  fictives aux couleurs calculées à la main (critère 3).
- `supabase/functions/commando-veille/validation_test.ts` (`deno test`) : le fichier
  `thematiques_exemple.json` passe le schéma ; un JSON à 4 thématiques, une couleur inconnue,
  un champ de règle inconnu échouent ; une sortie truquée avec une URL absente des résultats de
  recherche ressort `verifiee: false` (critère 6) ; une source datée de 20 jours déclenche
  l'alerte.
- Tests d'accès : script SQL qui se place dans le rôle `authenticated` avec le `sub` d'un
  non-membre et vérifie zéro ligne sur chaque table `commando_*` (critère 1).

---

## 8. Ordre de livraison et points d'arrêt

Chaque étape est utilisable seule et donne lieu à un commit poussé sur la branche. Les points
d'arrêt (section 14 du brief) sont marqués ⛔ : je m'arrête et j'attends votre feu vert.

| Étape | Livrables | Points d'arrêt |
|---|---|---|
| **1. Socle** | migrations : tables, helpers, policies, seed (membres, secteurs, codes postaux, paramètres) ; Edge Function `commando-import` ; `commando_cron_import` + job pg_cron ; console : onglets Secteurs, Membres, Imports (rapport), import de la liste clients ; accès masqué/affiché | ⛔ création d'une branche Supabase (ou choix d'appliquer en production) ; ⛔ compteurs sur 86000 seul avant le premier import complet ; ⛔ activation du job |
| **2. Moteur** | `commando_couleur`, `commando_valider_regles`, `commando_apercu_compteurs`, `commando_publier` ; import manuel de `thematiques_exemple.json` dans une semaine brouillon ; tests SQL | — |
| **3. Écran commercial** | Ma liste, Par thématique, filtres, fiche, résultats d'appel, confirmation RDV, `commando_ma_liste` | — |
| **4. Console de la semaine** | examen des propositions (sources, badges, concurrence, règles + aperçu des compteurs, trames, objections, hypothèses), édition, thématique manuelle, choix des 3, publication, revue des nouvelles entreprises et des RDV | — |
| **5. Veille IA** | Edge Function `commando-veille`, validation, badges, coût, limite, fiche Rex (brouillon → validation), concurrents, consignes ; tests Deno | ⛔ prompt complet rempli + coût avant le premier appel réel ; ⛔ clé API à poser dans les secrets ; ⛔ déploiement |
| **6. Tableau de bord** | `commando_stats`, écran, avertissement < 30 appels, objectif 5 RDV, export CSV, alimentation de `{{performance}}` | — |

Chaque migration sera d'abord appliquée sur la branche Supabase (ou présentée avant exécution
en production si vous préférez), jamais directement en production sans votre accord.

---

## 9. Écarts et risques à connaître

1. **Documentation de l'API Recherche d'entreprises non vérifiée** depuis cet environnement
   (section 1.4). Je l'ajouterai dès que l'hôte sera autorisé ; sinon je vous demanderai un
   extrait de réponse JSON pour un code postal.
2. **Durée d'une génération** face à la limite de temps des Edge Functions : la conception
   asynchrone (5.2) couvre le cas nominal ; si la limite est atteinte en pratique, repli prévu
   en deux appels enchaînés (recherche puis mise en forme), sans changer les écrans.
3. **JSON demandé par le prompt** plutôt que garanti par *structured outputs* (incompatible
   avec les citations). Validation stricte + une relance ; le taux d'échec sera visible dans
   la console.
4. **Branches Supabase** : disponibles uniquement si le projet est sur un plan qui les
   autorise. Sinon, je travaillerai sur un schéma de test ou vous présenterai chaque migration
   avant exécution.
5. **Objectif « 5 RDV / commercial / semaine »** : mesurable dès l'étape 3 ; les comparaisons
   par couleur ne seront significatives qu'au-delà de 30 appels par cellule.

---

## 10. Questions avant de coder

**Les trois du brief (section 16)**

1. **Secteur libre (Centre-Sud, 22 codes postaux)** : visible par toute l'équipe (chacun peut y
   piocher), ou seulement par vous pour distribuer ? Ma proposition : paramètre
   `secteur_libre_visible_par` (défaut `responsable`), et dans la console un bouton « Affecter
   à … » par entreprise ou par code postal.
2. **Délai de rappel** : 8 semaines par défaut. Ma proposition : 8 semaines après un *refus*,
   2 semaines après un *injoignable*, délai choisi par le commercial pour un *rappeler*.
   Les trois valeurs seraient paramétrables.
3. **Tranche 50 à 99** : désactivée par défaut (ma recommandation : ces structures ont souvent
   un service interne, et les tranches SIRENE y sont plus souvent périmées). Activable dans
   les paramètres ; un changement ne prend effet qu'au prochain import.

**Les miennes**

4. **Base de production** : acceptez-vous que je crée une **branche Supabase** pour développer
   (coût horaire minime, supprimée à la fin), ou préférez-vous valider chaque migration avant
   que je l'applique directement en production ?
5. **Membres** : Scott, Sarah, Téo, Arthur uniquement ? Alexandre LEGER et Teddy ROLLAND
   (aussi rattachés à vous) restent-ils hors commando ?
6. **Clé API Anthropic** : disposez-vous d'une clé (console.anthropic.com) ? Je vous indiquerai
   la commande `supabase secrets set` ; je n'ai pas besoin de la connaître.
7. **Site public Rex-Rotary** pour le brouillon de fiche : `rex-rotary.fr` ? Un autre domaine
   (groupe, agence de Poitiers) ?
8. **Dirigeants** : l'API renvoie des personnes physiques (nom, prénom, qualité, parfois année
   de naissance). Je ne stockerai que nom, prénom et qualité. D'accord ?
9. **Codes postaux voisins** : les listes de la semaine excluent les établissements hors des
   51 codes, même si l'API les renvoie (sièges hors Vienne). Confirmez-vous ?
10. **Première semaine** : la semaine 2026-W44 commence demain. Visez-vous un démarrage avec
    l'étape 3 (listes classées depuis `thematiques_exemple.json`) avant la veille IA ?
