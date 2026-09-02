/* ============================================================
   Rex Seller — Système de tickets (demandes / bugs)
   ------------------------------------------------------------
   - Tout utilisateur peut créer un ticket (bouton « Signaler »).
   - Seul le développeur dédié (RexDB.isDev()) voit la liste des
     tickets reçus et peut changer leur statut.
   La sécurité réelle est assurée côté base (RLS) ; l'interface ne
   fait que refléter ces droits.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const STATUS = { ouvert: "Ouvert", en_cours: "En cours", resolu: "Résolu" };

  let wired = false;

  function db() { return window.RexDB; }
  function toast(m) { const t = $("#toast"); if (!t) return; t.textContent = m; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2200); }
  function fmtDate(s) { try { return new Date(s).toLocaleString("fr-FR"); } catch (e) { return s || ""; } }

  /* ---------- Création d'un ticket ---------- */
  function openNew() {
    $("#ticketError").hidden = true;
    $("#tk_subject").value = "";
    $("#tk_message").value = "";
    $("#ticketModal").hidden = false;
    document.body.style.overflow = "hidden";
    $("#tk_subject").focus();
  }
  function closeNew() {
    $("#ticketModal").hidden = true;
    document.body.style.overflow = "";
  }
  async function submitNew() {
    const err = $("#ticketError");
    const subject = $("#tk_subject").value.trim();
    const message = $("#tk_message").value.trim();
    if (!subject || !message) {
      err.textContent = "Merci de renseigner l'objet et la description.";
      err.hidden = false;
      return;
    }
    const btn = $("#tk_submit");
    btn.disabled = true;
    const label = btn.textContent; btn.textContent = "Envoi…";
    try {
      await db().createTicket(subject, message);
      closeNew();
      toast("Demande envoyée — merci !");
    } catch (e) {
      err.textContent = "Échec de l'envoi : " + (e.message || e);
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  /* ---------- Liste des tickets (dev) ---------- */
  async function openList() {
    $("#ticketListModal").hidden = false;
    document.body.style.overflow = "hidden";
    $("#ticketList").innerHTML = `<p class="muted">Chargement…</p>`;
    $("#ticketListEmpty").hidden = true;
    try {
      const tickets = await db().listTickets();
      renderList(tickets);
    } catch (e) {
      $("#ticketList").innerHTML = `<p class="auth-error">Erreur de chargement : ${esc(e.message || e)}</p>`;
    }
  }
  function closeList() {
    $("#ticketListModal").hidden = true;
    document.body.style.overflow = "";
  }
  function renderList(tickets) {
    const wrap = $("#ticketList");
    $("#ticketListEmpty").hidden = tickets.length > 0;
    wrap.innerHTML = tickets.map(t => {
      const opts = Object.keys(STATUS).map(s =>
        `<option value="${s}" ${s === t.status ? "selected" : ""}>${esc(STATUS[s])}</option>`).join("");
      return `<div class="ticket-card ticket-card--${esc(t.status)}">
        <div class="ticket-card__head">
          <strong>${esc(t.subject)}</strong>
          <select class="ticket-status" data-id="${t.id}">${opts}</select>
        </div>
        <div class="ticket-card__meta">${esc(t.author_name || "")} · ${esc(t.author_email || "")} · ${esc(fmtDate(t.created_at))}</div>
        <div class="ticket-card__msg">${esc(t.message).replace(/\n/g, "<br>")}</div>
      </div>`;
    }).join("");
    $$(".ticket-status", wrap).forEach(sel => sel.addEventListener("change", async () => {
      try {
        await db().setTicketStatus(sel.dataset.id, sel.value);
        const card = sel.closest(".ticket-card");
        card.className = "ticket-card ticket-card--" + sel.value;
        toast("Statut mis à jour");
      } catch (e) { toast("Échec : " + (e.message || e)); }
    }));
  }

  function wire() {
    if (wired) return; wired = true;
    const bNew = $("#btnTicketNew"); if (bNew) bNew.addEventListener("click", openNew);
    const bList = $("#btnTicketList"); if (bList) bList.addEventListener("click", openList);
    $$("[data-ticket-close]").forEach(el => el.addEventListener("click", closeNew));
    $$("[data-ticketlist-close]").forEach(el => el.addEventListener("click", closeList));
    $("#tk_submit").addEventListener("click", submitNew);
  }

  /* ---------- Appelé par app.js après connexion ---------- */
  window.RexTickets = {
    onBoot() {
      wire();
      const bList = $("#btnTicketList");
      if (bList) bList.hidden = !(db() && db().isDev && db().isDev());
    }
  };
})();
