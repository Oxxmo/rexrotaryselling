# Edge Function `manage-users`

Gestion sécurisée des comptes (création, modification, mot de passe, suppression)
depuis la **console d'administration** de l'application. Le code s'exécute côté
serveur avec la clé secrète `service_role` — **jamais** exposée au navigateur — et
applique les règles hiérarchiques (un responsable ne gère que son sous-arbre).

## Prérequis

- Le schéma `supabase/schema.sql` a déjà été exécuté (tables + fonction `can_view`).

## Déploiement — option A : via l'interface Supabase (le plus simple)

1. Dashboard Supabase → **Edge Functions** → **Deploy a new function** (ou
   *Create function*).
2. Nom exact : **`manage-users`**.
3. Coller le contenu de [`index.ts`](manage-users/index.ts) dans l'éditeur.
4. **Deploy**.

La clé `SUPABASE_SERVICE_ROLE_KEY` et `SUPABASE_URL` sont **injectées
automatiquement** par Supabase : aucun secret à configurer.

## Déploiement — option B : via la CLI Supabase

```bash
# une seule fois
npm i -g supabase
supabase login
supabase link --project-ref chryjpudxhfboutymyvf

# déploiement
supabase functions deploy manage-users
```

## Vérification

Une fois déployée, la fonction est appelée automatiquement par l'application
lorsqu'un responsable ouvre **☰ → Administration** et crée/modifie un compte.
Aucune configuration supplémentaire côté application (l'URL est déduite de
`js/config.js`).

## Règles appliquées par la fonction

| Demandeur | Peut créer / gérer            |
|-----------|-------------------------------|
| RRO       | CA, RO, commerciaux (sa région) |
| CA        | RO, commerciaux (son agence)  |
| RO        | commerciaux (son équipe)      |
| Commercial| — (aucun accès admin)         |

Le responsable (`manager_id`) affecté à une nouvelle personne doit être le
demandeur lui-même ou quelqu'un de son sous-arbre, d'un rang supérieur à la
personne créée.
