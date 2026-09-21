/* ============================================================
   Rex Seller — Outil de pilotage (responsables & admin)
   ------------------------------------------------------------
   Affiche l'utilisation de l'application :
     - une vue d'ensemble (totaux) ;
     - le détail par consultant (RDV, activité récente, affaires…).
   Les données proviennent de la fonction « usage_stats » qui ne
   renvoie que des agrégats — jamais le contenu des rendez-vous.
   Portée : son équipe pour un responsable, l'ensemble pour l'admin.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const ROLE_LABEL = { rro: "Responsable Régional", ca: "Chef d'Agence", ro: "Responsable Opérationnel", commercial: "Commercial" };
  let wired = false;
  let rows = [];

  function db() { return window.RexDB; }
  function nameOf(p) { return p.full_name || p.email || "—"; }
  function fmtDate(s) {
    if (!s) return "—";
    try { return new Date(s).toLocaleDateString("fr-FR"); } catch (e) { return "—"; }
  }
  // Nombre de jours depuis la dernière activité (null si aucune).
  function daysSince(s) {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function renderCards() {
    const actifs = rows.filter(r => (r.nb_30j || 0) > 0).length;
    const tot = rows.reduce((a, r) => a + Number(r.nb_rdv || 0), 0);
    const t30 = rows.reduce((a, r) => a + Number(r.nb_30j || 0), 0);
    const t7 = rows.reduce((a, r) => a + Number(r.nb_7j || 0), 0);
    const aff = rows.reduce((a, r) => a + Number(r.nb_affaires || 0), 0);
    const card = (v, l) => `<div class="pilot-card"><div class="pilot-card__val">${v}</div><div class="pilot-card__lbl">${esc(l)}</div></div>`;
    $("#pilotCards").innerHTML =
      card(tot, "RDV au total") +
      card(t30, "RDV sur 30 jours") +
      card(t7, "RDV sur 7 jours") +
      card(aff, "Affaires levées") +
      card(`${actifs}/${rows.length}`, "Consultants actifs (30 j)");
  }

  function renderTable() {
    const body = $("#pilotBody");
    if (!rows.length) { body.innerHTML = `<tr><td colspan="7" class="muted">Aucune donnée.</td></tr>`; return; }
    body.innerHTML = rows.map(r => {
      const d = daysSince(r.dernier_rdv);
      const inactif = (d === null || d > 30);
      return `<tr>
        <td>${esc(nameOf(r))}</td>
        <td>${esc(ROLE_LABEL[r.role] || r.role || "")}</td>
        <td class="num">${Number(r.nb_rdv || 0)}</td>
        <td class="num">${Number(r.nb_30j || 0)}</td>
        <td class="num">${Number(r.nb_7j || 0)}</td>
        <td class="num">${Number(r.nb_affaires || 0)}</td>
        <td class="${inactif ? "pilot-inactif" : ""}">${esc(fmtDate(r.dernier_rdv))}</td>
      </tr>`;
    }).join("");
  }

  // Export CSV pour une analyse hors application.
  function exportCsv() {
    const head = ["Nom", "Role", "RDV total", "RDV 30j", "RDV 7j", "Affaires", "Champs moyens", "Derniere activite"];
    const lines = [head.join(";")].concat(rows.map(r => [
      nameOf(r), ROLE_LABEL[r.role] || r.role || "",
      r.nb_rdv || 0, r.nb_30j || 0, r.nb_7j || 0, r.nb_affaires || 0,
      String(r.champs_moyen || 0).replace(".", ","),
      r.dernier_rdv ? fmtDate(r.dernier_rdv) : ""
    ].join(";")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rex-seller_pilotage.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function open() {
    $("#pilotageModal").hidden = false;
    document.body.style.overflow = "hidden";
    $("#pilotCards").innerHTML = "";
    $("#pilotBody").innerHTML = `<tr><td colspan="7" class="muted">Chargement…</td></tr>`;
    try {
      rows = await db().usageStats();
      // Les comptes jamais utilisés restent visibles, en bas de liste.
      rows.sort((a, b) => Number(b.nb_rdv || 0) - Number(a.nb_rdv || 0) || nameOf(a).localeCompare(nameOf(b)));
      renderCards();
      renderTable();
    } catch (e) {
      $("#pilotBody").innerHTML = `<tr><td colspan="7" class="auth-error">Erreur de chargement : ${esc(e.message || e)}</td></tr>`;
    }
  }
  function close() {
    $("#pilotageModal").hidden = true;
    document.body.style.overflow = "";
  }

  function wire() {
    if (wired) return; wired = true;
    const b = $("#btnPilotage"); if (b) b.addEventListener("click", open);
    $$("[data-pilotage-close]").forEach(el => el.addEventListener("click", close));
    const x = $("#pilotExport"); if (x) x.addEventListener("click", exportCsv);
  }

  /* ---------- Appelé par app.js après connexion ---------- */
  window.RexPilotage = {
    onBoot() {
      wire();
      const b = $("#btnPilotage");
      // Réservé aux responsables (RO/CA/RRO) et à l'administrateur.
      const allowed = !!db() && ((db().isManager && db().isManager()) || (db().isDev && db().isDev()));
      if (b) b.hidden = !allowed;
    }
  };
})();
