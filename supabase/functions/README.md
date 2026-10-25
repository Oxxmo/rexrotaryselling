# Edge Functions de RexSeller

| Fonction | Rôle | JWT vérifié par la passerelle | Secrets |
|---|---|---|---|
| `manage-users` | Gestion des comptes depuis la console d'administration | oui | aucun (clés Supabase injectées) |
| `commando-import` | Mise à jour de la base d'entreprises du commando (API Recherche d'entreprises) | **non** (appel du job pg_cron par secret ; JWT vérifié dans le code pour l'appel manuel) | `COMMANDO_CRON_SECRET` |
| `commando-veille` | Veille IA hebdomadaire (API Claude + recherche web) | oui (et rôle « responsable » revérifié dans le code) | `ANTHROPIC_API_KEY` |

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
dont la valeur est lue dans **Vault** (`commando_cron_secret`).

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

Tests : `deno test --allow-read supabase/functions/_shared/validation_test.ts`.

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
supabase functions deploy commando-veille
```

### Secrets (une fois)

```bash
# Clé API Anthropic (console.anthropic.com) : jamais dans le code ni le navigateur
supabase secrets set ANTHROPIC_API_KEY=sk-ant-…

# Secret partagé pg_cron → commando-import (valeur aléatoire, ex. openssl rand -hex 32)
supabase secrets set COMMANDO_CRON_SECRET=…
```

Puis, dans l'éditeur SQL, la **même valeur** dans Vault :

```sql
select vault.create_secret('<la même valeur>', 'commando_cron_secret',
                           'Secret partagé pg_cron → commando-import');
```

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement.
