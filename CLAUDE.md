# Rex-Rotary — règles du dépôt


## Contexte
- Outils internes de Rex-Rotary Poitiers (revendeur Ricoh). Utilisateurs : commerciaux et managers, surtout sur téléphone, parfois sur PC.
- Je développe depuis Claude Code dans le navigateur : rien à installer sur mon poste de travail.

## Données
- RexSeller et Flash Live PO partagent la même base Supabase et les mêmes comptes.
- Ne jamais modifier les tables existantes profiles, rendez_vous et tickets. Toute nouvelle fonction a ses propres tables.
- Les droits d'accès passent par les règles RLS de Supabase, pas seulement par l'interface.
- Le Flash Live PO est la source du chiffre d'affaires de l'écran de pilotage de l'agence.

## Règles métier
- Exercice d'avril à mars ; août compte pour 0,25 mois.
- Glossaire : NC = nouveau client, UC = up et cross-selling, RNV = renouvellement, PO = prise d'ordre.

## Avant de rendre
- Chaque chiffre affiché doit correspondre à la base ou à l'export, un par un. S'il y a un écart, corrige avant de livrer.
- Tester en mobile et montrer la preuve.
