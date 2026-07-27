/* ============================================================
   Rex Seller — Authentification & accès aux données (Supabase)
   ------------------------------------------------------------
   - Initialise le client Supabase
   - Gère l'écran de connexion (email + mot de passe)
   - Charge le profil, l'équipe visible et les rendez-vous
   - Expose « RexDB » (lecture/écriture) utilisé par app.js
   Le démarrage de l'application (RexApp.boot) n'a lieu QU'APRÈS
   une connexion réussie et le chargement des données.
   ============================================================ */
(function () {
  "use strict";

  const cfg = window.REX_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL) {
    // La bibliothèque ou la configuration n'a pas pu être chargée : on affiche
    // quand même l'écran de connexion avec un message plutôt qu'une page vide.
    const gate = document.getElementById("authGate");
    const err = document.getElementById("authError");
    if (gate) gate.hidden = false;
    document.body.classList.add("locked");
    if (err) { err.hidden = false; err.textContent = "Impossible d'initialiser l'application. Vérifiez votre connexion puis rechargez la page."; }
    console.error("Configuration ou bibliothèque Supabase manquante.");
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  window.rexSupa = sb;

  const $ = (s, r = document) => r.querySelector(s);

  const ROLE_LABEL = {
    rro: "Responsable Régional",
    ca: "Chef d'Agence",
    ro: "Responsable Opérationnel",
    commercial: "Commercial"
  };

  /* ----------------------- État partagé ----------------------- */
  let myProfile = null;
  let teamById = {};

  /* ----------------------- Écran de connexion ----------------------- */
  const gate = $("#authGate");
  const form = $("#authForm");
  const emailEl = $("#authEmail");
  const pwEl = $("#authPassword");
  const errEl = $("#authError");
  const submitBtn = $("#authSubmit");

  function showGate() { if (gate) gate.hidden = false; document.body.classList.add("locked"); }
  function hideGate() { if (gate) gate.hidden = true; document.body.classList.remove("locked"); }
  function setErr(m) { if (!errEl) return; errEl.textContent = m || ""; errEl.hidden = !m; }

  function traduireErreur(msg) {
    const m = (msg || "").toLowerCase();
    if (m.includes("invalid login")) return "Email ou mot de passe incorrect.";
    if (m.includes("email not confirmed")) return "Email non confirmé : vérifiez votre boîte mail.";
    if (m.includes("network")) return "Problème de connexion réseau. Réessayez.";
    return msg || "Une erreur est survenue.";
  }

  /* ----------------------- Couche données (utilisée par app.js) ----------------------- */
  window.RexDB = {
    me() { return myProfile; },
    isManager() { return !!myProfile && myProfile.role !== "commercial"; },
    roleLabel(role) { return ROLE_LABEL[role] || role || ""; },
    authorName(id) {
      const p = teamById[id];
      return p ? (p.full_name || p.email || "—") : "—";
    },
    team() { return Object.values(teamById); },

    async upsertRdv(rdv) {
      const d = rdv.data || {};
      const row = {
        id: rdv.id,
        author_id: rdv.author_id,
        societe: d.societe || "",
        date_rdv: d.date_rdv ? d.date_rdv : null,
        data: d,
        affaire: rdv.affaire || { active: false, data: {} }
      };
      const { error } = await sb.from("rendez_vous").upsert(row);
      if (error) throw error;
    },

    async deleteRdv(id) {
      const { error } = await sb.from("rendez_vous").delete().eq("id", id);
      if (error) throw error;
    },

    /* ---------- Administration des comptes ---------- */
    myRole() { return myProfile ? myProfile.role : null; },
    roleOrder(role) { return ({ rro: 3, ca: 2, ro: 1, commercial: 0 })[role] ?? -1; },
    profiles() { return Object.values(teamById); },

    // Recharge la liste des personnes visibles (soi + sous-arbre).
    async reloadTeam() {
      const { data } = await sb.from("profiles")
        .select("id,full_name,email,role,manager_id,agence").order("full_name");
      teamById = {};
      (data || []).forEach(p => { teamById[p.id] = p; });
      if (myProfile && !teamById[myProfile.id]) teamById[myProfile.id] = myProfile;
      return Object.values(teamById);
    },

    // Appelle l'Edge Function sécurisée « manage-users ».
    async callAdmin(action, payload) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expirée, reconnectez-vous.");
      const res = await fetch(cfg.SUPABASE_URL + "/functions/v1/manage-users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
          "apikey": cfg.SUPABASE_KEY
        },
        body: JSON.stringify(Object.assign({ action }, payload))
      });
      let body = {};
      try { body = await res.json(); } catch (e) { /* réponse vide */ }
      if (!res.ok) throw new Error(body.error || ("Erreur " + res.status));
      return body;
    },

    async signOut() {
      try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
      location.reload();
    }
  };

  /* ----------------------- Chargement + démarrage ----------------------- */
  function mapRow(r) {
    return {
      id: r.id,
      author_id: r.author_id,
      createdAt: Date.parse(r.created_at) || Date.now(),
      updatedAt: Date.parse(r.updated_at) || Date.now(),
      data: r.data || {},
      affaire: r.affaire || { active: false, data: {} }
    };
  }

  async function loadAndStart() {
    setErr("");
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { showGate(); return; }

    // Profil de l'utilisateur
    const { data: prof, error: perr } = await sb
      .from("profiles").select("*").eq("id", user.id).maybeSingle();

    if (perr) { setErr("Erreur de chargement du profil : " + perr.message); showGate(); return; }
    if (!prof) {
      setErr("Votre compte n'est pas encore rattaché à l'organigramme. Contactez votre administrateur.");
      showGate();
      return;
    }
    myProfile = prof;

    // Équipe visible (soi + sous-arbre grâce à la RLS)
    const { data: team } = await sb
      .from("profiles").select("id,full_name,email,role,manager_id").order("full_name");
    teamById = {};
    (team || []).forEach(p => { teamById[p.id] = p; });
    if (!teamById[myProfile.id]) teamById[myProfile.id] = myProfile;

    // Rendez-vous visibles
    const { data: rows, error: rerr } = await sb
      .from("rendez_vous").select("*").order("updated_at", { ascending: false });
    if (rerr) { setErr("Erreur de chargement des rendez-vous : " + rerr.message); showGate(); return; }

    hideGate();
    // Badge utilisateur
    const badge = $("#userBadge");
    if (badge) badge.textContent = `${myProfile.full_name || myProfile.email} · ${ROLE_LABEL[myProfile.role]}`;

    window.RexApp.boot({ profile: myProfile, rdvs: (rows || []).map(mapRow) });
  }

  /* ----------------------- Événements ----------------------- */
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setErr("");
      submitBtn.disabled = true;
      const label = submitBtn.textContent;
      submitBtn.textContent = "Connexion…";
      const { error } = await sb.auth.signInWithPassword({
        email: (emailEl.value || "").trim(),
        password: pwEl.value || ""
      });
      submitBtn.disabled = false;
      submitBtn.textContent = label;
      if (error) { setErr(traduireErreur(error.message)); return; }
      await loadAndStart();
    });
  }

  const btnLogout = $("#btnLogout");
  if (btnLogout) btnLogout.addEventListener("click", () => window.RexDB.signOut());

  /* ----------------------- Amorçage ----------------------- */
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadAndStart();
    else showGate();
  })();
})();
