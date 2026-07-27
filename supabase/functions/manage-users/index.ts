// ============================================================
//  Rex Seller — Edge Function « manage-users »
//  ------------------------------------------------------------
//  Gestion sécurisée des comptes depuis la console d'administration
//  de l'application. Cette fonction s'exécute côté serveur avec la
//  clé « service_role » (jamais exposée au navigateur) et applique
//  les règles hiérarchiques :
//
//   - seul un responsable (rro / ca / ro) peut agir ;
//   - il ne peut créer/modifier que des rôles STRICTEMENT en dessous
//     du sien, et uniquement dans son sous-arbre (organigramme) ;
//   - le responsable (manager_id) choisi doit être lui-même ou une
//     personne de son sous-arbre, d'un rang supérieur à la cible.
//
//  Actions : create | update | reset_password | delete
//
//  Déploiement (voir supabase/functions/README.md).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.8";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rang hiérarchique (plus grand = plus haut)
const ORDER: Record<string, number> = { rro: 3, ca: 2, ro: 1, commercial: 0 };
const ROLES = ["rro", "ca", "ro", "commercial"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- Identification du demandeur ---
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!jwt) return json({ error: "Non authentifié" }, 401);

  const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !userData?.user) return json({ error: "Session invalide" }, 401);
  const callerId = userData.user.id;

  const { data: caller } = await admin
    .from("profiles").select("id, role").eq("id", callerId).single();
  if (!caller) return json({ error: "Profil introuvable" }, 403);
  if (caller.role === "commercial") {
    return json({ error: "Accès réservé aux responsables." }, 403);
  }

  // Le demandeur voit-il cette personne dans son sous-arbre (ou est-ce lui) ?
  async function inSubtree(id: string): Promise<boolean> {
    const { data, error } = await admin.rpc("can_view", { _viewer: callerId, _author: id });
    return !error && data === true;
  }
  async function getProfile(id: string) {
    const { data } = await admin.from("profiles").select("id, role, manager_id").eq("id", id).single();
    return data;
  }

  // Valide le couple (rôle cible, responsable) au regard des droits du demandeur.
  async function validateRoleAndManager(role: string, managerId: string): Promise<string | null> {
    if (!ROLES.includes(role)) return "Rôle invalide.";
    if (ORDER[caller.role] <= ORDER[role]) {
      return "Vous ne pouvez créer/modifier que des rôles inférieurs au vôtre.";
    }
    if (!managerId) return "Le responsable (manager) est obligatoire.";
    const isSelf = managerId === callerId;
    if (!isSelf && !(await inSubtree(managerId))) {
      return "Le responsable choisi n'appartient pas à votre équipe.";
    }
    const mgr = isSelf ? { role: caller.role } : await getProfile(managerId);
    if (!mgr) return "Responsable introuvable.";
    if (ORDER[mgr.role] <= ORDER[role]) {
      return "Le responsable doit avoir un rang supérieur à celui de la personne.";
    }
    return null;
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }
  const action = body?.action;

  try {
    // ---------------------------------------------------------
    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const full_name = String(body.full_name || "").trim();
      const role = String(body.role || "");
      const manager_id = String(body.manager_id || "");
      const agence = body.agence ? String(body.agence).trim() : null;

      if (!email || !password) return json({ error: "Email et mot de passe obligatoires." }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum." }, 400);
      const invalid = await validateRoleAndManager(role, manager_id);
      if (invalid) return json({ error: invalid }, 403);

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });
      if (cErr || !created?.user) {
        return json({ error: "Création impossible : " + (cErr?.message || "inconnue") }, 400);
      }

      // Le trigger a créé le profil (rôle « commercial ») : on le complète.
      const { error: pErr } = await admin.from("profiles")
        .update({ full_name, role, manager_id, agence, email })
        .eq("id", created.user.id);
      if (pErr) {
        // Annule la création du compte auth pour ne pas laisser d'orphelin.
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: "Compte non enregistré : " + pErr.message }, 400);
      }
      return json({ ok: true, id: created.user.id });
    }

    // ---------------------------------------------------------
    if (action === "update") {
      const id = String(body.id || "");
      if (!id) return json({ error: "Identifiant manquant." }, 400);
      if (id === callerId) return json({ error: "Vous ne pouvez pas modifier votre propre compte ici." }, 403);
      if (!(await inSubtree(id))) return json({ error: "Personne hors de votre équipe." }, 403);

      const patch: Record<string, unknown> = {};
      if (body.full_name != null) patch.full_name = String(body.full_name).trim();
      if (body.agence != null) patch.agence = String(body.agence).trim() || null;

      // Changement de rôle / de responsable : re-validation complète.
      if (body.role != null || body.manager_id != null) {
        const target = await getProfile(id);
        if (!target) return json({ error: "Personne introuvable." }, 404);
        const role = String(body.role ?? target.role);
        const manager_id = String(body.manager_id ?? target.manager_id ?? "");
        if (manager_id === id) return json({ error: "Une personne ne peut pas être son propre responsable." }, 400);
        const invalid = await validateRoleAndManager(role, manager_id);
        if (invalid) return json({ error: invalid }, 403);
        patch.role = role;
        patch.manager_id = manager_id;
      }

      if (Object.keys(patch).length === 0) return json({ error: "Rien à modifier." }, 400);
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------------------------------------------------------
    if (action === "reset_password") {
      const id = String(body.id || "");
      const password = String(body.password || "");
      if (!id || !password) return json({ error: "Identifiant et mot de passe requis." }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum." }, 400);
      if (id === callerId) return json({ error: "Utilisez votre profil pour votre propre mot de passe." }, 403);
      if (!(await inSubtree(id))) return json({ error: "Personne hors de votre équipe." }, 403);

      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------------------------------------------------------
    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return json({ error: "Identifiant manquant." }, 400);
      if (id === callerId) return json({ error: "Vous ne pouvez pas supprimer votre propre compte." }, 403);
      if (!(await inSubtree(id))) return json({ error: "Personne hors de votre équipe." }, 403);

      // Supprime le compte auth ; profil et rendez-vous suivent (ON DELETE CASCADE).
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    return json({ error: "Erreur serveur : " + (e as Error).message }, 500);
  }
});
