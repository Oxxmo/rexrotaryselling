/* ============================================================
   Rex Commando — console du responsable (partie 2) : la semaine
   ------------------------------------------------------------
   Le lundi matin :
     1. lancer la veille IA (fonction serveur commando-veille) ;
     2. examiner les propositions : sources datées et vérifiées,
        concurrence, règles + aperçu des compteurs, trames, objections,
        hypothèses ;
     3. ajuster (modifier, régénérer, ajouter une thématique manuelle,
        importer un fichier) ;
     4. retenir 3 thématiques et publier (instantané des couleurs).
   Suivi : nouvelles entreprises de la semaine, RDV pris.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const sb = () => C().sb();

  const COULEURS = ["vert", "orange", "rouge"];
  const TRANCHES = { "02": "3 à 5", "03": "6 à 9", "11": "10 à 19", "12": "20 à 49", "21": "50 à 99" };
  const FAMILLES = { impression: "Impression et copieurs", ged: "Gestion documentaire", cyber: "Cybersécurité et réseau", telephonie: "Téléphonie", informatique: "Informatique" };
  const ANC = { moins_3: "moins de 3 ans", "3_5": "3 à 5 ans", plus_5: "plus de 5 ans" };
  const STATUT_LABEL = { proposee: "proposée", retenue: "retenue", ecartee: "écartée" };

  let semaines = [], semaine = null, thematiques = [], generations = [], parametres = null;

  /* ---------- Chargement ---------- */
  async function charger() {
    const [s, p] = await Promise.all([
      sb().from("commando_semaines").select("*").order("semaine", { ascending: false }).limit(16).then(r => r.data || []),
      sb().from("commando_parametres").select("*").eq("id", true).single().then(r => r.data)
    ]);
    semaines = s; parametres = p;
    const cible = C().semaineCible();
    if (!semaine || !semaines.find(x => x.id === semaine.id)) semaine = semaines.find(x => x.semaine === cible) || semaines[0] || null;
    else semaine = semaines.find(x => x.id === semaine.id);
    if (semaine) {
      const [t, g] = await Promise.all([
        sb().from("commando_thematiques").select("*").eq("semaine_id", semaine.id).order("ordre").then(r => r.data || []),
        sb().from("commando_generations").select("*").eq("semaine_id", semaine.id).order("lancee_le", { ascending: false }).then(r => r.data || [])
      ]);
      thematiques = t; generations = g;
    } else { thematiques = []; generations = []; }
  }

  /* ---------- Rendu principal ---------- */
  async function render(el) {
    el.innerHTML = `<div id="semHead"></div><div id="semVeille"></div><div id="semProps"></div><div id="semPub"></div><div id="semSuivi"></div>`;
  }
  async function show(el) {
    await charger();
    rendreTete(el);
    rendreVeille(el);
    rendrePropositions(el);
    rendrePublication(el);
    await rendreSuivi(el);
    if (generations.some(g => g.statut === "en_cours")) C().poll(() => show(el), 5000); else C().stopPoll();
  }
  function rendreTete(el) {
    const cible = C().semaineCible();
    const existe = semaines.find(s => s.semaine === cible);
    $("#semHead", el).innerHTML = `<div class="cmd-row">
      <h3 class="cmd-h">📅 Semaine du commando</h3>
      <select id="semSelect" class="cmd-sem">${semaines.map(s => `<option value="${s.id}" ${semaine && s.id === semaine.id ? "selected" : ""}>${esc(C().fmtSemaine(s.semaine))} · ${s.statut === "publiee" ? "publiée" : "brouillon"}</option>`).join("")}</select>
      ${existe ? "" : `<button id="semCreer" class="btn btn--primary btn--sm">＋ Préparer la semaine ${esc(cible)}</button>`}
    </div>`;
    const sel = $("#semSelect", el);
    if (sel) sel.addEventListener("change", () => { semaine = semaines.find(s => s.id === sel.value); show(el); });
    const cr = $("#semCreer", el);
    if (cr) cr.addEventListener("click", async () => {
      const { data, error } = await sb().from("commando_semaines").insert({ semaine: cible }).select().single();
      if (error) { C().toast("Échec : " + error.message); return; }
      semaine = data; C().toast("Semaine créée (brouillon)"); show(el);
    });
  }

  /* ---------- Veille IA ---------- */
  function coutMois() {
    const debut = new Date(); debut.setDate(1); debut.setHours(0, 0, 0, 0);
    return generations.filter(g => new Date(g.lancee_le) >= debut).reduce((a, g) => a + Number(g.cout_estime || 0), 0);
  }
  function rendreVeille(el) {
    const box = $("#semVeille", el);
    if (!semaine) { box.innerHTML = `<div class="cmd-card"><p class="cmd-empty">Aucune semaine. Cliquez sur « Préparer la semaine » pour commencer.</p></div>`; return; }
    const enCours = generations.find(g => g.statut === "en_cours");
    const nbSemaine = generations.filter(g => g.type !== "fiche_rex").length;
    const limite = Number((parametres || {}).limite_generations_semaine || 5);
    const fiche = parametres && parametres.fiche_rex && parametres.fiche_rex_validee_le;
    box.innerHTML = `<div class="cmd-card">
      <h3>Veille IA</h3>
      <p class="muted">La veille cherche l'actualité des 14 derniers jours, la relie aux offres de la fiche Rex et propose 5 thématiques avec règles de ciblage et trames. Modèle : ${esc((parametres || {}).modele || "")}. Générations cette semaine : ${nbSemaine} / ${limite}.</p>
      ${fiche ? "" : `<div class="cmd-note">La fiche Rex-Rotary n'est pas encore validée. Lancez d'abord « Rédiger la fiche Rex » (recherche sur le site public), puis corrigez et validez la fiche dans Paramètres. La veille hebdomadaire n'utilise que la fiche validée.</div>`}
      <div id="veilleMsg"></div>
      <div class="cmd-row">
        <button id="veilleLancer" class="btn btn--primary btn--sm" ${enCours || !fiche || nbSemaine >= limite ? "disabled" : ""}>🔎 Lancer la veille (5 propositions)</button>
        <button id="veilleFiche" class="btn btn--sm" ${enCours ? "disabled" : ""}>📝 Rédiger la fiche Rex (brouillon)</button>
        <button id="veilleImporter" class="btn btn--ghost btn--sm">⬆️ Importer un fichier de thématiques</button>
        <input type="file" id="veilleFichier" accept="application/json,.json" hidden />
        <button id="veilleManuelle" class="btn btn--ghost btn--sm">✍️ Ajouter une thématique à la main</button>
      </div>
      ${generations.length ? `<div class="tbl-scroll" style="margin-top:10px"><table class="grid"><thead><tr><th>Lancée</th><th>Type</th><th>État</th><th>Modèle</th><th class="num">Jetons</th><th class="num">Recherches</th><th class="num">Coût</th><th class="num">Durée</th><th>Erreur</th></tr></thead><tbody>
        ${generations.map(g => `<tr><td>${esc(C().fmtDateTime(g.lancee_le))}</td><td>${esc(g.type)}</td><td>${g.statut === "en_cours" ? `<span class="cmd-badge cmd-badge--info"><span class="cmd-spin"></span>en cours${g.etat && g.etat.total ? ` · étape ${esc(g.etat.etape || 1)}/${esc(g.etat.total)}` : ""}</span>${g.etat && g.etat.libelle ? `<div class="muted" style="font-size:.78rem;margin-top:3px">${esc(g.etat.libelle)}${g.etat.note ? " · " + esc(g.etat.note) : ""}</div>` : ""}` : g.statut === "erreur" ? `<span class="cmd-badge cmd-badge--err">erreur</span>` : `<span class="cmd-badge cmd-badge--ok">terminée</span>`}</td><td>${esc(g.modele || "")} v${esc(g.prompt_version || "")}</td><td class="num">${Number(g.jetons_entree || 0) + Number(g.jetons_sortie || 0) || "—"}</td><td class="num">${g.nb_recherches ?? "—"}</td><td class="num">${g.cout_estime != null ? Number(g.cout_estime).toFixed(2) + " $" : "—"}</td><td class="num">${g.duree_ms ? Math.round(g.duree_ms / 1000) + " s" : "—"}</td><td class="muted">${esc(g.erreur || "")}</td></tr>`).join("")}
      </tbody></table></div><p class="muted" style="margin-top:6px">Coût du mois (toutes semaines chargées) : ${coutMois().toFixed(2)} $.</p>` : ""}
    </div>`;
    $("#veilleLancer", el).addEventListener("click", () => lancerVeille(el, { type: "veille" }, "Veille lancée en 6 étapes (recherche, puis une thématique à la fois) : comptez 8 à 12 minutes. Les propositions apparaissent au fur et à mesure, la page se met à jour toute seule."));
    $("#veilleFiche", el).addEventListener("click", () => {
      if (!confirm("Rédiger un brouillon de fiche Rex-Rotary à partir du site public ? Vous le corrigerez ensuite dans Paramètres.")) return;
      lancerVeille(el, { type: "fiche_rex" }, "Rédaction du brouillon en cours (1 à 2 minutes).");
    });
    $("#veilleImporter", el).addEventListener("click", () => $("#veilleFichier", el).click());
    $("#veilleFichier", el).addEventListener("change", (e) => importerFichier(el, e.target.files[0]));
    $("#veilleManuelle", el).addEventListener("click", () => ouvrirEdition(el, null));
  }
  async function lancerVeille(el, payload, libelle) {
    const msg = $("#veilleMsg", el);
    msg.innerHTML = `<div class="cmd-note"><span class="cmd-spin"></span>${esc(libelle)}</div>`;
    try {
      await C().fn("commando-veille", Object.assign({ semaine_id: semaine.id }, payload));
      await show(el);
    } catch (e) {
      msg.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`;
    }
  }
  async function importerFichier(el, f) {
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const json = JSON.parse(String(r.result));
        if (!json.semaine) json.semaine = semaine ? semaine.semaine : C().semaineCible();
        const id = await C().rpc("commando_importer_thematiques", { _json: json });
        C().toast("Thématiques importées");
        semaine = null; await charger(); semaine = semaines.find(s => s.id === id) || semaine; await show(el);
      } catch (e) { C().toast("Import impossible : " + C().erreur(e)); }
    };
    r.readAsText(f);
    $("#veilleFichier", el).value = "";
  }

  /* ---------- Propositions ---------- */
  function sourceHtml(s) {
    const d = s.date ? C().fmtDate(s.date) : "sans date";
    const recent = s.date && (Date.now() - new Date(s.date).getTime()) <= 14 * 86400000;
    const badge = s.verifiee === true ? `<span class="cmd-badge cmd-badge--ok">vérifiée</span>` : `<span class="cmd-badge cmd-badge--warn">non vérifiée</span>`;
    const url = /^https?:\/\//i.test(s.url || "") ? s.url : "";
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.titre || s.url)}</a>` : esc(s.titre || "(sans URL)")} <span class="muted">· ${esc(d)}${recent ? "" : " · plus de 14 jours"}</span> ${badge}</li>`;
  }
  function regleHtml(r, i) {
    const si = r.si || {};
    const conds = [];
    if (si.naf_prefixes) conds.push("NAF " + si.naf_prefixes.join(" ou "));
    if (si.naf_exclus) conds.push("sauf NAF " + si.naf_exclus.join(", "));
    if (si.tranches) conds.push("effectif " + si.tranches.map(t => TRANCHES[t] || t).join(" ou "));
    if (si.anciennete) conds.push("ancienneté " + si.anciennete.map(a => ANC[a] || a).join(" ou "));
    return `<li><span class="cmd-badge cmd-badge--${esc(r.couleur)}">${esc(r.couleur)}</span> <b>Règle ${i + 1}</b> : ${esc(conds.join(" et ") || "toutes les entreprises")} <span class="muted">— ${esc(r.raison || "")}</span></li>`;
  }
  function trameHtml(t) {
    const trames = t.trames || {};
    return COULEURS.map(c => {
      const tr = trames[c]; if (!tr) return `<div class="cmd-trame cmd-trame--${c}"><p class="muted">Pas de trame ${c}.</p></div>`;
      return `<div class="cmd-trame cmd-trame--${c}">
        <div class="cmd-trame__bloc"><b>${c} · accroche</b><p>${esc(tr.accroche || "")}</p></div>
        ${(tr.questions_decouverte || []).length ? `<div class="cmd-trame__bloc"><b>questions</b><ol>${tr.questions_decouverte.map(q => `<li>${esc(q)}</li>`).join("")}</ol></div>` : ""}
        ${tr.argument ? `<div class="cmd-trame__bloc"><b>argument</b><p>${esc(tr.argument)}</p></div>` : ""}
        ${tr.conclusion ? `<div class="cmd-trame__bloc"><b>conclusion</b><p>${esc(tr.conclusion)}</p></div>` : ""}
      </div>`;
    }).join("");
  }
  function propositionHtml(t) {
    const conc = t.concurrence || {};
    const alertes = (t.alertes || []).concat((t.sources || []).every(s => !s.date || (Date.now() - new Date(s.date).getTime()) > 14 * 86400000) ? ["Aucune source datée de moins de 14 jours"] : []);
    const nbVerif = (t.sources || []).filter(s => s.verifiee === true).length;
    return `<div class="cmd-card cmd-prop cmd-prop--${esc(t.statut)}" data-id="${t.id}">
      <div class="cmd-prop__head">
        <div>
          <span class="cmd-badge ${t.statut === "retenue" ? "cmd-badge--ok" : t.statut === "ecartee" ? "cmd-badge--gris" : "cmd-badge--info"}">${esc(STATUT_LABEL[t.statut] || t.statut)}</span>
          <span class="cmd-badge">${t.origine === "ia" ? "IA" : "manuelle"}</span>
          ${t.famille ? `<span class="cmd-badge cmd-badge--info">${esc(FAMILLES[t.famille] || t.famille)}</span>` : ""}
          ${t.modifiee_le ? `<span class="cmd-badge">modifiée le ${esc(C().fmtDate(t.modifiee_le))}</span>` : ""}
        </div>
        <div class="admin-actions">
          ${t.statut !== "retenue" ? `<button class="btn btn--primary btn--sm" data-statut="retenue">✔︎ Retenir</button>` : `<button class="btn btn--sm" data-statut="proposee">↩︎ Ne plus retenir</button>`}
          ${t.statut !== "ecartee" ? `<button class="btn btn--ghost btn--sm" data-statut="ecartee">Écarter</button>` : `<button class="btn btn--ghost btn--sm" data-statut="proposee">Reproposer</button>`}
          <button class="btn btn--ghost btn--sm" data-edit>✏️ Modifier</button>
          ${t.origine === "ia" ? `<button class="btn btn--ghost btn--sm" data-regen>🔁 Régénérer</button>` : ""}
          <button class="btn btn--danger btn--sm" data-del>Supprimer</button>
        </div>
      </div>
      <h3>${esc(t.titre)}</h3>
      <p class="muted"><b>Offre Rex :</b> ${esc(t.offre_rex || "—")}</p>
      <p><b>Pourquoi maintenant :</b> ${esc(t.pourquoi_maintenant || "")}</p>
      ${alertes.length ? `<div class="cmd-err">⚠︎ ${alertes.map(esc).join(" · ")}</div>` : ""}
      <h4>Sources (${nbVerif}/${(t.sources || []).length} vérifiées)</h4>
      ${(t.sources || []).length ? `<ul class="cmd-sources">${t.sources.map(sourceHtml).join("")}</ul>` : `<p class="muted">Aucune source.</p>`}
      <h4>Concurrence</h4>
      <p><b>Constat :</b> ${esc(conc.constat || "—")}</p>
      <p><b>Angle Rex :</b> ${esc(conc.angle_rex || "—")}</p>
      ${(conc.sources || []).length ? `<ul class="cmd-sources">${conc.sources.map(sourceHtml).join("")}</ul>` : ""}
      <h4>Règles de couleur <button class="btn btn--ghost btn--sm" data-apercu>📊 Aperçu des compteurs</button></h4>
      <ol class="cmd-regles">${(t.regles || []).map(regleHtml).join("")}</ol>
      <div class="cmd-apercu" data-apercu-box hidden></div>
      <details><summary>Trames d'appel par couleur</summary>${trameHtml(t)}</details>
      <details><summary>Objections (${(t.objections || []).length})</summary>${(t.objections || []).map(o => `<div class="cmd-obj__item"><b>« ${esc(o.objection)} »</b><p>${esc(o.reponse)}</p></div>`).join("") || "<p class='muted'>Aucune.</p>"}</details>
      <details><summary>Hypothèses (${(t.hypotheses || []).length}) — à distinguer des faits</summary><ul>${(t.hypotheses || []).map(h => `<li>${esc(h)}</li>`).join("") || "<li class='muted'>Aucune.</li>"}</ul></details>
    </div>`;
  }
  function rendrePropositions(el) {
    const box = $("#semProps", el);
    if (!semaine) { box.innerHTML = ""; return; }
    if (!thematiques.length) { box.innerHTML = `<div class="cmd-card"><p class="cmd-empty">Aucune proposition pour cette semaine. Lancez la veille, importez un fichier ou ajoutez une thématique à la main.</p></div>`; return; }
    const ordre = { retenue: 0, proposee: 1, ecartee: 2 };
    const tri = thematiques.slice().sort((a, b) => (ordre[a.statut] - ordre[b.statut]) || (a.ordre - b.ordre));
    box.innerHTML = `<h3 class="cmd-h" style="margin:14px 0 8px">Propositions (${thematiques.filter(t => t.statut === "retenue").length} retenue(s) sur 3)</h3>` + tri.map(propositionHtml).join("");
    $$(".cmd-prop", box).forEach(card => {
      const id = card.dataset.id; const t = thematiques.find(x => x.id === id);
      $$("[data-statut]", card).forEach(b => b.addEventListener("click", () => changerStatut(el, t, b.dataset.statut)));
      $("[data-edit]", card).addEventListener("click", () => ouvrirEdition(el, t));
      $("[data-del]", card).addEventListener("click", async () => {
        if (!confirm(`Supprimer la thématique « ${t.titre} » ?`)) return;
        const { error } = await sb().from("commando_thematiques").delete().eq("id", id);
        if (error) { C().toast("Échec : " + error.message); return; }
        C().toast("Thématique supprimée"); show(el);
      });
      const rg = $("[data-regen]", card);
      if (rg) rg.addEventListener("click", () => {
        if (!confirm("Régénérer uniquement cette proposition par la veille IA ? L'actuelle sera remplacée.")) return;
        lancerVeille(el, { type: "regeneration", thematique_id: id }, "Régénération en 2 étapes (recherche, puis rédaction) : 3 à 4 minutes.");
      });
      $("[data-apercu]", card).addEventListener("click", async () => {
        const b = $("[data-apercu-box]", card);
        b.hidden = false; b.innerHTML = `<span class="cmd-spin"></span>Calcul…`;
        try { b.innerHTML = apercuHtml(await C().rpc("commando_apercu_compteurs", { _thematique_id: id })); }
        catch (e) { b.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; }
      });
    });
  }
  function apercuHtml(a) {
    const ps = (a && a.par_secteur) || {}; const tot = (a && a.total) || {};
    const ligne = (code, c) => `<tr><td><b>${esc(code)}</b></td><td class="num">${Number(c.vert || 0)}</td><td class="num">${Number(c.orange || 0)}</td><td class="num">${Number(c.rouge || 0)}</td><td class="num">${Number(c.non_classee || 0)}</td><td class="num">${Number(c.total || 0)}</td></tr>`;
    const alerte = Number(tot.non_classee || 0) > Number(tot.total || 0) * 0.3 ? `<div class="cmd-note">⚠︎ ${Number(tot.non_classee || 0)} entreprises non classées : les règles laissent des trous.</div>` : "";
    return `${alerte}<div class="tbl-scroll"><table class="grid"><thead><tr><th>Secteur</th><th class="num">Vert</th><th class="num">Orange</th><th class="num">Rouge</th><th class="num">Non classées</th><th class="num">Total</th></tr></thead><tbody>
      ${Object.entries(ps).sort().map(([k, v]) => ligne(k, v)).join("")}${ligne("Total", tot).replace("<tr>", '<tr class="total">')}</tbody></table></div>`;
  }
  async function changerStatut(el, t, statut) {
    if (statut === "retenue" && thematiques.filter(x => x.statut === "retenue").length >= 3) { C().toast("3 thématiques sont déjà retenues : libérez-en une d'abord."); return; }
    const { error } = await sb().from("commando_thematiques").update({ statut, modifiee_par: C().me().id, modifiee_le: new Date().toISOString() }).eq("id", t.id);
    if (error) { C().toast("Échec : " + error.message); return; }
    show(el);
  }

  /* ---------- Édition / création ---------- */
  let editEl = null;
  function ouvrirEdition(el, t) {
    const v = t || { titre: "", offre_rex: "", pourquoi_maintenant: "", sources: [], concurrence: { constat: "", angle_rex: "", sources: [] }, regles: [{ couleur: "vert", si: { tranches: ["02", "03"] }, raison: "" }], trames: { vert: { accroche: "", questions_decouverte: [], argument: "", conclusion: "" }, orange: { accroche: "", questions_decouverte: [], argument: "", conclusion: "" }, rouge: { accroche: "", questions_decouverte: [], argument: "", conclusion: "" } }, objections: [], hypotheses: [] };
    if (!editEl) { editEl = document.createElement("div"); editEl.className = "modal"; editEl.id = "editThemeModal"; document.body.appendChild(editEl); }
    const js = (o) => esc(JSON.stringify(o, null, 2));
    editEl.innerHTML = `<div class="modal__backdrop" data-edit-close></div>
      <div class="modal__panel"><div class="modal__header"><h2>${t ? "Modifier la thématique" : "Nouvelle thématique (manuelle)"}</h2><button class="modal__close" data-edit-close>✕</button></div>
      <div class="modal__body"><div id="editErr"></div>
        <form id="editForm" class="cmd-form">
          <label class="wide">Titre<input name="titre" value="${esc(v.titre)}" required /></label>
          <label>Offre Rex associée<input name="offre_rex" value="${esc(v.offre_rex)}" /></label>
          <label>Clé (identifiant court)<input name="cle" value="${esc(v.cle || "")}" placeholder="ex. facturation-electronique" /></label>
          <label class="wide">Pourquoi maintenant<textarea name="pourquoi_maintenant" rows="3">${esc(v.pourquoi_maintenant)}</textarea></label>
          <label>Concurrence : constat<textarea name="constat" rows="3">${esc((v.concurrence || {}).constat || "")}</textarea></label>
          <label>Concurrence : angle Rex<textarea name="angle_rex" rows="3">${esc((v.concurrence || {}).angle_rex || "")}</textarea></label>
          <label class="wide">Sources (JSON : [{"url","titre","date"}])<textarea name="sources" rows="4" class="mono">${js(v.sources || [])}</textarea></label>
          <label class="wide">Règles (JSON, évaluées dans l'ordre ; champs : naf_prefixes, naf_exclus, tranches, anciennete)<textarea name="regles" rows="8" class="mono">${js(v.regles || [])}</textarea></label>
          <label class="wide">Trames (JSON : vert / orange / rouge, chacune accroche, questions_decouverte, argument, conclusion)<textarea name="trames" rows="12" class="mono">${js(v.trames || {})}</textarea></label>
          <label class="wide">Objections (JSON : [{"objection","reponse"}])<textarea name="objections" rows="5" class="mono">${js(v.objections || [])}</textarea></label>
          <label class="wide">Hypothèses (une par ligne)<textarea name="hypotheses" rows="3">${esc((v.hypotheses || []).join("\n"))}</textarea></label>
          <div class="wide cmd-row"><button type="submit" class="btn btn--primary">Enregistrer</button><button type="button" class="btn btn--ghost" data-edit-close>Annuler</button></div>
        </form></div></div>`;
    editEl.hidden = false; document.body.style.overflow = "hidden";
    $$("[data-edit-close]", editEl).forEach(x => x.addEventListener("click", fermerEdition));
    $("#editForm", editEl).addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target; const err = $("#editErr", editEl);
      let sources, regles, trames, objections;
      try {
        sources = JSON.parse(f.sources.value || "[]"); regles = JSON.parse(f.regles.value || "[]");
        trames = JSON.parse(f.trames.value || "{}"); objections = JSON.parse(f.objections.value || "[]");
      } catch (ex) { err.innerHTML = `<div class="cmd-err">JSON invalide : ${esc(ex.message)}</div>`; return; }
      const row = {
        titre: f.titre.value.trim(), offre_rex: f.offre_rex.value.trim(), cle: f.cle.value.trim() || null,
        pourquoi_maintenant: f.pourquoi_maintenant.value.trim(),
        concurrence: Object.assign({}, (t && t.concurrence) || {}, { constat: f.constat.value.trim(), angle_rex: f.angle_rex.value.trim() }),
        sources: sources.map(s => Object.assign({ verifiee: false }, s)), regles, trames, objections,
        hypotheses: f.hypotheses.value.split(/\n/).map(s => s.trim()).filter(Boolean),
        modifiee_par: C().me().id, modifiee_le: new Date().toISOString()
      };
      if (!row.titre) { err.innerHTML = `<div class="cmd-err">Le titre est obligatoire.</div>`; return; }
      // Validation des règles côté base (même fonction que la contrainte CHECK)
      try {
        const msg = await C().rpc("commando_valider_regles", { _regles: regles });
        if (msg) { err.innerHTML = `<div class="cmd-err">${esc(msg)}</div>`; return; }
      } catch (ex) { /* la contrainte CHECK tranchera */ }
      let res;
      if (t) res = await sb().from("commando_thematiques").update(row).eq("id", t.id);
      else res = await sb().from("commando_thematiques").insert(Object.assign(row, { semaine_id: semaine.id, origine: "manuelle", statut: "proposee", ordre: thematiques.length + 1 }));
      if (res.error) { err.innerHTML = `<div class="cmd-err">${esc(res.error.message)}</div>`; return; }
      fermerEdition(); C().toast("Thématique enregistrée"); show(el);
    });
  }
  function fermerEdition() { if (editEl) editEl.hidden = true; document.body.style.overflow = ""; }

  /* ---------- Publication ---------- */
  function rendrePublication(el) {
    const box = $("#semPub", el);
    if (!semaine) { box.innerHTML = ""; return; }
    const nb = thematiques.filter(t => t.statut === "retenue").length;
    box.innerHTML = `<div class="cmd-card">
      <h3>Publication</h3>
      ${semaine.statut === "publiee" ? `<div class="cmd-ok">Semaine publiée le ${esc(C().fmtDateTime(semaine.publiee_le))} par ${esc(C().nomDe(semaine.publiee_par))}. Les couleurs sont figées ; les commerciaux voient leurs listes.</div>` : `<p class="muted">À la publication, chaque entreprise reçoit une couleur figée pour chacune des 3 thématiques retenues, et les listes apparaissent chez les commerciaux.</p>`}
      <div id="pubMsg"></div>
      <div class="cmd-row">
        <button id="pubBtn" class="btn btn--primary" ${nb !== 3 ? "disabled" : ""}>🚀 ${semaine.statut === "publiee" ? "Republier (recalculer les couleurs)" : "Publier la semaine"} — ${nb}/3 retenues</button>
      </div>
    </div>`;
    $("#pubBtn", el).addEventListener("click", async () => {
      if (!confirm(semaine.statut === "publiee" ? "Recalculer l'instantané des couleurs ? Possible uniquement si aucun appel n'a encore été enregistré." : "Publier la semaine et figer les couleurs ?")) return;
      const msg = $("#pubMsg", el);
      try {
        const r = await C().rpc("commando_publier", { _semaine_id: semaine.id });
        msg.innerHTML = `<div class="cmd-ok">Publié : ${Number(r.entreprises)} entreprises · vert ${Number(r.vert)} · orange ${Number(r.orange)} · rouge ${Number(r.rouge)} · non classées ${Number(r.non_classee)} (sur 3 thématiques).</div>`;
        await charger(); rendreTete(el); rendrePublication(el); $("#pubMsg", el).innerHTML = msg.innerHTML;
      } catch (e) { msg.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; }
    });
  }

  /* ---------- Suivi : nouvelles entreprises, RDV ---------- */
  async function rendreSuivi(el) {
    const box = $("#semSuivi", el);
    if (!semaine) { box.innerHTML = ""; return; }
    const [{ data: nouvelles }, { data: rdvs }] = await Promise.all([
      sb().from("commando_entreprises_v").select("siret, raison_sociale, naf_libelle, tranche_effectif, annee_effectif, commune, secteur_code, est_client, exclu_le").eq("nouvelle_semaine", semaine.semaine).is("archived_at", null).order("raison_sociale").limit(300),
      sb().from("commando_appels").select("id, siret, commercial_id, date_rdv, rdv_statut, note, created_at, couleur_au_moment").eq("semaine_id", semaine.id).eq("statut", "rdv").order("date_rdv")
    ]);
    const sirets = (rdvs || []).map(a => a.siret);
    let noms = {};
    if (sirets.length) {
      const { data } = await sb().from("commando_entreprises").select("siret, raison_sociale").in("siret", sirets);
      (data || []).forEach(e => { noms[e.siret] = e.raison_sociale; });
    }
    const RDV = { prevu: "prévu", honore: "honoré", annule: "annulé", reporte: "reporté" };
    box.innerHTML = `<div class="cmd-card">
      <h3>RDV pris cette semaine (${(rdvs || []).length})</h3>
      ${(rdvs || []).length ? `<div class="tbl-scroll"><table class="grid"><thead><tr><th>Entreprise</th><th>Commercial</th><th>Date du RDV</th><th>État</th><th>Couleur</th><th>Note</th></tr></thead><tbody>
        ${rdvs.map(a => `<tr><td>${esc(noms[a.siret] || a.siret)}</td><td>${esc(C().nomDe(a.commercial_id))}</td><td>${esc(C().fmtDateTime(a.date_rdv))}</td><td><span class="cmd-badge ${a.rdv_statut === "honore" ? "cmd-badge--ok" : a.rdv_statut === "annule" ? "cmd-badge--err" : ""}">${esc(RDV[a.rdv_statut] || "")}</span></td><td>${a.couleur_au_moment ? `<span class="cmd-badge cmd-badge--${a.couleur_au_moment}">${a.couleur_au_moment}</span>` : ""}</td><td class="muted">${esc(a.note || "")}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Aucun RDV pris pour le moment.</p>`}
    </div>
    <div class="cmd-card">
      <h3>Nouvelles entreprises de la semaine (${(nouvelles || []).length})</h3>
      <p class="muted">Apparues au dernier import. Vous pouvez en exclure définitivement des listes d'appel.</p>
      ${(nouvelles || []).length ? `<div class="tbl-scroll"><table class="grid"><thead><tr><th>Entreprise</th><th>Activité</th><th>Effectif</th><th>Commune</th><th>Secteur</th><th></th></tr></thead><tbody>
        ${nouvelles.map(e => `<tr data-siret="${esc(e.siret)}"><td>${esc(e.raison_sociale)}${e.est_client ? ' <span class="cmd-badge">client</span>' : ""}</td><td>${esc(e.naf_libelle || "")}</td><td>${esc(TRANCHES[e.tranche_effectif] || e.tranche_effectif || "?")}${e.annee_effectif ? ` (${e.annee_effectif})` : ""}</td><td>${esc(e.commune || "")}</td><td>${esc(e.secteur_code || "")}</td><td>${e.exclu_le ? `<span class="cmd-badge cmd-badge--gris">exclue</span>` : `<button class="btn btn--ghost btn--sm" data-exclure>Exclure</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Aucune nouvelle entreprise cette semaine.</p>`}
    </div>`;
    $$("[data-exclure]", box).forEach(b => b.addEventListener("click", async () => {
      const tr = b.closest("tr"); const raison = prompt("Raison de l'exclusion (facultatif) :") ;
      if (raison === null) return;
      const { error } = await sb().from("commando_entreprises").update({ exclu_le: new Date().toISOString(), exclu_par: C().me().id, exclu_raison: raison || null }).eq("siret", tr.dataset.siret);
      if (error) { C().toast("Échec : " + error.message); return; }
      C().toast("Entreprise exclue"); rendreSuivi(el);
    }));
  }

  C().registerTab({ id: "semaine", label: "📅 Semaine", roles: ["responsable"], render, onShow: show });
})();
