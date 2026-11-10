/* ============================================================
   Rex Commando — onglet « Ligue » (tous les membres)
   ------------------------------------------------------------
   Classement en direct de la semaine par points (barème dans Paramètres),
   avec appels, RDV pris, taux, RDV honorés validés par le responsable,
   fiches gagnées, relevé de points et ajustements du responsable. Badges :
   Ouvreur (premier RDV de la semaine), Marathonien (le plus d'appels),
   Sniper (meilleur taux, 10 appels au moins), Fidèle (le plus de RDV
   honorés validés sur les 4 semaines précédentes ; il reçoit 10 fiches
   du secteur libre à la publication). Premier RDV de chaque créneau.
   Rafraîchi toutes les 10 s quand l'onglet est ouvert ; petit son à
   chaque nouveau RDV (désactivable, mémorisé sur l'appareil).
   Source : fonction commando_ligue.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const n = (v) => Number(v || 0);

  const BADGES = {
    ouvreur:     { icone: "medal",  nom: "Ouvreur",     aide: "premier RDV de la semaine" },
    marathonien: { icone: "timer",  nom: "Marathonien", aide: "le plus d'appels" },
    sniper:      { icone: "target", nom: "Sniper",      aide: "meilleur taux de RDV (10 appels au moins)" },
    fidele:      { icone: "award",  nom: "Fidèle",      aide: "le plus de RDV honorés validés sur les semaines précédentes : il choisit en premier ses fiches du secteur libre" },
  };
  const ic = (x) => C().ic(x);

  let semaines = [], semaine = null, dernierTotal = null, releveOuvert = false;
  const TYPES = {
    appel: "Appel", rdv: "RDV pris", rdv_annule: "RDV annulé", rdv_honore: "RDV honoré validé", premier_rdv: "Premier RDV de l'heure",
    pronostic: "Pronostic tenu", badge: "Badge", mail: "Mail de suivi", vote: "Vote des sujets", ajustement: "Ajustement du responsable", depense: "Utilisation",
  };
  let son = false;
  try { son = localStorage.getItem("rex.ligue.son") === "1"; } catch (e) { /* privé */ }

  function heure(ts) {
    try { return new Date(ts).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; }
  }
  function creneauLabel(ts) {
    const d = new Date(ts);
    const h = Number(d.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit" }).slice(0, 2));
    const jour = d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "short", day: "numeric", month: "short" });
    return `${jour}, ${h}h–${h + 1}h`;
  }
  function bip() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [[880, 0], [1175, 0.12]].forEach(([f, t]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = "sine"; g.gain.value = 0.08;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
      });
    } catch (e) { /* audio indisponible */ }
  }

  function bareme(b) {
    return `Barème : appel <b>${esc(b.appel ?? 1)}</b>, RDV pris <b>${esc(b.rdv ?? 10)}</b>, RDV honoré validé <b>${esc(b.rdv_honore ?? 25)}</b>, premier RDV de l'heure <b>${esc(b.premier_rdv ?? 15)}</b>, mail de suivi <b>${esc(b.mail ?? 5)}</b>, vote des sujets <b>${esc(b.vote ?? 3)}</b>, pronostic tenu <b>${esc(b.pronostic ?? 10)}</b>, badge <b>${esc(b.badge ?? 20)}</b>.`;
  }
  async function chargerReleve(el) {
    const box = $("#ligueReleve", el); if (!box || !semaine) return;
    const { data, error } = await C().sb().from("commando_points").select("commercial_id, type, points, libelle, created_at").eq("semaine_id", semaine.id).order("created_at", { ascending: false }).limit(200);
    if (error) { box.innerHTML = `<div class="cmd-err">${esc(error.message)}</div>`; return; }
    const rows = data || [];
    if (!rows.length) { box.innerHTML = `<p class="muted">Aucun point cette semaine pour le moment.</p>`; return; }
    // Les appels à 1 point sont regroupés par commercial pour garder le relevé lisible.
    const appels = {};
    const autres = rows.filter(r => { if (r.type !== "appel") return true; appels[r.commercial_id] = (appels[r.commercial_id] || 0) + Number(r.points); return false; });
    box.innerHTML = `<div class="tbl-scroll"><table class="grid"><thead><tr><th>Quand</th><th>Commercial</th><th>Quoi</th><th class="num">Points</th></tr></thead><tbody>
      ${Object.entries(appels).map(([cid, p]) => `<tr><td class="muted">Semaine</td><td>${esc(C().prenomDe(cid))}</td><td>Appels passés (${rows.filter(r => r.type === "appel" && r.commercial_id === cid).length})</td><td class="num">+${p}</td></tr>`).join("")}
      ${autres.map(r => `<tr><td class="muted">${esc(C().fmtDateTime(r.created_at))}</td><td>${esc(C().prenomDe(r.commercial_id))}</td><td>${esc(TYPES[r.type] || r.type)}${r.libelle ? ` <span class="muted">(${esc(r.libelle)})</span>` : ""}</td><td class="num">${Number(r.points) > 0 ? "+" : ""}${esc(r.points)}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  async function ajuster(el, commercialId) {
    const nom = C().prenomDe(commercialId);
    const v = prompt(`Points à ajouter à ${nom} (nombre négatif pour un malus) :`, "10");
    if (v == null) return;
    const points = Number(v);
    if (!Number.isInteger(points) || points === 0) { C().toast("Indiquez un nombre entier différent de 0."); return; }
    const motif = prompt(`Motif (visible par toute l'équipe) :`, "");
    if (!motif || !motif.trim()) { C().toast("Un motif est obligatoire."); return; }
    try {
      await C().rpc("commando_points_ajuster", { _commercial: commercialId, _points: points, _libelle: motif.trim(), _semaine_id: semaine ? semaine.id : null });
      C().toast(`${points > 0 ? "+" : ""}${points} points pour ${nom}`);
      releveOuvert = true;
      await rafraichir(el);
    } catch (e) { C().toast(C().erreur(e)); }
  }
  async function render(el) {
    el.innerHTML = `<div id="ligueHead"></div><div id="ligueBody"><p class="cmd-empty"><span class="cmd-spin"></span>Chargement…</p></div>`;
  }
  async function show(el) {
    const { data } = await C().sb().from("commando_semaines").select("*").eq("statut", "publiee").order("semaine", { ascending: false }).limit(8);
    semaines = data || [];
    const cible = C().semaineCible();
    if (!semaine || !semaines.find(s => s.id === semaine.id)) semaine = semaines.find(s => s.semaine === cible) || semaines[0] || null;
    dernierTotal = null;
    await rafraichir(el);
    C().poll(() => rafraichir(el), 10000);
  }

  async function rafraichir(el) {
    const head = $("#ligueHead", el), body = $("#ligueBody", el);
    if (!semaine) {
      head.innerHTML = "";
      body.innerHTML = `<p class="cmd-empty">Aucune semaine publiée pour le moment.</p>`;
      return;
    }
    let l;
    try { l = await C().rpc("commando_ligue", { _semaine_id: semaine.id }) || {}; }
    catch (e) { body.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; return; }
    const total = n(l.total_rdv);
    if (dernierTotal !== null && total > dernierTotal && son) bip();
    dernierTotal = total;

    const autre = semaine.semaine !== C().semaineCible();
    head.innerHTML = `<div class="cmd-entete">
        <span class="muted" style="margin:0">${autre ? `Semaine ${esc(C().numSemaine(semaine.semaine))} (${esc(C().periodeSemaine(semaine.semaine))}), en attendant la publication de la nouvelle semaine.` : "Classement en direct, mis à jour toutes les 10 secondes."}</span>
        <span class="grow"></span>
        <button id="ligueSon" class="btn btn--sm" title="Un petit son à chaque nouveau RDV" aria-pressed="${son}">${son ? ic("volume-2") + "Son activé" : ic("volume-x") + "Son coupé"}</button>
      </div>
      <div class="cmd-cards">
        <div class="pilot-card"><div class="pilot-card__val">${total}</div><div class="pilot-card__lbl">RDV pris</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${n(l.total_appels)}</div><div class="pilot-card__lbl">Appels</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${n(l.total_points_semaine)}</div><div class="pilot-card__lbl">Points de l'équipe</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${n(l.total_mails)}</div><div class="pilot-card__lbl">Mails de suivi</div></div>
        ${C().isResponsable() ? `<div class="pilot-card"><div class="pilot-card__val">${n(l.a_valider)}</div><div class="pilot-card__lbl">RDV passés à valider</div></div>` : ""}
      </div>`;
    $("#ligueSon", head).addEventListener("click", () => {
      son = !son;
      try { localStorage.setItem("rex.ligue.son", son ? "1" : "0"); } catch (e) { /* privé */ }
      if (son) bip();
      rafraichir(el);
    });

    if (l.actif === false) { body.innerHTML = `<p class="cmd-empty">La ligue est désactivée dans les paramètres.</p>`; return; }
    const classement = l.classement || [];
    const me = C().me().id;
    const badge = (b) => BADGES[b] ? `<span class="cmd-badge" title="${esc(BADGES[b].aide)}">${ic(BADGES[b].icone)}${esc(BADGES[b].nom)}</span>` : "";
    body.innerHTML = `<div class="cmd-card" style="padding:0">
        <div style="padding:16px 16px 4px"><h3>Classement de la semaine</h3>
        <p class="muted">Par points de la semaine, puis par RDV pris. Les RDV honorés comptent une fois validés par le responsable ; les badges rapportent leurs points le lundi suivant.</p></div>
        <ol class="cmd-classement">
          ${classement.length ? classement.map((c, i) => `<li class="${c.commercial_id === me ? "cmd-ligue__moi" : ""}">
              <span class="cmd-classement__rang">${i + 1}</span>
              <span class="cmd-classement__nom">${esc(C().nomDe(c.commercial_id))}${c.commercial_id === me ? ' <span class="muted">(vous)</span>' : ""}</span>
              <span class="cmd-classement__pts">${n(c.points_semaine)}<small>${n(c.points_total)} au total</small></span>
              <span class="cmd-classement__faits">
                <span>${ic("phone")}${n(c.appels)} appels</span><span>${ic("calendar-check")}${n(c.rdv)} RDV</span>
                <span>Taux ${c.taux != null ? Math.round(Number(c.taux) * 100) + " %" : "—"}</span>
                <span>${ic("mail")}${n(c.mails)} mails</span><span>${ic("circle-check")}${n(c.honores_valides)} honorés validés</span>
                ${n(c.fiches_gagnees) ? `<span>${ic("gift")}${n(c.fiches_gagnees)} fiches gagnées</span>` : ""}
              </span>
              ${(c.badges || []).length ? `<span class="cmd-classement__badges">${(c.badges || []).map(badge).join("")}</span>` : ""}
              ${C().isResponsable() ? `<span class="cmd-classement__faits"><button class="btn btn--ghost btn--sm" data-ajuster="${c.commercial_id}" title="Bonus ou malus, avec un motif">${ic("plus")}Ajuster les points</button></span>` : ""}
            </li>`).join("") : `<li class="muted">Aucun membre.</li>`}
        </ol>
        <div style="padding:4px 16px 16px;border-top:1px solid var(--c-line)">
          <details class="cmd-releve" ${releveOuvert ? "open" : ""}><summary>Relevé de points de la semaine</summary><div id="ligueReleve"><span class="cmd-spin"></span></div></details>
          <details class="cmd-releve"><summary>Barème et badges</summary>
            <p class="muted" style="margin-top:8px">${bareme(l.bareme || {})}</p>
            <ul class="cmd-hist">${Object.values(BADGES).map(b => `<li>${ic(b.icone)} <b>${esc(b.nom)}</b> : ${esc(b.aide)}</li>`).join("")}</ul>
            ${l.fidele ? `<p class="muted">Fidèle de la semaine : <b>${esc(C().prenomDe(l.fidele))}</b>.</p>` : ""}
          </details>
        </div>
      </div>
      <div class="cmd-card">
        <h3>${ic("clock")}Premier RDV de chaque créneau</h3>
        <p class="muted">Le premier RDV d'une heure d'appel rapporte des fiches premium du secteur libre ; chaque RDV suivant en rapporte une.</p>
        ${(l.creneaux || []).length ? `<ul class="cmd-hist">${l.creneaux.map(c => `<li><b>${esc(creneauLabel(c.creneau))}</b> : ${esc(C().prenomDe(c.commercial_id))} à ${esc(heure(c.a))}, ${n(c.rdv)} RDV sur le créneau</li>`).join("")}</ul>` : `<p class="muted">Aucun RDV pris cette semaine pour le moment.</p>`}
      </div>`;
    body.querySelectorAll("[data-ajuster]").forEach(b => b.addEventListener("click", () => ajuster(el, b.dataset.ajuster)));
    const det = $(".cmd-releve", body);
    if (det) {
      det.addEventListener("toggle", () => { releveOuvert = det.open; if (det.open) chargerReleve(el); });
      if (det.open) chargerReleve(el);
    }
  }

  C().registerTab({ id: "ligue", label: "Ligue", icone: "trophy", render, onShow: show });
})();
