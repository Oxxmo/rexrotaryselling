/* ============================================================
   Rex Commando — onglet « Vote » (tous les membres)
   ------------------------------------------------------------
   Le lundi matin, le responsable soumet les sujets de la semaine au vote
   (onglet Semaine). Chaque commercial choisit ses sujets préférés ici,
   jusqu'à l'heure de clôture, et peut changer d'avis. Les résultats lui
   sont montrés une fois son vote enregistré. Le responsable suit le vote
   en direct (participation, classement, commentaires).
   Une pastille signale le vote à faire sur le bouton « Commando » de la
   barre du haut, et l'onglet Vote s'ouvre en premier tant qu'il attend.
   Source : fonctions commando_vote_etat et commando_voter.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const FAMILLES = { impression: "Impression et copieurs", ged: "Gestion documentaire", cyber: "Cybersécurité et réseau", telephonie: "Téléphonie", informatique: "Informatique" };

  let etat = null;            // dernier état renvoyé par commando_vote_etat
  let choix = new Set();      // sélection en cours (commercial)
  let commentaire = "";
  let modifie = false;        // sélection modifiée et pas encore enregistrée
  let paneEl = null;

  /* ---------- Outils ---------- */
  function heureFin(ts) {
    try {
      return new Date(ts).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function restant(ts) {
    const ms = new Date(ts).getTime() - Date.now();
    if (ms <= 0) return "clôture en cours";
    const min = Math.round(ms / 60000);
    if (min < 60) return `encore ${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return `encore ${h} h${m ? String(m).padStart(2, "0") : ""}`;
  }
  const estCommercial = () => C().role() === "commercial";

  /* ---------- Pastille « à faire » ---------- */
  function signaler() {
    const aFaire = !!(etat && etat.vote && etat.ouvert && !etat.a_vote && estCommercial());
    const btn = $("#btnCommando");
    if (btn) {
      let dot = btn.querySelector(".appbar__dot");
      if (aFaire && !dot) { dot = document.createElement("span"); dot.className = "appbar__dot"; dot.textContent = "🗳️ à voter"; btn.appendChild(dot); }
      if (!aFaire && dot) dot.remove();
      btn.title = aFaire ? "Rex Commando : un vote des sujets vous attend" : "Rex Commando";
    }
    const ouvert = !!(etat && etat.vote && etat.ouvert);
    C().setLabel("vote", aFaire ? "🗳️ Vote · à faire" : ouvert ? "🗳️ Vote en cours" : "🗳️ Vote");
    C().preferer(aFaire ? "vote" : null);
  }
  async function charger() {
    try { etat = await C().rpc("commando_vote_etat", { _semaine_id: null }); }
    catch (e) { etat = null; }
    if (!modifie) {
      choix = new Set((etat && etat.mes_choix) || []);
      commentaire = (etat && etat.mon_commentaire) || "";
    }
  }

  /* ---------- Rendu ---------- */
  function sujetHtml(s, max, voir) {
    const choisi = choix.has(s.id);
    const ouvert = etat.ouvert && estCommercial();
    const plein = !choisi && choix.size >= etat.nb_choix;
    const total = Math.max(1, Number((etat.participation || {}).votants || 0));
    const pct = s.votes != null ? Math.round(Number(s.votes) / total * 100) : 0;
    const retenu = !etat.ouvert && s.statut === "retenue";
    return `<div class="cmd-vote__sujet ${choisi ? "cmd-vote__sujet--choisi" : ""} ${retenu ? "cmd-vote__sujet--retenu" : ""}" data-sujet="${esc(s.id)}">
      <div class="cmd-vote__tete">
        <div>
          ${s.famille ? `<span class="cmd-badge cmd-badge--info">${esc(FAMILLES[s.famille] || s.famille)}</span>` : ""}
          ${retenu ? `<span class="cmd-badge cmd-badge--ok">✔︎ retenu</span>` : ""}
          ${voir && s.rang ? `<span class="cmd-badge">n° ${esc(s.rang)}</span>` : ""}
          <h4>${esc(s.titre)}</h4>
        </div>
        ${ouvert ? `<button class="btn ${choisi ? "btn--primary" : "btn--ghost"} btn--sm" data-choisir="${esc(s.id)}" ${plein ? "disabled title=\"Retirez d'abord un autre choix\"" : ""}>${choisi ? "★ Mon choix" : "☆ Je vote"}</button>` : ""}
      </div>
      ${s.pourquoi_maintenant ? `<p class="cmd-vote__pourquoi">${C().gras(s.pourquoi_maintenant)}</p>` : ""}
      ${(s.points_cles || []).length ? `<ul class="cmd-trame__cles">${s.points_cles.map(k => `<li>${C().gras(k)}</li>`).join("")}</ul>` : ""}
      ${s.accroche || s.argument ? `<details class="cmd-vote__detail"><summary>Voir l'accroche et l'argument (cible verte)</summary>
        ${s.accroche ? `<p><b>Accroche</b> ${C().gras(s.accroche)}</p>` : ""}${s.argument ? `<p><b>Argument</b> ${C().gras(s.argument)}</p>` : ""}
        ${s.offre_rex ? `<p class="muted"><b>Offre Rex</b> ${esc(s.offre_rex)}</p>` : ""}</details>` : ""}
      ${voir && s.votes != null ? `<div class="cmd-vote__res"><div class="cmd-vote__barre"><span style="width:${pct}%"></span></div>
        <span class="cmd-vote__nb"><b>${esc(s.votes)}</b> vote${Number(s.votes) > 1 ? "s" : ""}${etat.responsable && (s.votants || []).length ? ` · ${esc(s.votants.map(id => C().prenomDe(id)).join(", "))}` : ""}</span></div>` : ""}
    </div>`;
  }
  function resultatHtml() {
    const r = etat.resultat;
    if (etat.ouvert) return "";
    if (etat.en_cloture) return `<div class="cmd-note"><span class="cmd-spin"></span>Clôture en cours (moins d'une minute) : les sujets les plus votés vont être retenus.</div>`;
    if (!r) return "";
    const retenus = (etat.sujets || []).filter(s => s.statut === "retenue").map(s => s.titre);
    let txt = retenus.length === 3 ? `Sujets retenus : <b>${retenus.map(esc).join("</b>, <b>")}</b>.` : "Le responsable choisit les sujets retenus.";
    if (r.publie) txt += " La semaine est publiée : vos listes sont prêtes dans « Ma liste ».";
    let extra = "";
    if (etat.responsable && r.note) extra += `<div class="muted">${esc(r.note)}</div>`;
    if (etat.responsable && r.erreur_publication) extra += `<div class="cmd-err">Publication automatique impossible : ${esc(r.erreur_publication)}. Publiez depuis l'onglet Semaine.</div>`;
    return `<div class="cmd-ok">🗳️ Vote clos le ${esc(C().fmtDateTime(etat.clos_le))}. ${txt}</div>${extra}`;
  }
  function dessiner() {
    const el = paneEl; if (!el) return;
    const body = $("#voteBody", el);
    if (!etat || !etat.vote) {
      body.innerHTML = `<div class="cmd-card"><h3>🗳️ Vote des sujets</h3><p class="cmd-empty">${C().isResponsable()
        ? "Aucun vote en cours. Le lundi, soumettez les sujets de la semaine au vote depuis l'onglet « Semaine » (bloc « Vote de l'équipe »)."
        : "Pas de vote en cours. Quand le responsable soumettra les sujets de la semaine, vous pourrez choisir vos préférés ici."}</p></div>`;
      return;
    }
    const p = etat.participation || {};
    const voir = !!etat.resultats_visibles;
    const ouvertCommercial = etat.ouvert && estCommercial();
    const statut = etat.ouvert
      ? `<span class="cmd-badge cmd-badge--warn">ouvert</span> Clôture <b>${esc(heureFin(etat.fin))}</b> · ${esc(restant(etat.fin))}`
      : `<span class="cmd-badge cmd-badge--gris">clos</span>`;
    body.innerHTML = `<div class="cmd-card cmd-vote">
        <div class="cmd-row"><h3 class="cmd-h">🗳️ Vote des sujets · ${esc(C().fmtSemaine(etat.semaine))}</h3><span class="grow"></span>
          <span class="muted">${esc(p.votants || 0)} / ${esc(p.commerciaux || 0)} commerciaux ont voté</span></div>
        <p>${statut}</p>
        ${etat.message ? `<div class="cmd-bandeau">💬 <b>Le responsable</b> : ${esc(etat.message)}</div>` : ""}
        ${ouvertCommercial ? `<p class="muted">Choisissez jusqu'à <b>${esc(etat.nb_choix)}</b> sujet${etat.nb_choix > 1 ? "s" : ""} que vous avez envie d'appeler cet après-midi. Vous pouvez changer d'avis jusqu'à la clôture.${voir ? "" : " Les résultats s'affichent une fois votre vote enregistré."}</p>` : ""}
        ${resultatHtml()}
      </div>
      <div class="cmd-vote__liste">${(etat.sujets || []).map(s => sujetHtml(s, etat.nb_choix, voir)).join("")}</div>
      ${ouvertCommercial ? `<div class="cmd-card cmd-vote__valider">
        <label>Un mot pour le responsable <span class="muted">(facultatif)</span>
          <textarea id="voteCommentaire" rows="2" maxlength="500" placeholder="Pourquoi ces sujets, un retour de vos clients…">${esc(commentaire)}</textarea></label>
        <div class="cmd-row">
          <button id="voteValider" class="btn btn--primary" ${choix.size ? "" : "disabled"}>${etat.a_vote ? "Mettre à jour mon vote" : "Valider mon vote"} (${choix.size}/${esc(etat.nb_choix)})</button>
          <span id="voteMsg" class="muted">${etat.a_vote && !modifie ? "✔︎ Vote enregistré, modifiable jusqu'à la clôture." : modifie ? "Choix non enregistré." : ""}</span>
        </div></div>` : ""}
      ${etat.responsable ? `<div class="cmd-card"><h3>Commentaires de l'équipe</h3>
        ${(etat.votants || []).filter(v => v.commentaire).length ? `<ul class="cmd-hist">${etat.votants.filter(v => v.commentaire).map(v => `<li><b>${esc(C().prenomDe(v.commercial_id))}</b> : ${esc(v.commentaire)}</li>`).join("")}</ul>` : `<p class="muted">Aucun commentaire pour le moment.</p>`}
        <p class="muted">Ont voté : ${(etat.votants || []).map(v => esc(C().prenomDe(v.commercial_id))).join(", ") || "personne pour l'instant"}. Pilotage (échéance, clôture, retenue) dans l'onglet « Semaine ».</p></div>` : ""}`;

    $$("[data-choisir]", body).forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.choisir;
      if (choix.has(id)) choix.delete(id);
      else if (choix.size < etat.nb_choix) choix.add(id);
      modifie = true;
      dessiner();
    }));
    const ta = $("#voteCommentaire", body);
    if (ta) ta.addEventListener("input", () => { commentaire = ta.value; modifie = true; const m = $("#voteMsg", body); if (m) m.textContent = "Choix non enregistré."; });
    const v = $("#voteValider", body);
    if (v) v.addEventListener("click", voter);
  }

  async function voter() {
    const b = $("#voteValider", paneEl); if (b) b.disabled = true;
    const premierVote = !etat.a_vote;
    try {
      etat = await C().rpc("commando_voter", { _semaine_id: etat.semaine_id, _thematiques: Array.from(choix), _commentaire: commentaire || null });
      modifie = false;
      choix = new Set(etat.mes_choix || []);
      commentaire = etat.mon_commentaire || "";
      C().toast(premierVote ? "Vote enregistré, merci ! Les résultats s'affichent." : "Vote mis à jour");
    } catch (e) { C().toast(C().erreur(e)); }
    dessiner(); signaler();
  }

  /* ---------- Onglet ---------- */
  async function render(el) {
    paneEl = el;
    el.innerHTML = `<div id="voteBody"><p class="cmd-empty"><span class="cmd-spin"></span>Chargement…</p></div>`;
  }
  async function show(el) {
    paneEl = el;
    await charger(); dessiner(); signaler();
    // Rafraîchi toutes les 20 s (compte à rebours, participation, résultats), sauf pendant une saisie.
    C().poll(async () => {
      if (modifie || (document.activeElement && document.activeElement.id === "voteCommentaire")) return;
      await charger(); dessiner(); signaler();
    }, 20000);
  }
  C().registerTab({ id: "vote", label: "🗳️ Vote", render, onShow: show });

  // Au démarrage puis toutes les 2 minutes : pastille sur le bouton Commando.
  let timer = null;
  C().apresBoot(async () => {
    await charger(); signaler();
    clearInterval(timer);
    timer = setInterval(async () => { if (!modifie) { await charger(); signaler(); } }, 120000);
  });
})();
