# Rex Seller — Aide à la découverte

Outil web pour les commerciaux **Rex-Rotary** : il reprend l'intégralité du *Livret de
découverte* question par question, sauvegarde la saisie automatiquement, puis génère en fin
de rendez-vous :

1. **Une synthèse PDF** du RDV à archiver ;
2. **Un résumé** prêt à coller dans le CRM ;
3. **La fiche Affaire** avec les **11 critères** + le taux de maturité (CRÉER / MÛRIR / SIGNER),
   prête à saisir dans le CRM lorsqu'une affaire est levée.

L'application est **100 % statique** (aucun serveur, aucune donnée envoyée à l'extérieur).
Tout est stocké **localement dans le navigateur** du commercial et fonctionne **hors-ligne**
(installable sur téléphone / tablette comme une application).

## Fonctionnalités

- Livret complet en 9 sections repliables, avec barre de progression et navigation rapide.
- Sauvegarde automatique + gestion de **plusieurs rendez-vous** (nouveau, dupliquer, supprimer).
- **Export / import** d'un RDV au format `.json` (sauvegarde ou passage d'un poste à l'autre).
- Types de champs fidèles au livret : notes 1–10, Oui/Non, tableaux (parc d'impression,
  projets à présenter), cases à cocher, etc.
- Onglet **Affaire** : les 11 critères du CRM, le CA potentiel, le % de maturité avec sa
  description, les types d'affaire (CA en K€), le suivi et le résultat.

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
index.html               Page unique de l'application
css/styles.css           Styles (écran + impression PDF)
js/data.js               Structure du livret + critères de l'affaire
js/app.js                Logique (saisie, sauvegarde, synthèses)
manifest.webmanifest     Manifeste PWA (installation)
sw.js                    Service worker (mode hors-ligne)
assets/icon.svg          Icône
```

## Faire évoluer le questionnaire

Toutes les questions sont décrites dans `js/data.js`. Pour ajouter / modifier une question,
il suffit d'éditer le tableau `BOOKLET` (aucune autre modification nécessaire). Les 11 critères,
l'échelle de maturité et les types d'affaire y sont également éditables.
