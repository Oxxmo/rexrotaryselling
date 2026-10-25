/* ============================================================
   Rex Commando — noyau de l'onglet (accès, navigation, données)
   ------------------------------------------------------------
   - Vérifie l'appartenance au commando (table commando_membres :
     zéro ligne pour les autres, grâce à la RLS) et affiche le bouton.
   - Vue plein écran qui remplace le livret, avec des sous-onglets
     enregistrés par les autres modules (commando-console.js, …).
   - Petits utilitaires partagés : RPC, Edge Functions, dates, toasts.
   La sécurité réelle est assurée par la base (RLS + fonctions
   serveur) ; l'interface ne fait que refléter les droits.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const tabs = [];            // { id, label, roles, render(el), onShow(el), el, rendered }
  let membre = null;          // { role } ou null
  let activeId = null;
  let wired = false;
  let pollTimer = null;

  function sb() { return window.rexSupa; }
  function cfg() { return window.REX_CONFIG || {}; }
  function toast(m) { const t = $("#toast"); if (!t) return; t.textContent = m; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2600); }

  /* ---------- Dates ---------- */
  function dateParis() {
    const s = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
    return new Date(s + "T12:00:00Z");
  }
  function semaineIso(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const jour = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - jour);
    const debut = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const n = Math.ceil(((t - debut) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
  }
  // Semaine « du commando » : le dimanche, on prépare déjà la semaine suivante.
  function semaineCible() {
    const d = dateParis();
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return semaineIso(d);
  }
  // Lundi d'une semaine ISO (AAAA-Www) → Date (UTC midi)
  function lundiDe(semaine) {
    const m = /^(\d{4})-W(\d{2})$/.exec(semaine || "");
    if (!m) return null;
    const y = +m[1], w = +m[2];
    const j4 = new Date(Date.UTC(y, 0, 4, 12));
    const lundi1 = new Date(j4); lundi1.setUTCDate(j4.getUTCDate() - ((j4.getUTCDay() || 7) - 1));
    const d = new Date(lundi1); d.setUTCDate(lundi1.getUTCDate() + (w - 1) * 7);
    return d;
  }
  function fmtDate(s) { if (!s) return "—"; try { return new Date(s).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }); } catch (e) { return "—"; } }
  function fmtDateTime(s) { if (!s) return "—"; try { return new Date(s).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; } }
  function fmtSemaine(s) {
    const l = lundiDe(s); if (!l) return s || "—";
    return `${s} · lundi ${l.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  }

  /* ---------- Accès aux données ---------- */
  async function rpc(name, args) {
    const { data, error } = await sb().rpc(name, args || {});
    if (error) throw new Error(error.message || String(error));
    return data;
  }
  // Appel d'une Edge Function avec la session de l'utilisateur.
  async function fn(name, payload) {
    const { data: { session } } = await sb().auth.getSession();
    if (!session) throw new Error("Session expirée, reconnectez-vous.");
    const res = await fetch(cfg().SUPABASE_URL + "/functions/v1/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token, "apikey": cfg().SUPABASE_KEY },
      body: JSON.stringify(payload || {})
    });
    let body = {};
    try { body = await res.json(); } catch (e) { /* vide */ }
    if (!res.ok) throw new Error(body.error || body.erreur || ("Erreur " + res.status));
    return body;
  }
  function erreur(e) { return (e && e.message) ? e.message : String(e); }

  /* ---------- Navigation ---------- */
  function registerTab(tab) {
    tabs.push(Object.assign({ roles: ["responsable", "commercial"], rendered: false }, tab));
  }
  function visibleTabs() {
    if (!membre) return [];
    return tabs.filter(t => t.roles.includes(membre.role));
  }
  function renderNav() {
    const nav = $("#cmdTabs"); if (!nav) return;
    nav.innerHTML = visibleTabs().map(t =>
      `<button class="tab ${t.id === activeId ? "tab--active" : ""}" data-cmd-tab="${esc(t.id)}">${esc(t.label)}</button>`).join("");
    $$("[data-cmd-tab]", nav).forEach(b => b.addEventListener("click", () => show(b.dataset.cmdTab)));
  }
  async function show(id) {
    const tab = visibleTabs().find(t => t.id === id) || visibleTabs()[0];
    if (!tab) return;
    activeId = tab.id;
    const body = $("#cmdBody");
    if (!tab.el) {
      tab.el = document.createElement("div");
      tab.el.className = "cmd__pane";
      tab.el.dataset.pane = tab.id;
      body.appendChild(tab.el);
    }
    $$(".cmd__pane", body).forEach(p => p.classList.toggle("cmd__pane--active", p === tab.el));
    renderNav();
    try { history.replaceState(null, "", location.pathname + location.search + "#commando/" + tab.id); } catch (e) { /* ignoré */ }
    try {
      if (!tab.rendered) { tab.rendered = true; await tab.render(tab.el); }
      if (tab.onShow) await tab.onShow(tab.el);
    } catch (e) {
      tab.el.innerHTML = `<div class="cmd-err">Erreur de chargement : ${esc(erreur(e))}</div>`;
    }
  }
  function open(id) {
    document.body.classList.add("cmd-mode");
    const v = $("#commandoView"); if (v) v.hidden = false;
    const sem = $("#cmdSemaine"); if (sem) sem.textContent = "Semaine " + semaineCible();
    window.scrollTo({ top: 0 });
    show(id || activeId || (visibleTabs()[0] || {}).id);
  }
  function close() {
    document.body.classList.remove("cmd-mode");
    const v = $("#commandoView"); if (v) v.hidden = true;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignoré */ }
    clearInterval(pollTimer); pollTimer = null;
  }
  function wire() {
    if (wired) return; wired = true;
    const b = $("#btnCommando"); if (b) b.addEventListener("click", () => open());
    const back = $("#cmdBack"); if (back) back.addEventListener("click", close);
  }

  /* ---------- Démarrage (appelé par app.js après connexion) ---------- */
  async function onBoot() {
    const me = window.RexDB && window.RexDB.me();
    const btn = $("#btnCommando");
    if (!me || !sb()) { if (btn) btn.hidden = true; return; }
    try {
      const { data } = await sb().from("commando_membres").select("role").eq("user_id", me.id).maybeSingle();
      membre = data || null;
    } catch (e) { membre = null; }
    if (btn) btn.hidden = !membre;
    if (!membre) return;
    wire();
    renderNav();
    // Réouverture directe (lien ou rechargement) : #commando/<onglet>
    const m = /^#commando(?:\/([\w-]+))?/.exec(location.hash || "");
    if (m) open(m[1] || null);
  }

  // Nom affiché d'un profil (équipe visible via RexDB).
  function nomDe(id) {
    if (!id) return "—";
    const p = (window.RexDB.profiles() || []).find(x => x.id === id);
    return p ? (p.full_name || p.email) : "—";
  }
  function prenomDe(id) {
    const n = nomDe(id); return n === "—" ? n : n.split(/\s+/)[0];
  }

  window.RexCommando = {
    registerTab, onBoot, open, close, show, rpc, fn, sb, toast, esc, erreur,
    semaineIso, semaineCible, lundiDe, fmtDate, fmtDateTime, fmtSemaine, nomDe, prenomDe,
    role() { return membre ? membre.role : null; },
    isResponsable() { return !!membre && membre.role === "responsable"; },
    me() { return window.RexDB.me(); },
    // Rafraîchissement périodique tant que l'onglet est ouvert.
    poll(fnc, ms) { clearInterval(pollTimer); pollTimer = setInterval(() => { if (document.body.classList.contains("cmd-mode")) fnc(); }, ms); },
    stopPoll() { clearInterval(pollTimer); pollTimer = null; }
  };
})();
