/* ============================================================
   Rex Commando — tableau de bord d'efficacité (responsable)
   ------------------------------------------------------------
   Les cibles vertes produisent-elles vraiment plus de rendez-vous ?
   Par couleur, thématique, règle, commercial et semaine : appels,
   RDV pris, taux, RDV honorés. RDV de la semaine face à l'objectif.
   Avertissement « échantillon insuffisant » sous le seuil (30 appels
   par défaut). Export CSV des appels.
   Source : fonction commando_stats (agrégats) et commando_appels_export.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const n = (v) => Number(v || 0);
  const pct = (t) => (t == null ? "—" : Math.round(Number(t) * 100) + " %");
  const COULEUR = { vert: "Vert", orange: "Orange", rouge: "Rouge" };

  let stats = null;
  let periode = "12";   // semaines

  function depuis() {
    if (periode === "tout") return null;
    const d = new Date(); d.setDate(d.getDate() - Number(periode) * 7);
    return d.toISOString().slice(0, 10);
  }

  async function render(el) {
    el.innerHTML = `<div class="cmd-row">
        <h3 class="cmd-h">📊 Efficacité du commando</h3>
        <select id="dashPeriode" class="cmd-sem">
          <option value="4">4 dernières semaines</option><option value="12" selected>12 dernières semaines</option><option value="26">26 dernières semaines</option><option value="tout">Depuis le début</option>
        </select>
        <button id="dashCsv" class="btn btn--sm">⬇️ Exporter les appels (CSV)</button>
      </div>
      <div id="dashBody"></div>`;
    $("#dashPeriode", el).addEventListener("change", (e) => { periode = e.target.value; show(el); });
    $("#dashCsv", el).addEventListener("click", exporterCsv);
  }
  async function show(el) {
    const body = $("#dashBody", el);
    body.innerHTML = `<p class="cmd-empty"><span class="cmd-spin"></span>Calcul…</p>`;
    try { stats = await C().rpc("commando_stats", { _depuis: depuis(), _jusqua: null }); }
    catch (e) { body.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; return; }
    body.innerHTML = rendu(stats);
  }

  function bloc(b) {
    const warn = b.echantillon_insuffisant ? ` <span class="cmd-badge cmd-badge--warn" title="Moins de ${stats.seuil} appels : un taux calculé sur si peu d'appels ne prouve rien">échantillon insuffisant</span>` : "";
    return `<td class="num">${n(b.appels)}</td><td class="num">${n(b.rdv)}</td><td class="num"><b>${pct(b.taux)}</b>${warn}</td><td class="num">${n(b.honores)}</td>`;
  }
  const entete = `<th class="num">Appels</th><th class="num">RDV pris</th><th class="num">Taux de RDV</th><th class="num">RDV honorés</th>`;
  function table(titre, lignes, premiereColonne, intro) {
    return `<div class="cmd-card"><h3>${esc(titre)}</h3>${intro ? `<p class="muted">${intro}</p>` : ""}
      ${lignes.length ? `<div class="tbl-scroll"><table class="grid"><thead><tr>${premiereColonne}${entete}</tr></thead><tbody>${lignes.join("")}</tbody></table></div>` : `<p class="muted">Pas encore de données.</p>`}</div>`;
  }
  function rendu(s) {
    const t = s.total || {};
    const card = (v, l) => `<div class="pilot-card"><div class="pilot-card__val">${v}</div><div class="pilot-card__lbl">${esc(l)}</div></div>`;
    const objectif = n(s.objectif);
    const semaineHtml = (s.semaine_courante_par_commercial || []).map(c => {
      const p = Math.min(100, Math.round(n(c.rdv) / Math.max(1, objectif) * 100));
      return `<div class="dash-obj"><div class="dash-obj__head"><b>${esc(c.nom || "—")}</b><span>${n(c.rdv)} / ${objectif} RDV · ${n(c.appels)} appels</span></div><div class="cmd-progress"><span style="width:${p}%"></span></div></div>`;
    }).join("");
    const couleurs = (s.par_couleur || []).map(c => `<tr><td>${c.couleur ? `<span class="cmd-badge cmd-badge--${esc(c.couleur)}">${COULEUR[c.couleur]}</span>` : `<span class="cmd-badge cmd-badge--gris">Non classée</span>`}</td>${bloc(c)}</tr>`);
    const themes = (s.par_thematique || []).map(x => `<tr><td>${esc(x.titre || "—")} <span class="muted">${esc(x.semaine || "")}</span></td>${bloc(x)}</tr>`);
    const regles = (s.par_regle || []).map(x => `<tr><td>${x.couleur_regle ? `<span class="cmd-badge cmd-badge--${esc(x.couleur_regle)}">${esc(x.couleur_regle)}</span>` : ""} Règle ${n(x.regle_index) + 1} · ${esc(x.titre || "")} <span class="muted">— ${esc(x.raison || "")}</span></td>${bloc(x)}</tr>`);
    const commerciaux = (s.par_commercial || []).map(x => `<tr><td>${esc(x.nom || "—")}</td>${bloc(x)}</tr>`);
    const semaines = (s.par_semaine || []).map(x => `<tr><td>${esc(C().fmtSemaine(x.semaine))}</td>${bloc(x)}</tr>`);
    const csem = (s.par_commercial_semaine || []).map(x => `<tr><td>${esc(x.semaine)} · ${esc(x.nom || "—")}</td>${bloc(x)}</tr>`);
    return `
      <div class="cmd-cards">${card(n(t.appels), "Appels")}${card(n(t.rdv), "RDV pris")}${card(pct(t.taux), "Taux de RDV")}${card(n(t.honores), "RDV honorés")}</div>
      ${t.echantillon_insuffisant ? `<div class="cmd-note">⚠︎ Moins de ${esc(s.seuil)} appels sur la période : les taux ci-dessous ne prouvent encore rien.</div>` : ""}
      <div class="cmd-card"><h3>Semaine ${esc(s.semaine_courante)} : RDV par commercial face à l'objectif (${objectif})</h3>${semaineHtml || `<p class="muted">Aucun commercial membre.</p>`}</div>
      ${table("Par couleur", couleurs, "<th>Couleur</th>", "La question centrale : les cibles vertes donnent-elles plus de RDV que les orange et les rouges ?")}
      ${table("Par thématique", themes, "<th>Thématique</th>")}
      ${table("Par règle de couleur", regles, "<th>Règle</th>", "Chaque règle porte sa raison : celles qui produisent des RDV honorés méritent d'être reprises par la veille suivante.")}
      ${table("Par commercial", commerciaux, "<th>Commercial</th>")}
      ${table("Par semaine", semaines, "<th>Semaine</th>")}
      ${table("Par commercial et par semaine", csem, "<th>Semaine · commercial</th>")}`;
  }

  async function exporterCsv() {
    try {
      const rows = await C().rpc("commando_appels_export");
      const cols = ["date_appel", "semaine", "commercial", "entreprise", "siret", "code_postal", "secteur", "thematique", "couleur", "regle_index", "raison", "statut", "date_rdv", "rdv_statut", "note"];
      const cell = (v) => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const lines = [cols.join(";")].concat((rows || []).map(r => cols.map(c => cell(c === "regle_index" && r[c] != null ? Number(r[c]) + 1 : r[c])).join(";")));
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "rex-commando_appels.csv"; a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { C().toast("Export impossible : " + C().erreur(e)); }
  }

  C().registerTab({ id: "efficacite", label: "📊 Efficacité", roles: ["responsable"], render, onShow: show });
})();
