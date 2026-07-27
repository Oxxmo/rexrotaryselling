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
- Livret complet en sections repliables, barre de progression et navigation rapide.
- Sauvegarde automatique + gestion de **plusieurs rendez-vous** (nouveau, dupliquer, supprimer).
- **Export / import** d'un RDV au format `.json`.
- Types de champs fidèles au livret : notes 1–10, Oui/Non, tableaux, cases à cocher, etc.
- Onglet **Affaire** : les 11 critères du CRM, pré-remplis depuis le livret.

## Mise en place de la base (à faire une seule fois)

1. **Créer le projet Supabase** (région Europe) — noter l'*URL du projet* et la
   *publishable key*, puis les renseigner dans `js/config.js`.
2. **Créer les tables et la sécurité** : dans Supabase, ouvrir **SQL Editor → New query**,
   coller le contenu de [`supabase/schema.sql`](supabase/schema.sql) et cliquer **Run**.
3. **Créer les comptes** : **Authentication → Users → Add user** (email pro + mot de passe).
   Un profil « commercial » est créé automatiquement à chaque ajout.
4. **Déclarer l'organigramme** : quelques `UPDATE` en SQL fixent le rôle et le responsable
   (`manager_id`) de chacun — voir les exemples en bas de `supabase/schema.sql`.

> La *publishable key* est **publique par conception** : la sécurité repose sur la
> Row-Level Security de la base, pas sur le secret de cette clé.

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
js/config.js             URL + clé publique Supabase
js/vendor/supabase.js    Bibliothèque Supabase (hébergée localement, pas de CDN)
js/supa.js               Authentification + accès aux données (Row-Level Security)
js/data.js               Structure du livret + critères de l'affaire
js/app.js                Logique (saisie, sauvegarde en base, synthèses)
supabase/schema.sql      Schéma de la base + règles de visibilité hiérarchique
manifest.webmanifest     Manifeste PWA (installation)
sw.js                    Service worker (cache de l'app ; données toujours en ligne)
assets/icon.svg          Icône
```

## Faire évoluer le questionnaire

Toutes les questions sont décrites dans `js/data.js`. Pour ajouter / modifier une question,
il suffit d'éditer le tableau `BOOKLET` (aucune autre modification nécessaire). Les 11 critères,
l'échelle de maturité et les types d'affaire y sont également éditables.
