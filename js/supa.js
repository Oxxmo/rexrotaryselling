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

  // Écran « première connexion » (définition du mot de passe personnel)
  const pwGate = $("#pwGate");
  const pwForm = $("#pwForm");
  const pwNew = $("#pwNew");
  const pwNew2 = $("#pwNew2");
  const pwError = $("#pwError");
  const pwSubmit = $("#pwSubmit");
  function showPwGate() { if (gate) gate.hidden = true; if (pwGate) pwGate.hidden = false; document.body.classList.add("locked"); }
  function hidePwGate() { if (pwGate) pwGate.hidden = true; document.body.classList.remove("locked"); }
  function setPwErr(m) { if (!pwError) return; pwError.textContent = m || ""; pwError.hidden = !m; }

  function traduireErreur(msg) {
    const m = (msg || "").toLowerCase();
    if (m.includes("invalid login")) return "Email ou mot de passe incorrect.";
    if (m.includes("email not confirmed")) return "Email non confirmé : vérifiez votre boîte mail.";
    if (m.includes("different from the old")) return "Choisissez un mot de passe différent du mot de passe provisoire.";
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

    /* ---------- Présentation personnelle (Rex-Rotary) ---------- */
    getPresentation() { return (myProfile && myProfile.presentation) || ""; },
    async savePresentation(text) {
      if (!myProfile) throw new Error("Non connecté.");
      const { error } = await sb.from("profiles")
        .update({ presentation: text }).eq("id", myProfile.id);
      if (error) throw error;
      myProfile.presentation = text;
    },

    /* ---------- Tickets (demandes / bugs) ---------- */
    isDev() { return !!(myProfile && myProfile.is_dev); },

    async createTicket(subject, message) {
      if (!myProfile) throw new Error("Non connecté.");
      const row = {
        author_id: myProfile.id,
        author_name: myProfile.full_name || myProfile.email,
        author_email: myProfile.email,
        subject: subject,
        message: message
      };
      const { error } = await sb.from("tickets").insert(row);
      if (error) throw error;
    },

    async listTickets() {
      const { data, error } = await sb.from("tickets")
        .select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },

    async setTicketStatus(id, status) {
      const { error } = await sb.from("tickets").update({ status }).eq("id", id);
      if (error) throw error;
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
    // Session locale (lecture immédiate, disponible même hors ligne).
    let user = null;
    try {
      const { data: { session } } = await sb.auth.getSession();
      user = session && session.user;
    } catch (e) { /* ignoré */ }
    if (!user) { showGate(); return; }
    if (window.RexOffline) window.RexOffline.init(user.id);

    try {
      // Profil de l'utilisateur
      const { data: prof, error: perr } = await sb
        .from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (perr) throw perr;
      if (!prof) {
        setErr("Votre compte n'est pas encore rattaché à l'organigramme. Contactez votre administrateur.");
        showGate();
        return;
      }
      myProfile = prof;

      // Première connexion : le compte a été créé avec un mot de passe
      // provisoire → l'utilisateur doit définir son propre mot de passe.
      if (myProfile.must_change_password) { showPwGate(); return; }

      if (window.RexOffline) window.RexOffline.cacheProfile(myProfile);

      // Équipe visible (soi + sous-arbre grâce à la RLS)
      const { data: team } = await sb
        .from("profiles").select("id,full_name,email,role,manager_id,agence").order("full_name");
      teamById = {};
      (team || []).forEach(p => { teamById[p.id] = p; });
      if (!teamById[myProfile.id]) teamById[myProfile.id] = myProfile;

      // Rendez-vous visibles
      const { data: rows, error: rerr } = await sb
        .from("rendez_vous").select("*").order("updated_at", { ascending: false });
      if (rerr) throw rerr;

      hideGate();
      setBadge(myProfile, false);
      window.RexApp.boot({ profile: myProfile, rdvs: (rows || []).map(mapRow) });
    } catch (e) {
      console.error("Démarrage en ligne impossible :", e);
      // Repli hors-ligne : si l'appareil dispose du cache de cet utilisateur,
      // on ouvre l'application à partir des données locales (RDV perso).
      if (window.RexOffline && window.RexOffline.hasCache(user.id) && window.RexOffline.cachedProfile()) {
        const cp = window.RexOffline.cachedProfile();
        myProfile = cp;
        teamById = {}; teamById[cp.id] = cp;
        hideGate();
        setBadge(cp, true);
        window.RexApp.boot({ profile: cp, rdvs: window.RexOffline.ownCachedRdvs(), offline: true });
        return;
      }
      // Sinon, écran de connexion avec message (jamais de page blanche).
      showGate();
      setErr("Connexion au serveur impossible pour le moment. Vérifiez votre connexion, puis réessayez.");
    }
  }

  function setBadge(p, offline) {
    const badge = $("#userBadge");
    if (badge) badge.textContent = `${p.full_name || p.email} · ${ROLE_LABEL[p.role]}${offline ? " (hors ligne)" : ""}`;
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

  // Définition du mot de passe personnel (première connexion)
  if (pwForm) {
    pwForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setPwErr("");
      const p1 = pwNew.value || "", p2 = pwNew2.value || "";
      if (p1.length < 8) { setPwErr("Le mot de passe doit contenir au moins 8 caractères."); return; }
      if (p1 !== p2) { setPwErr("Les deux mots de passe ne correspondent pas."); return; }
      pwSubmit.disabled = true;
      const label = pwSubmit.textContent; pwSubmit.textContent = "Enregistrement…";
      try {
        const { error } = await sb.auth.updateUser({ password: p1 });
        if (error) { setPwErr(traduireErreur(error.message)); return; }
        // Lève le marqueur pour ne plus redemander.
        if (myProfile) {
          await sb.from("profiles").update({ must_change_password: false }).eq("id", myProfile.id);
          myProfile.must_change_password = false;
        }
        hidePwGate();
        pwNew.value = ""; pwNew2.value = "";
        await loadAndStart();
      } catch (err) {
        setPwErr("Une erreur est survenue. Réessayez.");
      } finally {
        pwSubmit.disabled = false; pwSubmit.textContent = label;
      }
    });
  }

  const btnLogout = $("#btnLogout");
  if (btnLogout) btnLogout.addEventListener("click", () => window.RexDB.signOut());

  /* ----------------------- Amorçage ----------------------- */
  (async () => {
    // Filet de sécurité : si le démarrage n'aboutit pas (serveur injoignable
    // ou trop lent), on bascule sur l'écran de connexion au lieu de rester
    // sur une page vide.
    const watchdog = setTimeout(() => {
      if (document.body.classList.contains("booting")
          && $("#authGate").hidden && $("#pwGate").hidden) {
        showGate();
        setErr("Le serveur met trop de temps à répondre. Vérifiez votre connexion, puis réessayez.");
      }
    }, 12000);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) await loadAndStart();
      else showGate();
    } catch (e) {
      console.error(e);
      showGate();
    } finally {
      clearTimeout(watchdog);
    }
  })();
})();
