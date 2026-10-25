# Rex Seller — Aide à la découverte

Outil web pour les commerciaux **Rex-Rotary** : il reprend l'intégralité du *Livret de
découverte* question par question, sauvegarde la saisie automatiquement, puis génère en fin
de rendez-vous :

1. **Une synthèse PDF** du RDV à archiver ;
2. **Un résumé** prêt à coller dans le CRM ;
3. **La fiche Affaire** avec les **11 critères** + le taux de maturité (CRÉER / MÛRIR / SIGNER),
   prête à saisir dans le CRM lorsqu'une affaire est levée.

Le front-end reste **statique** (aucun build), mais les rendez-vous sont désormais
**enregistrés dans une base Supabase** avec **authentification** et **visibilité
hiérarchique** : chacun voit ses propres rendez-vous **et ceux de toutes les personnes
situées sous lui** dans l'organigramme (RRO → CA → RO → commercial).

## Fonctionnalités

- **Connexion** par email + mot de passe (indépendante de tout SSO / tenant Microsoft).
- **Visibilité hiérarchique** appliquée côté base (Row-Level Security) :
  - commercial → ses RDV ;
  - RO → ses RDV + ceux de ses commerciaux ;
  - CA → toute son agence ; RRO → toute la région.
  Les responsables disposent d'un **filtre « Voir les RDV de »** ; les RDV d'un
  collaborateur s'ouvrent en **lecture seule**.
- Livret complet en sections repliables, **anneau de progression** dans l'en-tête et
  **dock de navigation flottant** (secteurs, *Affaire*, *Synthèse*) accessible d'un pouce
  sur mobile. Chaque section affiche son avancement (`3/8`, `Client ✓`).
- Sauvegarde automatique + gestion de **plusieurs rendez-vous** (nouveau, dupliquer, supprimer).
- **Export / import** d'un RDV au format `.json`.
- Types de champs fidèles au livret : notes 1–10, Oui/Non, tableaux, cases à cocher, etc.
- Onglet **Affaire** : les 11 critères du CRM, pré-remplis depuis le livret.
- **Console d'administration intégrée** (☰ → *Administration*, responsables uniquement) :
  créer / modifier / supprimer les comptes de son équipe et réinitialiser les mots de
  passe, sans toucher au SQL. Chaque responsable ne gère que son sous-arbre.
- **Système de tickets** (☰ → *Signaler / Demande*) : tout utilisateur peut créer une
  demande ou signaler un bug ; les tickets ne sont visibles que par leur auteur et par
  le **développeur dédié** (`profiles.is_dev = true`), qui les consulte via *Tickets reçus*
  et en gère le statut (ouvert / en cours / résolu).
- **Mode hors-ligne** : chaque saisie est enregistrée immédiatement **sur l'appareil**
  (localStorage) ; rien n'est perdu en cas de coupure réseau ou de fermeture de l'app.
  Les RDV modifiés hors ligne sont **resynchronisés automatiquement** au retour du réseau
  (indicateur « à synchroniser » dans l'en-tête). L'application peut même **s'ouvrir sans
  réseau** à partir des données en cache. Périmètre volontairement limité aux **données
  personnelles** de l'utilisateur (ses RDV + sa présentation) ; les RDV des collaborateurs
  (vue responsable) restent consultés en ligne.

## Rex Commando (agence de Poitiers)

Petit onglet **🎯 Commando** dans la barre du haut, visible uniquement par les membres listés dans
`commando_membres` (la restriction est appliquée par les policies RLS, pas seulement par
l'interface). Chaque lundi matin :

1. le responsable lance la **veille IA** (Edge Function `commando-veille`, API Claude avec
   recherche web) qui propose 5 thématiques d'actualité reliées aux offres Rex-Rotary,
   avec sources datées et vérifiées, analyse de la concurrence, règles de ciblage et
   trames d'appel ;
2. il en retient 3 et **publie** : chaque entreprise de la base reçoit une couleur figée
   (vert / orange / rouge / non classée) par thématique, calculée en SQL de façon
   déterministe (`commando_couleur`) ;
3. les commerciaux appellent depuis **Ma liste** (chaque entreprise une seule fois, sous
   sa meilleure couleur) avec la trame adaptée, et notent le résultat en un clic ;
4. après chaque RDV, un bandeau demande s'il a eu lieu ;
5. le tableau de bord **Efficacité** montre si les cibles vertes produisent plus de RDV
   (avertissement sous 30 appels). Objectif : 5 RDV par commercial et par semaine.

La base d'entreprises (établissements actifs de 51 codes postaux, tranches 3 à 49
salariés) est mise à jour chaque dimanche soir depuis l'API Recherche d'entreprises
(Edge Function `commando-import`, job pg_cron). Clients et oppositions RGPD sont exclus
des listes.

- Brief, prompt de veille et plan : [`docs/commando/`](docs/commando/)
- Migrations : [`supabase/migrations/`](supabase/migrations/) (`commando_*`)
- Tests : [`supabase/tests/`](supabase/tests/) (SQL) et `supabase/functions/_shared/validation_test.ts` (Deno)
- Fonctions serveur et secrets : [`supabase/functions/README.md`](supabase/functions/README.md)

## Mise en place de la base (à faire une seule fois)

1. **Créer le projet Supabase** (région Europe) — noter l'*URL du projet* et la
   *publishable key*, puis les renseigner dans `js/config.js`.
2. **Créer les tables et la sécurité** : dans Supabase, **SQL Editor → New query**,
   coller le contenu de [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Déployer la fonction d'administration** : suivre
   [`supabase/functions/README.md`](supabase/functions/README.md) (Edge Function
   `manage-users`). C'est elle qui permet de créer des comptes depuis l'application, en
   toute sécurité (la clé secrète reste côté serveur).
4. **Créer le tout premier compte (le RRO)** à la main :
   **Authentication → Users → Add user** (email pro + mot de passe), puis en SQL :
   ```sql
   update public.profiles set role='rro', full_name='Nom du RRO'
     where email='rro@entreprise.fr';
   ```
5. **Ensuite, tout se fait depuis l'application** : le RRO se connecte, ouvre
   **☰ → Administration** et crée les CA, qui créent les RO, qui créent les commerciaux.

> La *publishable key* est **publique par conception** : la sécurité repose sur la
> Row-Level Security de la base et l'Edge Function, pas sur le secret de cette clé.

## Utilisation en rendez-vous

1. Ouvrir l'application, cliquer sur **☰ → Nouveau RDV**.
2. Dérouler les sections et remplir au fil de l'échange (tout est enregistré en direct).
3. En fin de RDV, cliquer sur **« Générer la synthèse du RDV »** :
   - **Archive PDF** → *Enregistrer / Imprimer le PDF* (choisir « Enregistrer au format PDF »),
     puis rattacher le fichier dans le CRM.
   - **Résumé CRM** → *Copier* et coller dans le suivi.
   - **Affaire** → activer *« Une affaire est à lever »*, compléter les 11 critères puis *Copier*.

## Hébergement (accès en ligne, gratuit)

Le dossier est prêt pour **GitHub Pages** :

1. Sur GitHub : **Settings → Pages**.
2. *Source* : `Deploy from a branch`.
3. Branche : la branche du site (ex. `main`), dossier `/ (root)`, puis **Save**.
4. L'URL fournie (`https://<compte>.github.io/<repo>/`) est à partager aux commerciaux.

> Tout autre hébergement de fichiers statiques (Netlify, un simple serveur web interne…)
> fonctionne également : il suffit de servir le contenu du dossier tel quel.

Pour l'installer sur mobile : ouvrir l'URL dans le navigateur → menu → *Ajouter à l'écran d'accueil*.

## Structure

```
index.html               Page unique de l'application (+ écran de connexion)
css/styles.css           Styles (écran + impression PDF + connexion)
assets/fonts/            Police Manrope (hébergée localement, voir le README du dossier)
js/config.js             URL + clé publique Supabase
js/vendor/supabase.js    Bibliothèque Supabase (hébergée localement, pas de CDN)
js/offline.js            Cache local + file de synchronisation (mode hors-ligne)
js/supa.js               Authentification + accès aux données (Row-Level Security)
js/commando-core.js      Rex Commando : accès, navigation, utilitaires
js/commando.js           Rex Commando : écran commercial (Ma liste, fiche, appels)
js/commando-semaine.js   Rex Commando : console de la semaine (veille, propositions, publication)
js/commando-console.js   Rex Commando : base, secteurs, membres, imports, paramètres
js/commando-dashboard.js Rex Commando : tableau de bord d'efficacité
css/commando.css         Styles de l'onglet Commando
js/admin.js              Console d'administration des comptes (responsables)
js/tickets.js            Système de tickets (demandes / bugs)
js/data.js               Structure du livret + critères de l'affaire
js/app.js                Logique (saisie, sauvegarde en base, synthèses)
supabase/schema.sql      Schéma de la base + règles de visibilité hiérarchique
supabase/functions/      Edge Functions : manage-users, commando-import, commando-veille
supabase/migrations/     Migrations Rex Commando
supabase/tests/          Tests SQL (accès, moteur de couleurs)
manifest.webmanifest     Manifeste PWA (installation)
sw.js                    Service worker (cache de l'app ; données toujours en ligne)
assets/icon.svg          Icône
```

## Faire évoluer le questionnaire

Toutes les questions sont décrites dans `js/data.js`. Pour ajouter / modifier une question,
il suffit d'éditer le tableau `BOOKLET` (aucune autre modification nécessaire). Les 11 critères,
l'échelle de maturité et les types d'affaire y sont également éditables.
