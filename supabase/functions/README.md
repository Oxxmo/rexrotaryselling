# Edge Functions de RexSeller

| Fonction | Rôle | JWT vérifié par la passerelle | Secrets |
|---|---|---|---|
| `manage-users` | Gestion des comptes depuis la console d'administration | oui | aucun (clés Supabase injectées) |
| `commando-import` | Mise à jour de la base d'entreprises du commando (API Recherche d'entreprises) | **non** (appel du job pg_cron par secret ; JWT vérifié dans le code pour l'appel manuel) | aucun obligatoire (secret partagé lu dans **Vault**) |
| `commando-telephones` | Téléphones gratuits : lieux OpenStreetMap de la Vienne mis en cache (Overpass + Base Adresse Nationale), rapprochement par nom et numéro de voie | **non** (JWT membre pour une fiche, responsable pour les lots ; secret Vault pour le job hebdomadaire) | aucun |
| `commando-veille` | Veille IA hebdomadaire (API Claude + recherche web), en étapes | **non** (JWT + rôle « responsable » vérifiés dans le code ; relances internes par le secret Vault) | `ANTHROPIC_API_KEY` |

Toutes s'exécutent côté serveur avec la clé `service_role`, **jamais** exposée au
navigateur. Les droits sont revérifiés dans le code, pas seulement dans l'interface.

## `manage-users`

Gestion sécurisée des comptes (création, modification, mot de passe, suppression)
depuis la **console d'administration** de l'application, avec les règles hiérarchiques
(un responsable ne gère que son sous-arbre).

| Demandeur | Peut créer / gérer            |
|-----------|-------------------------------|
| RRO       | CA, RO, commerciaux (sa région) |
| CA        | RO, commerciaux (son agence)  |
| RO        | commerciaux (son équipe)      |
| Commercial| — (aucun accès admin)         |

## `commando-import`

Importe les établissements actifs des codes postaux du commando (table
`commando_codes_postaux`) depuis l'API Recherche d'entreprises (api.gouv.fr, gratuite,
sans clé, 25 résultats par page, 7 requêtes/s). Idempotent : relancé deux fois, aucun
doublon (clé SIRET). Les établissements non revus sont archivés, jamais supprimés.

Corps JSON facultatif : `{"codes_postaux": ["86000"], "dry_run": true, "synchrone": true}`.
Un import complet répond `202` et continue en tâche de fond ; la console suit la
ligne `commando_imports`.

Appel automatique : job pg_cron `commando_import_hebdo` (dimanche 20 h UTC) →
`public.commando_cron_import()` → `net.http_post` avec l'en-tête `x-commando-secret`,
dont la valeur est lue dans **Vault** (`commando_cron_secret`). La fonction vérifie
l'en-tête reçu via `public.commando_cron_secret_ok()` (exécutable par `service_role`
seulement) : Vault est la source unique, aucun secret de fonction à poser.

## `commando-veille`

Corps JSON : `{"semaine_id": "…", "type": "veille" | "regeneration" | "fiche_rex", "thematique_id": "…"}`.
Avec `"apercu": true`, renvoie le prompt complet rempli et une estimation de coût **sans
appeler le modèle** (point d'arrêt avant le premier appel réel).

- Modèle paramétré (`commando_parametres.modele`, par défaut `claude-sonnet-5-5`), outil
  `web_search_20260318` (15 recherches au plus), prompt système versionné
  (`_shared/prompt_veille.ts`, copie de `docs/commando/PROMPT_VEILLE.md`).
- Sortie validée par schéma (`_shared/validation.ts`) ; une seule nouvelle tentative ;
  chaque URL citée est comparée aux résultats de recherche réels (badge « vérifiée ») ;
  alerte sans source de moins de 14 jours ; règle avec un champ inconnu rejetée.
- Chaque génération est tracée dans `commando_generations` (modèle, version du prompt,
  prompt envoyé, jetons, recherches, coût estimé, durée, erreurs, réponse allégée).
- Limite de générations par semaine (paramètre, 5 par défaut).
- **Mémoire** : toutes les thématiques des 8 dernières semaines (retenues, non retenues,
  écartées) sont transmises à la veille, et une proposition dont le titre est trop proche
  d'un titre déjà vu (indice de Jaccard sur les mots-clés ≥ 0,5) est refusée.
- **Familles d'offres** (paramètre `familles` : impression, ged, cyber, telephonie,
  informatique → privilégier / neutre / exclure) : la majorité des propositions se
  rattachent aux familles privilégiées, aucune à une famille exclue (refus automatique).
- **Exécution en étapes courtes** (les Edge Functions sont coupées à 150 s sur l'offre
  gratuite, 400 s sur les offres payantes) : étape 1 « recherche » (veille web, propositions
  documentées), puis une étape « rédaction » par thématique (sans recherche, à partir des
  notes), chaque thématique étant enregistrée dès qu'elle est validée. L'état est dans
  `commando_generations.etat` ; le job pg_cron `commando_veille_relance` (toutes les 20 s)
  enchaîne les étapes et relance une étape interrompue (une fois). Comptez 8 à 12 minutes
  pour une veille complète, 3 à 4 pour une régénération, 1 pour la fiche Rex.

Tests : `deno test --allow-read supabase/functions/_shared/validation_test.ts`.

## `commando-telephones`

La base Sirene n'a pas de téléphone. Les serveurs publics Overpass étant souvent saturés,
la fonction travaille en deux temps :

1. **`{"rafraichir": true}`** (responsable, ou pg_cron `commando_osm_hebdo` le lundi à 2 h UTC) :
   une seule requête Overpass sur l'emprise de la Vienne (`phone` ou `contact:phone`,
   `out center`). overpass-api.de refuse (HTTP 406) le User-Agent que le runtime Supabase
   ajoute aux Edge Functions : la requête est donc émise **par la base** via pg_net
   (`commando_osm_demander`), la fonction attend la réponse (`commando_osm_reponse`) et la
   base l'importe elle-même en SQL (`commando_osm_importer`, migration `20261025121100`)
   dans `commando_osm_lieux`. Les deux tiers des lieux n'ont pas de code postal dans OSM : il est
   déduit des coordonnées par le géocodage inverse en masse de la **Base Adresse Nationale**
   (`api-adresse.data.gouv.fr/reverse/csv/`, gratuit, sans clé) et marqué `cp_source = 'ban'`.
   `{"geocoder": true}` relance ce seul complément.
2. **`{"rapprocher": true}`**, **`{"codes_postaux": ["86000"]}`** (responsable) ou
   **`{"siret": "…"}`** (tout membre, depuis la fiche) : rapprochement sans appel externe.
   Noms normalisés (formes juridiques, accents), similarité de mots ≥ 0,6, ou égalité, ou même
   numéro de voie ; `commando_contacts` est rempli (`source = 'osm'`, `site_web`,
   `source_detail`) uniquement pour les fiches sans téléphone saisi. Les codes postaux non
   traités dans le budget de 120 s sont renvoyés dans `non_traites` et la console les renvoie.

Lectures paginées par 1 000 lignes (plafond PostgREST). Données © les contributeurs
OpenStreetMap (ODbL) : l'attribution est affichée dans la fiche.

Tests : `deno test --allow-read supabase/functions/commando-telephones/index_test.ts`.

## Déploiement

### Option A : interface Supabase

Dashboard → **Edge Functions** → **Deploy a new function**, nom exact de la fonction,
coller le contenu de `index.ts` (pour `commando-veille`, créer aussi les fichiers
`_shared/validation.ts` et `_shared/prompt_veille.ts`). Pour `commando-import`, décocher
**Verify JWT** (le job pg_cron s'authentifie par secret).

### Option B : CLI Supabase

```bash
npm i -g supabase
supabase login
supabase link --project-ref chryjpudxhfboutymyvf

supabase functions deploy manage-users
supabase functions deploy commando-import --no-verify-jwt
supabase functions deploy commando-veille --no-verify-jwt
supabase functions deploy commando-telephones --no-verify-jwt
```

### Secrets (une fois)

**Clé API Anthropic** (console.anthropic.com), jamais dans le code ni le navigateur :
Dashboard → **Edge Functions** → **Secrets** → `ANTHROPIC_API_KEY`, ou

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-…
```

**Secret partagé pg_cron → commando-import** : une seule valeur, dans Vault
(éditeur SQL ; valeur aléatoire, ex. `openssl rand -hex 32`) :

```sql
select vault.create_secret('<valeur aléatoire>', 'commando_cron_secret',
                           'Secret partagé pg_cron → commando-import');
```

Rien d'autre à poser : la fonction compare l'en-tête reçu à ce secret Vault.
(Un secret de fonction `COMMANDO_CRON_SECRET` de même valeur reste accepté s'il existe.)

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement.
