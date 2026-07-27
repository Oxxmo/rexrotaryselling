/* ============================================================
   Rex Seller — Console d'administration des comptes
   ------------------------------------------------------------
   Réservée aux responsables (RRO / CA / RO). Permet de créer,
   modifier, réinitialiser le mot de passe et supprimer les
   comptes de son équipe. Toutes les opérations passent par
   l'Edge Function sécurisée « manage-users » (RexDB.callAdmin) ;
   les droits sont revérifiés côté serveur.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const ROLE_LABEL = { rro: "Responsable Régional", ca: "Chef d'Agence", ro: "Responsable Opérationnel", commercial: "Commercial" };
  const ROLE_ORDER = ["commercial", "ro", "ca", "rro"];   // du plus bas au plus haut

  let wired = false;
  let editingId = null;   // null = création ; sinon = modification

  function db() { return window.RexDB; }
  function myId() { const me = db().me(); return me ? me.id : null; }
  function nameOf(p) { return (p.full_name || p.email || "—"); }
  function order(role) { return db().roleOrder(role); }

  function setErr(m) { const el = $("#adminError"); if (!el) return; el.textContent = m || ""; el.hidden = !m; }
  function toast(m) { const t = $("#toast"); if (!t) return; t.textContent = m; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2200); }

  /* ---------- Options de rôle : uniquement en dessous du demandeur ---------- */
  function rolesBelowMe() {
    const mine = order(db().myRole());
    return ROLE_ORDER.filter(r => order(r) < mine); // ex. RRO -> [commercial, ro, ca]
  }
  function renderRoleOptions(selected) {
    const sel = $("#adm_role");
    const roles = rolesBelowMe().slice().reverse(); // afficher du plus haut au plus bas
    sel.innerHTML = roles.map(r => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`).join("");
    if (selected && roles.includes(selected)) sel.value = selected;
  }

  /* ---------- Options de responsable : rang strictement supérieur à la cible ---------- */
  function renderManagerOptions(targetRole, selectedId) {
    const sel = $("#adm_manager");
    const o = order(targetRole);
    const mgrs = db().profiles()
      .filter(p => order(p.role) > o)
      .sort((a, b) => order(b.role) - order(a.role) || nameOf(a).localeCompare(nameOf(b)));
    sel.innerHTML = mgrs.map(p =>
      `<option value="${p.id}">${esc(nameOf(p))} · ${esc(ROLE_LABEL[p.role])}</option>`).join("");
    if (selectedId && mgrs.find(p => p.id === selectedId)) sel.value = selectedId;
    else if (mgrs.find(p => p.id === myId())) sel.value = myId(); // par défaut : moi
  }

  /* ---------- Tableau de l'équipe ---------- */
  function renderTeam() {
    const body = $("#adminTeamBody");
    const me = myId();
    const rows = db().profiles()
      .slice()
      .sort((a, b) => order(b.role) - order(a.role) || nameOf(a).localeCompare(nameOf(b)));
    body.innerHTML = rows.map(p => {
      const mgr = p.manager_id ? db().profiles().find(x => x.id === p.manager_id) : null;
      const mgrName = mgr ? esc(nameOf(mgr)) : "—";
      const isSelf = p.id === me;
      const actions = isSelf
        ? `<span class="muted">vous</span>`
        : `<div class="admin-actions">
             <button class="btn btn--ghost btn--sm" data-edit="${p.id}">Modifier</button>
             <button class="btn btn--ghost btn--sm" data-pw="${p.id}">Mot de passe</button>
             <button class="btn btn--danger btn--sm" data-del="${p.id}">Supprimer</button>
           </div>`;
      return `<tr>
        <td>${esc(nameOf(p))}</td>
        <td>${esc(p.email || "")}</td>
        <td>${esc(ROLE_LABEL[p.role] || p.role)}</td>
        <td>${mgrName}</td>
        <td>${actions}</td>
      </tr>`;
    }).join("");

    $$("[data-edit]", body).forEach(b => b.addEventListener("click", () => startEdit(b.dataset.edit)));
    $$("[data-pw]", body).forEach(b => b.addEventListener("click", () => resetPassword(b.dataset.pw)));
    $$("[data-del]", body).forEach(b => b.addEventListener("click", () => removeUser(b.dataset.del)));
  }

  /* ---------- Formulaire : création / édition ---------- */
  function resetForm() {
    editingId = null;
    $("#adminFormTitle").textContent = "Ajouter une personne";
    $("#adm_submit").textContent = "Créer le compte";
    $("#adm_cancel").hidden = true;
    $("#adm_name").value = "";
    $("#adm_email").value = "";
    $("#adm_pw").value = "";
    $("#adm_agence").value = "";
    $("#adm_email").disabled = false;
    $("#adm_pw").closest("label").hidden = false;
    renderRoleOptions();
    renderManagerOptions($("#adm_role").value);
    setErr("");
  }

  function startEdit(id) {
    const p = db().profiles().find(x => x.id === id);
    if (!p) return;
    editingId = id;
    $("#adminFormTitle").textContent = "Modifier « " + nameOf(p) + " »";
    $("#adm_submit").textContent = "Enregistrer les modifications";
    $("#adm_cancel").hidden = false;
    $("#adm_name").value = p.full_name || "";
    $("#adm_email").value = p.email || "";
    $("#adm_email").disabled = true;                 // l'email d'un compte ne se change pas ici
    $("#adm_pw").closest("label").hidden = true;     // le mot de passe a son propre bouton
    $("#adm_agence").value = p.agence || "";
    renderRoleOptions(p.role);
    renderManagerOptions(p.role, p.manager_id);
    setErr("");
    $("#adminModal").querySelector(".modal__body").scrollTop = 0;
  }

  async function submitForm() {
    setErr("");
    const btn = $("#adm_submit");
    const full_name = $("#adm_name").value.trim();
    const role = $("#adm_role").value;
    const manager_id = $("#adm_manager").value;
    const agence = $("#adm_agence").value.trim();

    if (!full_name) { setErr("Le nom est obligatoire."); return; }
    if (!manager_id) { setErr("Choisissez un responsable."); return; }

    btn.disabled = true;
    const label = btn.textContent; btn.textContent = "Enregistrement…";
    try {
      if (editingId) {
        await db().callAdmin("update", { id: editingId, full_name, role, manager_id, agence });
        toast("Compte mis à jour");
      } else {
        const email = $("#adm_email").value.trim().toLowerCase();
        const password = $("#adm_pw").value;
        if (!email) { setErr("L'email est obligatoire."); return; }
        if (password.length < 8) { setErr("Mot de passe : 8 caractères minimum."); return; }
        await db().callAdmin("create", { email, password, full_name, role, manager_id, agence });
        toast("Compte créé");
      }
      await db().reloadTeam();
      renderTeam();
      resetForm();
      if (window.RexApp && window.RexApp.refreshTeamUI) window.RexApp.refreshTeamUI();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  async function resetPassword(id) {
    const p = db().profiles().find(x => x.id === id);
    const pw = window.prompt("Nouveau mot de passe pour « " + (p ? nameOf(p) : "") + " » (8 caractères minimum) :");
    if (pw == null) return;
    if (pw.length < 8) { toast("Mot de passe trop court"); return; }
    try {
      await db().callAdmin("reset_password", { id, password: pw });
      toast("Mot de passe réinitialisé");
    } catch (e) { toast(e.message || "Échec"); }
  }

  async function removeUser(id) {
    const p = db().profiles().find(x => x.id === id);
    if (!window.confirm("Supprimer définitivement le compte de « " + (p ? nameOf(p) : "") +
      " » ?\nSes rendez-vous seront également supprimés.")) return;
    try {
      await db().callAdmin("delete", { id });
      toast("Compte supprimé");
      await db().reloadTeam();
      renderTeam();
      if (editingId === id) resetForm();
      if (window.RexApp && window.RexApp.refreshTeamUI) window.RexApp.refreshTeamUI();
    } catch (e) { toast(e.message || "Échec"); }
  }

  /* ---------- Ouverture / fermeture ---------- */
  async function openAdmin() {
    setErr("");
    try { await db().reloadTeam(); } catch (e) { /* on affiche ce qu'on a */ }
    resetForm();
    renderTeam();
    $("#adminModal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeAdmin() {
    $("#adminModal").hidden = true;
    document.body.style.overflow = "";
  }

  function wire() {
    if (wired) return; wired = true;
    const btn = $("#btnAdmin");
    if (btn) btn.addEventListener("click", openAdmin);
    $$("[data-admin-close]").forEach(el => el.addEventListener("click", closeAdmin));
    $("#adm_role").addEventListener("change", () => renderManagerOptions($("#adm_role").value, $("#adm_manager").value));
    $("#adm_submit").addEventListener("click", submitForm);
    $("#adm_cancel").addEventListener("click", resetForm);
  }

  /* ---------- Appelé par app.js après connexion ---------- */
  window.RexAdmin = {
    onBoot() {
      const btn = $("#btnAdmin");
      const isManager = db() && db().isManager && db().isManager();
      if (btn) btn.hidden = !isManager;
      if (isManager) wire();
    }
  };
})();
