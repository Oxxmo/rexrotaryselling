/* ============================================================
   Rex Commando — écran commercial
   ------------------------------------------------------------
   - « Ma liste » : les entreprises de mon secteur, chacune une seule
     fois, sous la thématique où sa couleur est la meilleure
     (fonction commando_liste), avec les compteurs de la semaine.
   - « Par thématique » : les 3 thématiques retenues, une à la fois.
   - Fiche entreprise : infos, téléphone / e-mail, trame de la couleur
     avec les variables remplies, raison de la couleur, objections,
     résultat d'appel en un clic, historique.
   - Bandeau de confirmation des RDV dont la date est passée.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const sb = () => C().sb();

  const TRANCHES = { "00": "0", "01": "1 ou 2", "02": "3 à 5", "03": "6 à 9", "11": "10 à 19", "12": "20 à 49", "21": "50 à 99", "22": "100 à 199", "31": "200 à 249", "32": "250 à 499", "41": "500 à 999", "42": "1 000 à 1 999", "51": "2 000 à 4 999", "52": "5 000 à 9 999", "53": "10 000 et plus" };
  const ANCIENNETE = { moins_3: "moins de 3 ans", "3_5": "3 à 5 ans", plus_5: "plus de 5 ans" };
  const STATUTS = { injoignable: "Injoignable", rappeler: "À rappeler", refus: "Refus", rdv: "RDV pris" };
  const RDV_STATUTS = { prevu: "prévu", honore: "honoré", annule: "annulé", reporte: "reporté" };
  const COULEUR_LABEL = { vert: "Vert", orange: "Orange", rouge: "Rouge" };
  const RECOMPENSES = { premier_rdv: "Premier RDV de l'heure", rdv_bonus: "RDV pris", fiche_mystere: "Fiche mystère (pronostic tenu)", fidele: "Fidèle de la semaine" };

  /* ---------- État ---------- */
  let semaines = [];          // semaines publiées (les 8 dernières)
  let semaine = null;         // semaine affichée
  let thematiques = [];       // thématiques retenues de la semaine
  let lignes = [];            // résultat de commando_liste (Ma liste)
  let lignesTheme = {};       // thematique_id → lignes (vue par thématique)
  let filtres = { couleur: "prio", thematique: "", tranche: "", anciennete: "", nouvelle: false, appelees: "bas" };
  const PAGE = 60;            // cartes affichées par page (bouton « Afficher plus »)
  // Liste complète (la passerelle tronque à 1 000 lignes par défaut : on demande explicitement plus).
  async function listeRpc(semaineId, thematiqueId) {
    const { data, error } = await sb().rpc("commando_liste", { _semaine_id: semaineId, _thematique_id: thematiqueId }).limit(5000);
    if (error) throw error;
    return data || [];
  }
  let themeActif = null;

  function trancheLabel(t, annee) {
    if (!t) return "effectif non renseigné";
    return (TRANCHES[t] ? TRANCHES[t] + " salariés" : "tranche " + t) + (annee ? ` (${annee})` : "");
  }
  function ancienneteLabel(a) { return ANCIENNETE[a] || "ancienneté inconnue"; }
  function dirigeantLabel(d) {
    if (!Array.isArray(d) || !d.length) return "";
    const x = d[0];
    return [x.prenom, x.nom].filter(Boolean).map(s => String(s)).join(" ") + (x.qualite ? " (" + x.qualite + ")" : "");
  }
  function dirigeantPourTrame(d) {
    if (!Array.isArray(d) || !d.length) return "Madame, Monsieur";
    const x = d[0];
    return [x.prenom, x.nom].filter(Boolean).join(" ") || "Madame, Monsieur";
  }
  function badgeCouleur(c) {
    return c ? `<span class="cmd-badge cmd-badge--${c}">${COULEUR_LABEL[c]}</span>` : `<span class="cmd-badge cmd-badge--gris">Non classée</span>`;
  }

  /* ---------- Chargement ---------- */
  async function chargerSemaines() {
    const { data } = await sb().from("commando_semaines").select("*").eq("statut", "publiee").order("semaine", { ascending: false }).limit(8);
    semaines = data || [];
    const cible = C().semaineCible();
    semaine = semaines.find(s => s.semaine === cible) || semaines[0] || null;
  }
  async function chargerSemaine() {
    if (!semaine) { thematiques = []; lignes = []; lignesTheme = {}; return; }
    const [t, l] = await Promise.all([
      sb().from("commando_thematiques").select("id, titre, offre_rex, pourquoi_maintenant, trames, objections, regles, ordre").eq("semaine_id", semaine.id).eq("statut", "retenue").order("ordre").then(r => r.data || []),
      listeRpc(semaine.id, null)
    ]);
    thematiques = t; lignes = l || []; lignesTheme = {};
    if (!themeActif || !thematiques.find(x => x.id === themeActif)) themeActif = (thematiques[0] || {}).id || null;
  }
  async function chargerTheme(id) {
    if (!semaine || !id) return [];
    if (!lignesTheme[id]) lignesTheme[id] = await listeRpc(semaine.id, id);
    return lignesTheme[id];
  }

  /* ---------- Filtres et cartes ---------- */
  function appliquerFiltres(rows) {
    return rows.filter(r => {
      if (filtres.couleur === "prio") { if (r.couleur !== "vert" && r.couleur !== "orange") return false; }
      else if (filtres.couleur === "non" ? r.couleur : (filtres.couleur && r.couleur !== filtres.couleur)) return false;
      if (filtres.thematique && r.thematique_id !== filtres.thematique) return false;
      if (filtres.tranche && r.tranche_effectif !== filtres.tranche) return false;
      if (filtres.anciennete && r.anciennete !== filtres.anciennete) return false;
      if (filtres.nouvelle && !r.est_nouvelle) return false;
      if (filtres.appelees === "masquer" && r.deja_appelee) return false;
      if (filtres.appelees === "seulement" && !r.deja_appelee) return false;
      return true;
    });
  }
  function barreFiltres(avecTheme) {
    const tranches = Object.keys(TRANCHES).filter(k => ["02", "03", "11", "12", "21"].includes(k));
    return `<div class="cmd-filtres">
      <select data-filtre="couleur"><option value="prio">Vert et orange (à appeler)</option><option value="vert">Vert seulement</option><option value="orange">Orange seulement</option><option value="rouge">Rouge</option><option value="non">Non classées</option><option value="">Toutes les couleurs</option></select>
      ${avecTheme ? `<select data-filtre="thematique"><option value="">Toutes les thématiques</option>${thematiques.map(t => `<option value="${t.id}">${esc(t.titre)}</option>`).join("")}</select>` : ""}
      <select data-filtre="tranche"><option value="">Toutes les tranches</option>${tranches.map(k => `<option value="${k}">${TRANCHES[k]} salariés</option>`).join("")}</select>
      <select data-filtre="anciennete"><option value="">Toute ancienneté</option>${Object.entries(ANCIENNETE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <select data-filtre="appelees"><option value="bas">Déjà appelées en bas</option><option value="masquer">Masquer les déjà appelées</option><option value="seulement">Seulement les déjà appelées</option></select>
      <label class="cmd-check"><input type="checkbox" data-filtre="nouvelle" /> Nouvelles seulement</label>
    </div>`;
  }
  function brancherFiltres(el, onChange) {
    $$("[data-filtre]", el).forEach(f => {
      const k = f.dataset.filtre;
      if (f.type === "checkbox") f.checked = !!filtres[k]; else f.value = filtres[k] || (k === "appelees" ? "bas" : "");
      if (k === "couleur" && filtres.couleur === "") f.value = "";
      f.addEventListener("change", () => { filtres[k] = f.type === "checkbox" ? f.checked : f.value; onChange(); });
    });
  }
  function carte(r) {
    const bloque = r.deja_appelee
      ? `<div class="cmd-item__warn">☎︎ ${esc(STATUTS[r.dernier_appel_statut] || r.dernier_appel_statut)} le ${esc(C().fmtDate(r.dernier_appel_le))} par ${esc(C().prenomDe(r.dernier_appel_par))} · à rappeler à partir du ${esc(C().fmtDate(r.bloquee_jusqua))}</div>`
      : (r.nb_appels ? `<div class="cmd-item__hist">Dernier appel : ${esc(STATUTS[r.dernier_appel_statut] || "")} le ${esc(C().fmtDate(r.dernier_appel_le))}</div>` : "");
    return `<button class="cmd-item ${r.deja_appelee ? "cmd-item--bloque" : ""} cmd-item--${r.couleur || "non"}" data-siret="${esc(r.siret)}">
      <div class="cmd-item__top">
        <span class="cmd-item__nom">${esc(r.raison_sociale)}${r.enseigne && r.enseigne !== r.raison_sociale ? ` <small>· ${esc(r.enseigne)}</small>` : ""}</span>
        <span class="cmd-item__badges">${r.recompense ? `<span class="cmd-badge cmd-badge--warn" title="${esc(RECOMPENSES[r.recompense] || "")}">🎁</span>` : ""}${r.est_nouvelle ? `<span class="cmd-badge cmd-badge--info">Nouvelle</span>` : ""}${badgeCouleur(r.couleur)}</span>
      </div>
      <div class="cmd-item__meta">${esc(r.naf_libelle || r.naf_code || "")} · ${esc(trancheLabel(r.tranche_effectif, r.annee_effectif))} · ${esc(ancienneteLabel(r.anciennete))} · ${esc(r.commune || r.code_postal)}</div>
      <div class="cmd-item__theme">🎯 ${esc(r.thematique_titre || "")}${r.telephone ? ` · ☎︎ ${esc(r.telephone)}` : ""}</div>
      ${bloque}
    </button>`;
  }
  function rendreListe(wrap, rows, source, nb) {
    const visibles = appliquerFiltres(rows);
    if (!rows.length) { wrap.innerHTML = `<p class="cmd-empty">Aucune entreprise dans votre secteur pour cette semaine.</p>`; return; }
    if (!visibles.length) { wrap.innerHTML = `<p class="cmd-empty">Aucune entreprise ne correspond aux filtres${filtres.couleur === "prio" ? " : aucune verte ni orange, choisissez « Toutes les couleurs »" : ""}.</p>`; return; }
    const n = Math.min(visibles.length, nb || PAGE);
    const reste = visibles.length - n;
    wrap.innerHTML = `<p class="muted">${visibles.length} entreprise${visibles.length > 1 ? "s" : ""}${visibles.length !== rows.length ? ` sur ${rows.length} (filtre : ${filtres.couleur === "prio" ? "vert et orange" : "voir ci-dessus"})` : ""}${n < visibles.length ? ` · ${n} affichées` : ""}</p>`
      + visibles.slice(0, n).map(carte).join("")
      + (reste > 0 ? `<div class="cmd-row" style="justify-content:center"><button class="btn btn--sm" data-plus>Afficher ${Math.min(PAGE, reste)} de plus (${reste} restantes)</button></div>` : "");
    $$(".cmd-item", wrap).forEach(b => b.addEventListener("click", () => ouvrirFiche(source.find(r => r.siret === b.dataset.siret))));
    const plus = wrap.querySelector("[data-plus]");
    if (plus) plus.addEventListener("click", () => rendreListe(wrap, rows, source, n + PAGE));
  }

  /* ---------- Onglet « Ma liste » ---------- */
  function selecteurSemaine() {
    if (!semaines.length) return "";
    return `<select id="listeSemaine" class="cmd-sem">${semaines.map(s => `<option value="${s.id}" ${semaine && s.id === semaine.id ? "selected" : ""}>${esc(C().fmtSemaine(s.semaine))}</option>`).join("")}</select>`;
  }
  async function renderListe(el) {
    el.innerHTML = `<div id="listeHead"></div><div id="listeJeux"></div><div id="listeRdv"></div><div id="listeFiltres"></div><div id="listeBody"></div>`;
  }
  async function showListe(el) {
    el.querySelector("#listeBody").innerHTML = `<p class="cmd-empty"><span class="cmd-spin"></span>Chargement…</p>`;
    await chargerSemaines();
    await chargerSemaine();
    await rendreTete(el);
    await rendreJeux(el);
    await rendreConfirmations(el);
    C().poll(() => rendreJeux(el), 30000);
    el.querySelector("#listeFiltres").innerHTML = semaine ? barreFiltres(true) : "";
    brancherFiltres(el, () => rendreListe(el.querySelector("#listeBody"), lignes, lignes));
    if (!semaine) {
      el.querySelector("#listeBody").innerHTML = `<p class="cmd-empty">Aucune semaine publiée pour le moment. Le responsable publie les thématiques le lundi matin.</p>`;
      return;
    }
    rendreListe(el.querySelector("#listeBody"), lignes, lignes);
  }
  async function rendreTete(el) {
    const head = el.querySelector("#listeHead");
    if (!semaine) { head.innerHTML = `<div class="cmd-row"><h3 class="cmd-h">📞 Ma liste</h3></div>`; return; }
    const c = await C().rpc("commando_ma_semaine", { _semaine_id: semaine.id }) || {};
    const obj = Number(c.objectif || 5), rdv = Number(c.rdv || 0);
    const pct = Math.min(100, Math.round(rdv / obj * 100));
    head.innerHTML = `<div class="cmd-row"><h3 class="cmd-h">📞 Ma liste</h3>${selecteurSemaine()}</div>
      <div class="cmd-cards">
        <div class="pilot-card"><div class="pilot-card__val">${Number(c.a_appeler || 0)}</div><div class="pilot-card__lbl">À appeler</div></div>
        <div class="pilot-card"><div class="pilot-card__val"><span class="cmd-dot cmd-dot--vert"></span>${Number(c.vert || 0)} <span class="cmd-dot cmd-dot--orange"></span>${Number(c.orange || 0)} <span class="cmd-dot cmd-dot--rouge"></span>${Number(c.rouge || 0)}</div><div class="pilot-card__lbl">Vert · orange · rouge</div></div>
        <div class="pilot-card"><div class="pilot-card__val">${Number(c.appels || 0)}</div><div class="pilot-card__lbl">Appels cette semaine</div></div>
        <div class="pilot-card pilot-card--obj"><div class="pilot-card__val">${rdv} <small>/ ${obj}</small></div><div class="pilot-card__lbl">RDV pris · objectif</div><div class="cmd-progress"><span style="width:${pct}%"></span></div></div>
      </div>`;
    const sel = head.querySelector("#listeSemaine");
    if (sel) sel.addEventListener("change", async () => { semaine = semaines.find(s => s.id === sel.value); themeActif = null; await showListe(el); });
  }
  /* ---------- Jeux de l'heure : premier RDV, pronostic, fiches gagnées ---------- */
  function heureCourte(ts) {
    try { return new Date(ts).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }); } catch (e) { return "—"; }
  }
  function creneauCourt(ts) {
    const h = Number(new Date(ts).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit" }).slice(0, 2));
    return `${h}h–${h + 1}h`;
  }
  async function rendreJeux(el) {
    const box = el.querySelector("#listeJeux");
    if (!box) return;
    if (!semaine) { box.innerHTML = ""; return; }
    let j;
    try { j = await C().rpc("commando_jeux_etat", { _semaine_id: semaine.id }) || {}; } catch (e) { box.innerHTML = ""; return; }
    const actifs = j.actifs || {};
    const c = j.creneau || {};
    const me = C().me().id;
    if (!actifs.premier_rdv && !actifs.pronostic && !(j.recompenses || []).length) { box.innerHTML = ""; return; }
    const blocs = [];
    if (actifs.premier_rdv) {
      const p = c.premier_rdv;
      blocs.push(`<div class="cmd-jeu">
        <div class="cmd-jeu__titre">🥇 Premier RDV de l'heure</div>
        ${p ? `<div>${p.commercial_id === me ? `<b>C'est vous !</b> RDV à ${esc(heureCourte(p.a))} : vos fiches premium sont dans « Mes fiches gagnées ».` : `<b>${esc(C().prenomDe(p.commercial_id))}</b> à ${esc(heureCourte(p.a))}. Chaque RDV suivant vaut encore une fiche.`}</div>`
            : `<div class="muted">Personne encore sur ce créneau : le premier RDV rapporte 5 fiches premium du secteur libre, les suivants 1 fiche chacun.</div>`}
      </div>`);
    }
    if (actifs.pronostic) {
      const pr = c.pronostic;
      let corps;
      if (pr) {
        corps = `<div>Votre pronostic : <b>${esc(pr.annonce)} RDV</b> · pris sur le créneau : <b>${esc(c.mes_rdv || 0)}</b>${pr.resolu ? (pr.reussi ? ` · <span class="cmd-badge cmd-badge--ok">✔︎ tenu, fiche mystère débloquée</span>` : ` · <span class="cmd-badge cmd-badge--gris">manqué, ça ira mieux au prochain créneau</span>`) : ` · <span class="muted">résultat à la fin du créneau</span>`}</div>`;
      } else if (c.peut_pronostiquer) {
        corps = `<div class="cmd-row">Combien de RDV sur ce créneau ?
          <select id="jeuProno" class="cmd-sem">${[1, 2, 3, 4, 5].map(v => `<option value="${v}">${v}</option>`).join("")}</select>
          <button id="jeuPronoBtn" class="btn btn--primary btn--sm">Je m'engage</button>
          <span class="muted">Tenir son pronostic débloque une fiche mystère.</span></div>`;
      } else {
        corps = `<div class="muted">Pronostic fermé pour ce créneau : il se fait dans les ${esc(c.delai_min || 20)} premières minutes, avant votre premier RDV.</div>`;
      }
      const passes = (j.pronostics_jour || []).filter(p => p.resolu);
      blocs.push(`<div class="cmd-jeu"><div class="cmd-jeu__titre">🎲 Pronostic du créneau ${esc(creneauCourt(c.debut))}</div>${corps}
        ${passes.length ? `<div class="muted" style="margin-top:6px">Aujourd'hui : ${passes.map(p => `${esc(creneauCourt(p.creneau))} ${esc(p.annonce)} annoncé${p.annonce > 1 ? "s" : ""} / ${esc(p.rdv_realises)} pris ${p.reussi ? "✔︎" : "✕"}`).join(" · ")}</div>` : ""}</div>`);
    }
    const rec = j.recompenses || [];
    blocs.push(`<div class="cmd-jeu"><div class="cmd-jeu__titre">🎁 Mes fiches gagnées <span class="muted">(${rec.length} · ${esc(j.nb_recompenses_semaine || 0)}/${esc(j.max_fiches_semaine || 15)} cette semaine)</span></div>
      ${rec.length ? `<div id="jeuRecompenses"></div>` : `<div class="muted">Aucune pour le moment. Les fiches gagnées viennent du secteur libre et vous sont réservées.</div>`}</div>`);
    box.innerHTML = `<div class="cmd-card cmd-card--jeux"><h3>🎮 Jeux de l'heure · créneau ${esc(creneauCourt(c.debut))}</h3>${blocs.join("")}</div>`;
    const btn = box.querySelector("#jeuPronoBtn");
    if (btn) btn.addEventListener("click", async () => {
      try {
        await C().rpc("commando_pronostic", { _semaine_id: semaine.id, _annonce: Number(box.querySelector("#jeuProno").value) });
        C().toast("Pronostic enregistré, bonne chance !");
        rendreJeux(el);
      } catch (e) { C().toast(C().erreur(e)); }
    });
    const wrap = box.querySelector("#jeuRecompenses");
    if (wrap) {
      wrap.innerHTML = rec.map(carte).join("");
      $$(".cmd-item", wrap).forEach(b => b.addEventListener("click", () => ouvrirFiche(rec.find(r => r.siret === b.dataset.siret))));
    }
  }

  // RDV dont la date est passée et qui attendent une confirmation (les miens).
  async function rendreConfirmations(el) {
    const box = el.querySelector("#listeRdv");
    const me = C().me().id;
    const { data } = await sb().from("commando_appels").select("id, siret, date_rdv, rdv_statut, note")
      .eq("commercial_id", me).eq("statut", "rdv").in("rdv_statut", ["prevu", "reporte"]).lt("date_rdv", new Date().toISOString()).order("date_rdv");
    const list = data || [];
    if (!list.length) { box.innerHTML = ""; return; }
    const sirets = list.map(a => a.siret);
    const { data: ents } = await sb().from("commando_entreprises").select("siret, raison_sociale").in("siret", sirets);
    const nom = {}; (ents || []).forEach(e => { nom[e.siret] = e.raison_sociale; });
    box.innerHTML = `<div class="cmd-bandeau">
      <b>📅 ${list.length} rendez-vous à confirmer</b> — ce RDV a-t-il eu lieu ?
      ${list.map(a => `<div class="cmd-bandeau__item" data-id="${a.id}">
        <span><b>${esc(nom[a.siret] || a.siret)}</b> · ${esc(C().fmtDateTime(a.date_rdv))}</span>
        <span class="cmd-bandeau__btns">
          <button class="btn btn--sm" data-rdv="honore">✔︎ Honoré</button>
          <button class="btn btn--sm" data-rdv="reporte">↻ Reporté</button>
          <button class="btn btn--sm btn--danger" data-rdv="annule">✕ Annulé</button>
        </span></div>`).join("")}
    </div>`;
    $$("[data-rdv]", box).forEach(b => b.addEventListener("click", async () => {
      const id = b.closest(".cmd-bandeau__item").dataset.id;
      const patch = { rdv_statut: b.dataset.rdv };
      if (b.dataset.rdv === "reporte") {
        const d = prompt("Nouvelle date du rendez-vous (AAAA-MM-JJ HH:MM) :");
        if (!d) return;
        const dt = new Date(d.replace(" ", "T"));
        if (isNaN(dt)) { C().toast("Date invalide"); return; }
        patch.date_rdv = dt.toISOString();
      }
      const { error } = await sb().from("commando_appels").update(patch).eq("id", id);
      if (error) { C().toast("Échec : " + error.message); return; }
      C().toast("Merci, c'est noté");
      await rendreConfirmations(el); await rendreTete(el);
    }));
  }

  /* ---------- Onglet « Par thématique » ---------- */
  async function renderThemes(el) {
    el.innerHTML = `<div id="themHead"></div><div id="themTabs" class="cmd-subtabs"></div><div id="themIntro"></div><div id="themFiltres"></div><div id="themBody"></div>`;
  }
  async function showThemes(el) {
    if (!semaine || !thematiques.length) { await chargerSemaines(); await chargerSemaine(); }
    el.querySelector("#themHead").innerHTML = `<div class="cmd-row"><h3 class="cmd-h">🗂️ Par thématique</h3>${selecteurSemaine()}</div>`;
    const sel = el.querySelector("#listeSemaine");
    if (sel) sel.addEventListener("change", async () => { semaine = semaines.find(s => s.id === sel.value); themeActif = null; await chargerSemaine(); await showThemes(el); });
    if (!semaine) { el.querySelector("#themBody").innerHTML = `<p class="cmd-empty">Aucune semaine publiée pour le moment.</p>`; return; }
    el.querySelector("#themTabs").innerHTML = thematiques.map(t => `<button class="tab ${t.id === themeActif ? "tab--active" : ""}" data-theme="${t.id}">${esc(t.titre)}</button>`).join("");
    $$("[data-theme]", el).forEach(b => b.addEventListener("click", () => { themeActif = b.dataset.theme; showThemes(el); }));
    const t = thematiques.find(x => x.id === themeActif);
    if (!t) { el.querySelector("#themBody").innerHTML = `<p class="cmd-empty">Aucune thématique retenue.</p>`; return; }
    el.querySelector("#themIntro").innerHTML = `<div class="cmd-card cmd-card--theme"><h3>${esc(t.titre)}</h3><p class="muted"><b>Offre Rex :</b> ${esc(t.offre_rex)}</p><p>${esc(t.pourquoi_maintenant)}</p></div>`;
    el.querySelector("#themFiltres").innerHTML = barreFiltres(false);
    const body = el.querySelector("#themBody");
    body.innerHTML = `<p class="cmd-empty"><span class="cmd-spin"></span>Chargement…</p>`;
    const rows = await chargerTheme(t.id);
    brancherFiltres(el, () => rendreListe(body, rows, rows));
    rendreListe(body, rows, rows);
  }

  /* ---------- Fiche entreprise ---------- */
  function remplir(txt, r) {
    const me = C().me();
    const vars = {
      commercial: (me.full_name || me.email || "").trim(),
      raison_sociale: r.raison_sociale || "",
      tranche: r.tranche_effectif ? (TRANCHES[r.tranche_effectif] || r.tranche_effectif) : "quelques",
      anciennete: ancienneteLabel(r.anciennete),
      naf_libelle: (r.naf_libelle || "").toLowerCase(),
      dirigeant: dirigeantPourTrame(r.dirigeants)
    };
    return String(txt || "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }
  function trameHtml(t, couleur, r) {
    const trames = (t && t.trames) || {};
    const c = couleur || "orange";
    const tr = trames[c] || trames.vert || {};
    const note = couleur ? "" : `<div class="cmd-note">Entreprise non classée pour cette thématique : la trame orange est proposée par défaut.</div>`;
    if (!tr.accroche && !tr.argument) return note + `<p class="muted">Aucune trame disponible pour cette couleur.</p>`;
    return note + `
      <div class="cmd-trame cmd-trame--${c}">
        <div class="cmd-trame__bloc"><b>Accroche</b><p>${esc(remplir(tr.accroche, r))}</p></div>
        ${(tr.questions_decouverte || []).length ? `<div class="cmd-trame__bloc"><b>Questions de découverte</b><ol>${tr.questions_decouverte.map(q => `<li>${esc(remplir(q, r))}</li>`).join("")}</ol></div>` : ""}
        ${tr.argument ? `<div class="cmd-trame__bloc"><b>Argument</b><p>${esc(remplir(tr.argument, r))}</p></div>` : ""}
        ${tr.conclusion ? `<div class="cmd-trame__bloc"><b>Conclusion</b><p>${esc(remplir(tr.conclusion, r))}</p></div>` : ""}
      </div>`;
  }
  function objectionsHtml(t) {
    const obj = (t && t.objections) || [];
    if (!obj.length) return "";
    return `<details class="cmd-obj"><summary>Objections probables (${obj.length})</summary>${obj.map(o => `<div class="cmd-obj__item"><b>« ${esc(o.objection)} »</b><p>${esc(o.reponse)}</p></div>`).join("")}</details>`;
  }
  let ficheEl = null;
  async function ouvrirFiche(r) {
    if (!r) return;
    const t = thematiques.find(x => x.id === r.thematique_id);
    const me = C().me();
    if (!ficheEl) {
      ficheEl = document.createElement("div");
      ficheEl.className = "modal"; ficheEl.id = "ficheModal";
      document.body.appendChild(ficheEl);
    }
    const regleTxt = r.couleur
      ? `${COULEUR_LABEL[r.couleur]} — règle ${Number(r.regle_index) + 1} : ${esc(r.raison || "")}`
      : "Non classée : aucune règle de la thématique ne correspond.";
    const dans7j = new Date(); dans7j.setDate(dans7j.getDate() + 7);
    ficheEl.innerHTML = `
      <div class="modal__backdrop" data-fiche-close></div>
      <div class="modal__panel">
        <div class="modal__header">
          <div><h2>${esc(r.raison_sociale)}</h2><div class="cmd-fiche__sub">${badgeCouleur(r.couleur)} ${r.est_nouvelle ? `<span class="cmd-badge cmd-badge--info">Nouvelle</span>` : ""} <span class="muted">🎯 ${esc(r.thematique_titre || "")}</span></div></div>
          <button class="modal__close" data-fiche-close aria-label="Fermer">✕</button>
        </div>
        <div class="modal__body cmd-fiche">
          <div class="cmd-fiche__grid">
            <div><small>Activité</small>${esc(r.naf_libelle || "—")} <span class="muted">(${esc(r.naf_code || "")})</span></div>
            <div><small>Effectif</small>${esc(trancheLabel(r.tranche_effectif, r.annee_effectif))}</div>
            <div><small>Ancienneté</small>${esc(ancienneteLabel(r.anciennete))}${r.date_creation_ul ? ` <span class="muted">(créée le ${esc(C().fmtDate(r.date_creation_ul))})</span>` : ""}</div>
            <div><small>Dirigeant</small>${esc(dirigeantLabel(r.dirigeants) || "non renseigné")}</div>
            <div class="wide"><small>Adresse</small>${esc(r.adresse || "")}${r.enseigne ? ` <span class="muted">· enseigne ${esc(r.enseigne)}</span>` : ""}</div>
            <div><small>Téléphone</small><input id="ficheTel" type="tel" value="${esc(r.telephone || "")}" placeholder="05 49 …" /></div>
            <div><small>E-mail</small><input id="ficheMail" type="email" value="${esc(r.email || "")}" placeholder="contact@…" /></div>
          </div>
          <div class="cmd-row"><button id="ficheSaveContact" class="btn btn--sm">Enregistrer les coordonnées</button><button id="ficheOppo" class="btn btn--ghost btn--sm">🚫 Ne plus contacter (opposition)</button></div>
          ${r.deja_appelee ? `<div class="cmd-item__warn">☎︎ Déjà appelée : ${esc(STATUTS[r.dernier_appel_statut] || "")} le ${esc(C().fmtDate(r.dernier_appel_le))} par ${esc(C().prenomDe(r.dernier_appel_par))}. Rappel possible à partir du ${esc(C().fmtDate(r.bloquee_jusqua))}.</div>` : ""}
          <h3 class="output-title">Pourquoi cette couleur</h3>
          <p class="cmd-regle">${regleTxt}</p>
          <h3 class="output-title">Trame d'appel</h3>
          ${trameHtml(t, r.couleur, r)}
          ${objectionsHtml(t)}
          <h3 class="output-title">Résultat de l'appel</h3>
          <div class="cmd-resultat">
            <div class="cmd-resultat__btns">
              <button class="btn" data-statut="injoignable">📵 Injoignable</button>
              <button class="btn" data-statut="rappeler">🔁 Rappeler</button>
              <button class="btn" data-statut="refus">✕ Refus</button>
              <button class="btn btn--primary" data-statut="rdv">📅 RDV pris</button>
            </div>
            <div id="resExtra" class="cmd-resultat__extra" hidden>
              <label id="resRappelLbl" hidden>Rappeler le<input id="resRappel" type="date" value="${dans7j.toISOString().slice(0, 10)}" /></label>
              <label id="resRdvLbl" hidden>Date et heure du RDV<input id="resRdv" type="datetime-local" /></label>
              <label>Note (facultatif)<textarea id="resNote" rows="2" placeholder="Interlocuteur, contexte, prochaine étape…"></textarea></label>
              <div class="cmd-row"><button id="resSave" class="btn btn--primary">Enregistrer</button><span id="resErr" class="cmd-err" hidden></span></div>
            </div>
          </div>
          <h3 class="output-title">Historique des appels</h3>
          <div id="ficheHist"><span class="cmd-spin"></span></div>
        </div>
      </div>`;
    ficheEl.hidden = false;
    document.body.style.overflow = "hidden";
    $$("[data-fiche-close]", ficheEl).forEach(x => x.addEventListener("click", fermerFiche));

    // Coordonnées
    $("#ficheSaveContact", ficheEl).addEventListener("click", async () => {
      const row = { siret: r.siret, telephone: $("#ficheTel", ficheEl).value.trim() || null, email: $("#ficheMail", ficheEl).value.trim() || null, updated_by: me.id };
      const { error } = await sb().from("commando_contacts").upsert(row, { onConflict: "siret" });
      if (error) { C().toast("Échec : " + error.message); return; }
      r.telephone = row.telephone; r.email = row.email;
      C().toast("Coordonnées enregistrées");
    });
    $("#ficheOppo", ficheEl).addEventListener("click", async () => {
      if (!confirm("Marquer « " + r.raison_sociale + " » en opposition ?\nL'entreprise ne sera plus jamais proposée dans les listes d'appel.")) return;
      const { error } = await sb().from("commando_contacts").upsert({ siret: r.siret, opposition: true, opposition_le: new Date().toISOString(), updated_by: me.id }, { onConflict: "siret" });
      if (error) { C().toast("Échec : " + error.message); return; }
      C().toast("Opposition enregistrée");
      fermerFiche(); rafraichir();
    });

    // Résultat d'appel
    let statut = null;
    $$("[data-statut]", ficheEl).forEach(b => b.addEventListener("click", () => {
      statut = b.dataset.statut;
      $$("[data-statut]", ficheEl).forEach(x => x.classList.toggle("btn--primary", x === b));
      $("#resExtra", ficheEl).hidden = false;
      $("#resRappelLbl", ficheEl).hidden = statut !== "rappeler";
      $("#resRdvLbl", ficheEl).hidden = statut !== "rdv";
      if (statut === "rdv") $("#resRdv", ficheEl).focus();
    }));
    $("#resSave", ficheEl).addEventListener("click", async () => {
      const err = $("#resErr", ficheEl); err.hidden = true;
      if (!statut) { err.textContent = "Choisissez un résultat."; err.hidden = false; return; }
      const row = {
        siret: r.siret, semaine_id: semaine ? semaine.id : null, thematique_id: r.thematique_id || null,
        commercial_id: me.id, statut, note: $("#resNote", ficheEl).value.trim() || null,
        couleur_au_moment: r.couleur || null, regle_index_au_moment: r.couleur ? r.regle_index : null
      };
      if (statut === "rappeler") row.date_rappel = $("#resRappel", ficheEl).value || null;
      if (statut === "rdv") {
        const v = $("#resRdv", ficheEl).value;
        if (!v) { err.textContent = "Indiquez la date et l'heure du rendez-vous."; err.hidden = false; return; }
        row.date_rdv = new Date(v).toISOString(); row.rdv_statut = "prevu";
      }
      const b = $("#resSave", ficheEl); b.disabled = true;
      const { error } = await sb().from("commando_appels").insert(row);
      b.disabled = false;
      if (error) { err.textContent = "Échec : " + error.message; err.hidden = false; return; }
      C().toast(statut === "rdv" ? "RDV enregistré, bravo !" : "Appel enregistré");
      fermerFiche();
      rafraichir();
    });

    // Historique
    const { data: hist } = await sb().from("commando_appels").select("*").eq("siret", r.siret).order("created_at", { ascending: false }).limit(8);
    const h = $("#ficheHist", ficheEl);
    if (!h) return;
    h.innerHTML = (hist || []).length ? `<ul class="cmd-hist">${hist.map(a => `<li><b>${esc(STATUTS[a.statut] || a.statut)}</b>${a.statut === "rdv" ? ` (${esc(C().fmtDateTime(a.date_rdv))}, ${esc(RDV_STATUTS[a.rdv_statut] || "")})` : ""}${a.statut === "rappeler" && a.date_rappel ? ` (le ${esc(C().fmtDate(a.date_rappel))})` : ""} · ${esc(C().fmtDateTime(a.created_at))} · ${esc(C().prenomDe(a.commercial_id))}${a.couleur_au_moment ? ` · ${esc(COULEUR_LABEL[a.couleur_au_moment])}` : ""}${a.note ? `<br><span class="muted">${esc(a.note)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="muted">Jamais appelée.</p>`;
  }
  function fermerFiche() {
    if (ficheEl) ficheEl.hidden = true;
    document.body.style.overflow = "";
  }
  // Après un appel : totaux et listes à jour immédiatement.
  async function rafraichir() {
    lignesTheme = {};
    await chargerSemaine();
    const liste = $('#cmdBody .cmd__pane[data-pane="liste"]');
    if (liste && liste.classList.contains("cmd__pane--active")) {
      await rendreTete(liste); await rendreConfirmations(liste);
      rendreListe(liste.querySelector("#listeBody"), lignes, lignes);
    }
    const th = $('#cmdBody .cmd__pane[data-pane="thematiques"]');
    if (th && th.classList.contains("cmd__pane--active")) await showThemes(th);
  }

  C().registerTab({ id: "liste", label: "📞 Ma liste", render: renderListe, onShow: showListe });
  C().registerTab({ id: "thematiques", label: "🗂️ Par thématique", render: renderThemes, onShow: showThemes });
  window.RexCommandoListe = { rafraichir };
})();
