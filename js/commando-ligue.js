/* ============================================================
   Rex Commando — onglet « Ligue » (tous les membres)
   ------------------------------------------------------------
   Classement en direct de la semaine : appels, RDV pris, taux, RDV
   honorés validés par le responsable, fiches gagnées. Quatre badges :
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
    ouvreur:     { icone: "🥇", nom: "Ouvreur",     aide: "premier RDV de la semaine" },
    marathonien: { icone: "🏃", nom: "Marathonien", aide: "le plus d'appels" },
    sniper:      { icone: "🎯", nom: "Sniper",      aide: "meilleur taux de RDV (10 appels au moins)" },
    fidele:      { icone: "💎", nom: "Fidèle",      aide: "le plus de RDV honorés validés sur les semaines précédentes : il choisit en premier ses fiches du secteur libre" },
  };

  let semaines = [], semaine = null, dernierTotal = null;
  let son = false;
  try { son = localStorage.getItem("rex.ligue.son") === "1"; } catch (e) { /* privé */ }

  function heure(ts) {
    try { return new Date(ts).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; }
  }
  function creneauLabel(ts) {
    const d = new Date(ts);
    const h = Number(d.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit" }).slice(0, 2));
    const jour = d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "short", day: "numeric", month: "short" });
    return `${jour} · ${h}h–${h + 1}h`;
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
      head.innerHTML = `<div class="cmd-row"><h3 class="cmd-h">🏆 Ligue du commando</h3></div>`;
      body.innerHTML = `<p class="cmd-empty">Aucune semaine publiée pour le moment.</p>`;
      return;
    }
    let l;
    try { l = await C().rpc("commando_ligue", { _semaine_id: semaine.id }) || {}; }
    catch (e) { body.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; return; }
    const total = n(l.total_rdv);
    if (dernierTotal !== null && total > dernierTotal && son) bip();
    dernierTotal = total;

    head.innerHTML = `<div class="cmd-row">
        <h3 class="cmd-h">🏆 Ligue du commando</h3>
        <select id="ligueSemaine" class="cmd-sem">${semaines.map(s => `<option value="${s.id}" ${s.id === semaine.id ? "selected" : ""}>${esc(C().fmtSemaine(s.semaine))}</option>`).join("")}</select>
        <span class="grow"></span>
        <button id="ligueSon" class="btn btn--ghost btn--sm" title="Un petit son à chaque nouveau RDV">${son ? "🔔 Son activé" : "🔕 Son coupé"}</button>
      </div>
      <div class="cmd-cards">
        <div class="pilot-card"><div class="pilot-card__val">${total}</div><div class="pilot-card__lbl">RDV pris cette semaine</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${n(l.total_appels)}</div><div class="pilot-card__lbl">Appels</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${l.fidele ? esc(C().prenomDe(l.fidele)) : "—"}</div><div class="pilot-card__lbl">💎 Fidèle de la semaine</div></div>
        ${C().isResponsable() ? `<div class="pilot-card"><div class="pilot-card__val">${n(l.a_valider)}</div><div class="pilot-card__lbl">RDV passés à valider (onglet Semaine)</div></div>` : ""}
      </div>`;
    $("#ligueSemaine", head).addEventListener("change", (e) => { semaine = semaines.find(s => s.id === e.target.value); dernierTotal = null; rafraichir(el); });
    $("#ligueSon", head).addEventListener("click", () => {
      son = !son;
      try { localStorage.setItem("rex.ligue.son", son ? "1" : "0"); } catch (e) { /* privé */ }
      if (son) bip();
      rafraichir(el);
    });

    if (l.actif === false) { body.innerHTML = `<p class="cmd-empty">La ligue est désactivée dans les paramètres.</p>`; return; }
    const classement = l.classement || [];
    const me = C().me().id;
    const rang = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    body.innerHTML = `<div class="cmd-card">
        <h3>Classement de la semaine</h3>
        <p class="muted">Classé par RDV pris, puis par appels. Les RDV honorés comptent une fois validés par le responsable.</p>
        <div class="tbl-scroll"><table class="grid"><thead><tr><th></th><th>Commercial</th><th class="num">Appels</th><th class="num">RDV</th><th class="num">Taux</th><th class="num">Honorés validés (${esc(l.fenetre_fidele || 4)} sem.)</th><th class="num">🎁 Fiches</th><th>Badges</th></tr></thead><tbody>
          ${classement.length ? classement.map((c, i) => `<tr class="${c.commercial_id === me ? "cmd-ligue__moi" : ""}">
              <td>${rang(i)}</td><td><b>${esc(C().nomDe(c.commercial_id))}</b>${c.commercial_id === me ? ' <span class="muted">(vous)</span>' : ""}</td>
              <td class="num">${n(c.appels)}</td><td class="num"><b>${n(c.rdv)}</b></td>
              <td class="num">${c.taux != null ? Math.round(Number(c.taux) * 100) + " %" : "—"}</td>
              <td class="num">${n(c.honores_valides)}</td><td class="num">${n(c.fiches_gagnees)}</td>
              <td>${(c.badges || []).map(b => BADGES[b] ? `<span class="cmd-badge cmd-badge--warn" title="${esc(BADGES[b].aide)}">${BADGES[b].icone} ${esc(BADGES[b].nom)}</span>` : "").join(" ")}</td>
            </tr>`).join("") : `<tr><td colspan="8" class="muted">Aucun membre.</td></tr>`}
        </tbody></table></div>
        <p class="muted" style="margin-top:8px">${Object.values(BADGES).map(b => `${b.icone} <b>${esc(b.nom)}</b> : ${esc(b.aide)}`).join(" · ")}</p>
      </div>
      <div class="cmd-card">
        <h3>Premier RDV de chaque créneau</h3>
        <p class="muted">Le premier RDV d'une heure d'appel rapporte des fiches premium du secteur libre ; chaque RDV suivant en rapporte une.</p>
        ${(l.creneaux || []).length ? `<ul class="cmd-hist">${l.creneaux.map(c => `<li><b>${esc(creneauLabel(c.creneau))}</b> : ${esc(C().prenomDe(c.commercial_id))} à ${esc(heure(c.a))} · ${n(c.rdv)} RDV sur le créneau</li>`).join("")}</ul>` : `<p class="muted">Aucun RDV pris cette semaine pour le moment.</p>`}
      </div>`;
  }

  C().registerTab({ id: "ligue", label: "🏆 Ligue", render, onShow: show });
})();
