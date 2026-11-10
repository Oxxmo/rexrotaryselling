# Rex Commando — système visuel

Le Commando est un outil de prospection téléphonique : trois heures d'appels le lundi, depuis un téléphone, avec un responsable qui pilote la semaine. L'interface doit ressembler à un logiciel commercial (CRM, outil d'appel), pas à une page de présentation.

## Références étudiées

- **Twenty** (CRM open source, paquet npm `twenty-ui`) : jetons de thème lus dans `theme-light.css`.
  - Gris neutres, texte principal à 20 % de noir, traits clairs.
  - Arrondis de 4 et 8 px, espacement par pas de 4 px, graisses 400 / 500 / 600.
  - Pas de dégradé ni d'ombre portée sur les blocs.
- **Outils d'appel** (Close, Aircall, Salesflow) :
  - une file d'appels avec « suivante » automatique ;
  - les résultats d'appel en un geste ;
  - la fiche du prospect affichée pendant l'appel ;
  - le rappel programmé quand on n'a pas joint.
- **Lucide** (icônes, licence ISC) : remplace les émojis.

## Principes

1. **Un espace de travail neutre.** La couleur porte un sens : la cible (vert, orange, rouge), le résultat d'un appel, l'action principale. Rien n'est coloré pour décorer.
2. **Des lignes plutôt que des cartes.** Une liste d'entreprises est une liste : lignes séparées par un trait, barre de couleur à gauche pour la cible. Les panneaux (bordure fine, sans ombre) ne servent qu'à regrouper.
3. **Des icônes, pas d'émojis.** Lucide, 16 px, trait 1,75, couleur du texte secondaire.
4. **La semaine en cours d'abord.** Une seule semaine est affichée ; les semaines passées et les propositions non retenues sont rangées dans un historique, repliées.
5. **Des chiffres alignés.** Chiffres tabulaires ; colonnes numériques alignées à droite.
6. **Un seul élément fort : la barre d'appel.** Pendant une session, une barre sombre façon « appel en cours » affiche la fiche n/N, les appels, les RDV et les points. C'est le seul aplat sombre de l'interface.

## Couleurs

| Jeton | Valeur | Rôle |
|---|---|---|
| `--c-ink` | `#222326` | texte principal, titres |
| `--c-ink-2` | `#5c5f66` | texte secondaire, icônes |
| `--c-ink-3` | `#8c8f96` | méta-données, légendes |
| `--c-canvas` | `#f7f7f8` | fond de l'écran |
| `--c-surface` | `#ffffff` | panneaux, lignes de liste |
| `--c-fill` | `#f2f3f5` | survol, en-têtes de tableau, champs |
| `--c-line` | `#e6e7ea` | traits et séparateurs |
| `--c-line-2` | `#d5d7db` | bordure des champs et boutons |
| `--c-rex` | `#c1122f` | action principale, marque (survol `#a80f28`) |
| `--c-call` | `#13804a` | bouton « Appeler » |
| `--c-bar` | `#1b1e24` | barre d'appel (seul aplat sombre) |

États (texte sur fond clair, contraste ≥ 4,5:1) :

| État | Texte | Fond | Usage |
|---|---|---|---|
| vert | `#16794c` | `#e8f5ee` | cible verte, RDV, succès |
| orange | `#b45309` | `#fdf1e4` | cible orange, attention |
| rouge | `#b42318` | `#fdecea` | cible rouge, refus, erreur |
| bleu | `#1d5fc9` | `#eaf1fd` | rappel, information |

## Typographie

Manrope, la police de RexSeller (déjà installée et mise en cache) : le Commando reste dans la même application. Graisses 500, 600 et 700 seulement. Chiffres tabulaires (`font-variant-numeric: tabular-nums`).

| Taille | Interligne | Usage |
|---|---|---|
| 12 px | 16 px | puces, légendes, méta |
| 13 px | 18 px | texte secondaire, cellules |
| 14 px | 20 px | texte courant de l'interface |
| 15 px | 22 px | nom d'entreprise dans une ligne |
| 17 px | 24 px | titre de section |
| 20 px | 26 px | titre d'écran |
| 26 px | 30 px | chiffres clés |

Pas de majuscules pour les étiquettes, pas de texte centré hors des états vides.

## Espacement, formes, profondeur

- Pas de 4 px : 4, 8, 12, 16, 20, 24, 32.
- Contenu : 960 px de large au plus, marges de 16 px sur téléphone.
- Arrondis : 6 px (boutons, champs), 10 px (panneaux), 14 px (fiche sur téléphone), 999 px (puces d'état seulement).
- Ombres : aucune sur les panneaux ; une seule ombre pour ce qui flotte (fiche, pied de fiche collant).

## Composants

- **Boutons** : principal (rouge plein), secondaire (blanc, bordure), discret (sans bordure). Hauteur 36 px, 44 px pour les actions d'appel. Focus visible (anneau de 2 px).
- **Onglets** : soulignés, avec icône ; défilement horizontal sur téléphone.
- **Ligne d'entreprise** : barre de cible à gauche (3 px), nom en 15 px semi-gras, activité, puis effectif, ville et numéro avec icônes ; état (rappel, déjà appelée) en dernière ligne.
- **Bandeau de chiffres** : un panneau, des cellules séparées par des traits (pas de cartes séparées).
- **Fiche d'appel** : barre d'appel (en session), en-tête, bouton « Appeler » pleine largeur, trame, puis pied collant avec les 4 résultats.
- **Puces** : 12 px, fond teinté, sans bordure.
- **Tableaux** : en-têtes en casse normale, 12 px, sur fond `--c-fill`.
