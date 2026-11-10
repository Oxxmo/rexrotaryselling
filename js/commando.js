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
  const ic = (n) => C().ic(n);

  const TRANCHES = { "00": "0", "01": "1 ou 2", "02": "3 à 5", "03": "6 à 9", "11": "10 à 19", "12": "20 à 49", "21": "50 à 99", "22": "100 à 199", "31": "200 à 249", "32": "250 à 499", "41": "500 à 999", "42": "1 000 à 1 999", "51": "2 000 à 4 999", "52": "5 000 à 9 999", "53": "10 000 et plus" };
  const ANCIENNETE = { moins_3: "moins de 3 ans", "3_5": "3 à 5 ans", plus_5: "plus de 5 ans" };
  const STATUTS = { injoignable: "Injoignable", rappeler: "À rappeler", refus: "Refus", rdv: "RDV pris" };
  const RDV_STATUTS = { prevu: "prévu", honore: "honoré", annule: "annulé", reporte: "reporté" };
  const COULEUR_LABEL = { vert: "Vert", orange: "Orange", rouge: "Rouge" };
  const RAISONS_PASSER = { hors_cible: "Hors cible", fermee: "Fermée ou n'existe plus", doublon: "Doublon", pas_de_numero: "Pas de numéro trouvé", autre: "Autre raison" };
  const RECOMPENSES = { premier_rdv: "Premier RDV de l'heure", rdv_bonus: "RDV pris", fiche_mystere: "Fiche mystère (pronostic tenu)", fidele: "Fidèle de la semaine" };

  /* ---------- État ---------- */
  let semaines = [];          // semaines publiées (les 8 dernières)
  let semaine = null;         // semaine affichée
  let thematiques = [];       // thématiques retenues de la semaine
  let lignes = [];            // résultat de commando_liste (Ma liste)
  let lignesTheme = {};       // thematique_id → lignes (vue par thématique)
  let filtres = { couleur: "prio", thematique: "", tranche: "", anciennete: "", nouvelle: false, signal: false, telephone: false };
  const PAGE = 60;            // cartes affichées par page (bouton « Afficher plus »)
  // Liste complète (la passerelle tronque à 1 000 lignes par défaut : on demande explicitement plus).
  // Supabase plafonne chaque réponse à 1 000 lignes (un secteur peut en
  // compter 1 600) : on lit la liste par pages jusqu'à la dernière.
  const PAGE_RPC = 1000;
  async function listeRpc(semaineId, thematiqueId) {
    const rows = [];
    for (let depuis = 0; depuis < 20000; depuis += PAGE_RPC) {
      const { data, error } = await sb().rpc("commando_ma_liste", { _semaine_id: semaineId, _thematique_id: thematiqueId }).order("ordre").range(depuis, depuis + PAGE_RPC - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_RPC) break;
    }
    return rows;
  }
  let themeActif = null;
  let jeuxOuvert = null;       // choix de l'utilisateur pour le bloc des jeux (replié par défaut)
  let filtresOuverts = false;

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
      sb().from("commando_thematiques").select("id, titre, offre_rex, pourquoi_maintenant, trames, objections, mails, regles, ordre").eq("semaine_id", semaine.id).eq("statut", "retenue").order("ordre").then(r => r.data || []),
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
  // Un rappel échu s'affiche quelle que soit la couleur choisie.
  function passeFiltres(r, avecCouleur) {
    if (avecCouleur) {
      if (filtres.couleur === "prio") { if (r.couleur !== "vert" && r.couleur !== "orange" && !r.complement) return false; }
      else if (filtres.couleur === "complement") { if (!r.complement) return false; }
      else if (filtres.couleur === "non" ? r.couleur : (filtres.couleur && r.couleur !== filtres.couleur)) return false;
    }
    if (filtres.thematique && r.thematique_id !== filtres.thematique) return false;
    if (filtres.tranche && r.tranche_effectif !== filtres.tranche) return false;
    if (filtres.anciennete && r.anciennete !== filtres.anciennete) return false;
    if (filtres.nouvelle && !r.est_nouvelle) return false;
    if (filtres.signal && !r.signal) return false;
    if (filtres.telephone && !r.telephone) return false;
    return true;
  }
  function appliquerFiltres(rows) {
    return rows.filter(r => passeFiltres(r, !["rappel", "attente", "passee"].includes(r.bloc)));
  }
  function nbFiltresActifs() {
    return (filtres.couleur !== "prio" ? 1 : 0) + ["thematique", "tranche", "anciennete"].filter(k => filtres[k]).length + ["nouvelle", "signal", "telephone"].filter(k => filtres[k]).length;
  }
  function barreFiltres(avecTheme) {
    const tranches = Object.keys(TRANCHES).filter(k => ["02", "03", "11", "12", "21"].includes(k));
    const n = nbFiltresActifs();
    return `<details class="cmd-filtres-det" ${filtresOuverts ? "open" : ""}><summary>${ic("sliders-horizontal")}Filtres${n ? ` <span class="cmd-groupe__nb">${n}</span>` : ""}</summary><div class="cmd-filtres">
      <select data-filtre="couleur"><option value="prio">À appeler : vert, orange et complément</option><option value="vert">Vert seulement</option><option value="orange">Orange seulement</option><option value="complement">Complément seulement</option><option value="rouge">Rouge</option><option value="non">Non classées</option><option value="">Toutes les couleurs</option></select>
      ${avecTheme ? `<select data-filtre="thematique"><option value="">Toutes les thématiques</option>${thematiques.map(t => `<option value="${t.id}">${esc(t.titre)}</option>`).join("")}</select>` : ""}
      <select data-filtre="tranche"><option value="">Toutes les tranches</option>${tranches.map(k => `<option value="${k}">${TRANCHES[k]} salariés</option>`).join("")}</select>
      <select data-filtre="anciennete"><option value="">Toute ancienneté</option>${Object.entries(ANCIENNETE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <label class="cmd-check"><input type="checkbox" data-filtre="telephone" /> Avec numéro</label>
      <label class="cmd-check"><input type="checkbox" data-filtre="signal" /> Avec actualité</label>
      <label class="cmd-check"><input type="checkbox" data-filtre="nouvelle" /> Nouvelles seulement</label>
    </div></details>`;
  }
  function brancherFiltres(el, onChange) {
    $$("[data-filtre]", el).forEach(f => {
      const k = f.dataset.filtre;
      if (f.type === "checkbox") f.checked = !!filtres[k]; else f.value = filtres[k] || "";
      f.addEventListener("change", () => {
        filtres[k] = f.type === "checkbox" ? f.checked : f.value; onChange();
        const nb = el.querySelector(".cmd-filtres-det summary"); const n = nbFiltresActifs();
        if (nb) nb.innerHTML = ic("sliders-horizontal") + "Filtres" + (n ? ` <span class="cmd-groupe__nb">${n}</span>` : "");
      });
    });
    const det = el.querySelector(".cmd-filtres-det");
    if (det) det.addEventListener("toggle", () => { filtresOuverts = det.open; });
  }
  function fmtCA(ca) {
    const n = Number(ca);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1e6) return (n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " M€";
    return Math.round(n / 1e3).toLocaleString("fr-FR") + " k€";
  }
  // Raison d'appeler tirée de l'annonce BODACC (suggestion, pas un fait sur l'entreprise).
  const CONSEIL_SIGNAL = {
    dirigeant: "Nouveau dirigeant : bon moment pour faire le point sur les contrats en cours (impression, téléphonie, informatique).",
    demenagement: "Déménagement : nouveaux locaux, donc réseau, impression et téléphonie à installer.",
    rachat: "Reprise du fonds : le repreneur revoit souvent le matériel et les contrats.",
    etablissement: "Nouvel établissement : postes, impression et téléphonie à équiper.",
    capital: "Augmentation de capital : l'entreprise investit, c'est le moment de proposer.",
    activite: "Changement d'activité : les besoins en équipement évoluent."
  };
  function badgeSignal(r) {
    if (!r.signal) return "";
    return `<span class="cmd-badge cmd-badge--signal" title="${esc(r.signal)} (BODACC du ${esc(C().fmtDate(r.signal_le))})">${ic("newspaper")}${esc(r.signal)}</span>`;
  }
  function ligneEtat(r) {
    const st = STATUTS[r.dernier_appel_statut] || r.dernier_appel_statut || "";
    const qui = r.dernier_appel_par ? ` par ${esc(C().prenomDe(r.dernier_appel_par))}` : "";
    if (r.bloc === "rappel") return `<div class="cmd-item__warn cmd-item__warn--rappel">${ic("rotate-ccw")}<span>Rappel prévu le ${esc(C().fmtDate(r.bloquee_jusqua))}, appel du ${esc(C().fmtDate(r.dernier_appel_le))}${qui}</span></div>`;
    if (r.bloc === "passee") return `<div class="cmd-item__hist">${ic("skip-forward")}<span>Passée (${esc(RAISONS_PASSER[r.passee_raison] || r.passee_raison || "")}) jusqu'au ${esc(C().fmtDate(r.passee_jusqua))}</span></div>`;
    if (r.deja_appelee) return `<div class="cmd-item__warn">${ic("phone")}<span>${esc(st)} le ${esc(C().fmtDate(r.dernier_appel_le))}${qui}, à rappeler à partir du ${esc(C().fmtDate(r.bloquee_jusqua))}</span></div>`;
    if (Number(r.nb_appels)) return `<div class="cmd-item__hist">${ic("history")}<span>Dernier appel : ${esc(st)} le ${esc(C().fmtDate(r.dernier_appel_le))}${qui}</span></div>`;
    return "";
  }
  function carte(r) {
    const ca = fmtCA(r.ca);
    return `<button class="cmd-item ${r.deja_appelee || r.bloc === "passee" ? "cmd-item--bloque" : ""} cmd-item--${r.couleur || (r.complement ? "compl" : "non")}" data-siret="${esc(r.siret)}">
      <div class="cmd-item__top">
        <span class="cmd-item__nom">${esc(r.raison_sociale)}${r.enseigne && r.enseigne !== r.raison_sociale ? ` <small>· ${esc(r.enseigne)}</small>` : ""}</span>
        <span class="cmd-item__badges">${r.recompense ? `<span class="cmd-badge cmd-badge--warn" title="${esc(RECOMPENSES[r.recompense] || "")}">${ic("gift")}Gagnée</span>` : ""}${badgeSignal(r)}${r.est_nouvelle ? `<span class="cmd-badge cmd-badge--info">Nouvelle</span>` : ""}${r.complement ? `<span class="cmd-badge cmd-badge--compl" title="Ajoutée pour compléter votre liste : hors des sujets de la semaine">Complément</span>` : badgeCouleur(r.couleur)}</span>
      </div>
      <div class="cmd-item__meta">${esc(r.naf_libelle || r.naf_code || "")}</div>
      <div class="cmd-item__faits">
        <span>${ic("users")}${esc(r.tranche_effectif ? (TRANCHES[r.tranche_effectif] || r.tranche_effectif) + " salariés" : "effectif inconnu")}</span>
        <span>${ic("map-pin")}${esc(r.commune || r.code_postal || "")}</span>
        ${r.telephone ? `<span>${ic("phone")}${esc(r.telephone)}</span>` : ""}
        <span>${ic("calendar")}${esc(ancienneteLabel(r.anciennete))}</span>
        ${ca ? `<span>CA ${esc(ca)}</span>` : ""}
      </div>
      ${r.thematique_titre ? `<div class="cmd-item__theme">${ic("target")}${esc(r.thematique_titre)}</div>` : ""}
      ${ligneEtat(r)}
    </button>`;
  }
  const GROUPES = [
    { id: "rappel", icone: "rotate-ccw", titre: "Mes rappels du jour", aide: "Vous aviez prévu de rappeler ces entreprises : c'est le moment.", ouvert: true, page: 30 },
    { id: "neuve", icone: "phone", titre: "À appeler", aide: "Jamais appelées. Les plus prometteuses d'abord, dans un ordre qui change chaque jour.", ouvert: true, page: 60 },
    { id: "relance", icone: "refresh-cw", titre: "À relancer", aide: "Déjà appelées, délai écoulé : injoignables, anciens refus, rappels oubliés.", ouvert: false, page: 30 },
    { id: "attente", icone: "clock", titre: "Appelées récemment", aide: "Délai de rappel en cours.", ouvert: false, page: 30 },
    { id: "passee", icone: "skip-forward", titre: "Passées", aide: "Retirées de votre liste pour un temps. Ouvrez une fiche pour l'y remettre.", ouvert: false, page: 30 }
  ];
  // Liste en blocs, chaque bloc avec son propre « Afficher plus ».
  function rendreListe(wrap, rows, source) {
    if (!rows.length) { wrap.innerHTML = `<p class="cmd-empty">Aucune entreprise dans votre secteur pour cette semaine.</p>`; return; }
    const visibles = appliquerFiltres(rows);
    wrap._nb = wrap._nb || {};
    const ouverts = wrap._ouverts || {};
    const html = [];
    for (const g of GROUPES) {
      const lst = visibles.filter(r => (r.bloc || "neuve") === g.id);
      if (!lst.length && g.id !== "neuve") continue;
      const n = Math.min(lst.length, wrap._nb[g.id] || g.page);
      const reste = lst.length - n;
      const ouvert = g.id in ouverts ? ouverts[g.id] : g.ouvert;
      html.push(`<details class="cmd-groupe cmd-groupe--${g.id}" data-groupe="${g.id}" ${ouvert ? "open" : ""}>
        <summary>${ic(g.icone)}<span class="cmd-groupe__titre">${esc(g.titre)}</span><span class="cmd-groupe__nb">${lst.length}</span></summary>
        <p class="muted cmd-groupe__aide">${esc(g.aide)}</p>
        ${lst.length ? lst.slice(0, n).map(carte).join("") : `<p class="cmd-empty">Aucune fiche neuve ne correspond aux filtres${filtres.couleur === "prio" ? " : essayez « Toutes les couleurs »" : ""}.</p>`}
        ${reste > 0 ? `<div class="cmd-row"><button class="btn btn--ghost btn--sm" data-plus="${g.id}">${ic("chevron-down")}Afficher ${Math.min(g.page, reste)} de plus (${reste} restantes)</button></div>` : ""}
      </details>`);
    }
    wrap.innerHTML = html.join("");
    $$(".cmd-item", wrap).forEach(b => b.addEventListener("click", () => ouvrirFiche(source.find(r => r.siret === b.dataset.siret))));
    $$("[data-plus]", wrap).forEach(b => b.addEventListener("click", () => {
      const g = GROUPES.find(x => x.id === b.dataset.plus);
      wrap._nb[g.id] = (wrap._nb[g.id] || g.page) + g.page;
      rendreListe(wrap, rows, source);
    }));
    $$("details[data-groupe]", wrap).forEach(d => d.addEventListener("toggle", () => {
      wrap._ouverts = Object.assign(wrap._ouverts || {}, { [d.dataset.groupe]: d.open });
    }));
  }

  /* ---------- Onglet « Ma liste » ---------- */
  // Une seule semaine affichée : celle du commando (ou la dernière publiée en
  // attendant la publication du lundi). Les rappels passent d'une semaine à l'autre.
  // Rien à dire quand c'est la semaine en cours (elle est dans l'en-tête du commando).
  function quandSemaine() {
    if (!semaine) return "";
    const cible = C().semaineCible();
    if (semaine.semaine === cible) return "";
    return `Listes de la semaine ${C().numSemaine(semaine.semaine)} (${C().periodeSemaine(semaine.semaine)}). Celles de la semaine ${C().numSemaine(cible)} arrivent lundi en fin de matinée.`;
  }
  async function renderListe(el) {
    el.innerHTML = `<div id="listeHead"></div><div id="listeNotifs"></div><div id="listeJeux"></div><div id="listeRdv"></div><div id="listeFiltres"></div><div id="listeBody"></div>`;
  }
  async function showListe(el) {
    el.querySelector("#listeBody").innerHTML = `<p class="cmd-empty"><span class="cmd-spin"></span>Chargement…</p>`;
    await chargerSemaines();
    await chargerSemaine();
    await rendreTete(el);
    if (window.RexCommandoNotifs) window.RexCommandoNotifs.rendre(el.querySelector("#listeNotifs"));
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
    if (!semaine) { head.innerHTML = ""; return; }
    const [c, pts] = await Promise.all([
      C().rpc("commando_ma_semaine", { _semaine_id: semaine.id }).catch(() => ({})),
      C().rpc("commando_mes_points", { _semaine_id: semaine.id }).catch(() => null)
    ]);
    if (pts) ptsSemaine = Number(pts.semaine || 0);
    const obj = Number((c || {}).objectif || 5), rdv = Number((c || {}).rdv || 0);
    const pct = Math.min(100, Math.round(rdv / obj * 100));
    const rappels = Number((c || {}).rappels || 0);
    const quand = quandSemaine();
    head.innerHTML = `<div class="cmd-hero">
        ${quand ? `<div class="cmd-note">${ic("info")}<span>${esc(quand)}</span></div>` : ""}
        <button id="btnSession" class="btn btn--primary cmd-hero__go"></button>
        <p class="cmd-hero__aide">Les fiches s'enchaînent : vous appelez, notez le résultat, la suivante s'ouvre.</p>
        <div class="cmd-hero__stats">
          <div class="cmd-stat"><b>${Number((c || {}).a_appeler || 0)}</b><span>à appeler${rappels ? `, dont ${rappels} rappel${rappels > 1 ? "s" : ""}` : ""}</span></div>
          <div class="cmd-stat"><b>${rdv}<small> / ${obj}</small></b><span>RDV cette semaine</span><div class="cmd-progress"><span style="width:${pct}%"></span></div></div>
          <div class="cmd-stat"><b>${ptsSemaine == null ? "—" : ptsSemaine}</b><span>points cette semaine</span></div>
          <div class="cmd-stat"><b>${Number((c || {}).appels || 0)}</b><span>appels passés</span></div>
        </div>
      </div>`;
    majBoutonSession();
    head.querySelector("#btnSession").addEventListener("click", demarrerSession);
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
    const pts = j.points || null;
    if (!actifs.premier_rdv && !actifs.pronostic && !(j.recompenses || []).length && !pts) { box.innerHTML = ""; return; }
    const heures = Array.isArray(j.heures) ? j.heures.map(Number).sort((a, b) => a - b) : [14, 15, 16];
    const libelleHeures = heures.map(h => `${h}h–${h + 1}h`).join(", ");
    const blocs = [];
    if (pts && (pts.bareme || {}).actif !== false) {
      const b = pts.bareme || {};
      blocs.push(`<div class="cmd-jeu cmd-jeu--points">
        <div class="cmd-jeu__titre">${ic("star")}Mes points</div>
        <div class="cmd-points"><span class="cmd-points__val">${esc(Number(pts.semaine || 0))}</span><span class="cmd-points__lbl">cette semaine</span>
          <span class="cmd-points__val">${esc(Number(pts.total || 0))}</span><span class="cmd-points__lbl">au total</span></div>
        <details class="cmd-points__bareme"><summary>Comment gagner des points</summary>
          <ul><li>Appel passé : <b>${esc(b.appel ?? 1)}</b></li><li>RDV pris : <b>${esc(b.rdv ?? 10)}</b> (repris s'il est annulé)</li>
          <li>RDV honoré, validé par le responsable : <b>${esc(b.rdv_honore ?? 25)}</b></li><li>Premier RDV de l'heure : <b>${esc(b.premier_rdv ?? 15)}</b></li>
          <li>Mail de suivi envoyé après l'appel : <b>${esc(b.mail ?? 5)}</b></li><li>Vote des sujets de la semaine : <b>${esc(b.vote ?? 3)}</b></li><li>Pronostic tenu : <b>${esc(b.pronostic ?? 10)}</b></li><li>Badge de la semaine (Ouvreur, Marathonien, Sniper, Fidèle) : <b>${esc(b.badge ?? 20)}</b> chacun, le lundi suivant</li></ul>
          <div class="muted">Les points se cumulent de semaine en semaine. Le détail est dans l'onglet Ligue.</div></details>
      </div>`);
    }
    if (c.en_jeu === false) {
      const hNow = Number(new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit" }).slice(0, 2));
      const prochaine = heures.find(h => h > hNow);
      blocs.push(`<div class="cmd-jeu"><div class="cmd-jeu__titre">${ic("clock")}Hors créneau</div><div class="muted">Les jeux se jouent pendant les créneaux du commando : ${esc(libelleHeures)}. ${prochaine != null ? `Prochain créneau à ${prochaine}h.` : "À demain !"} Les RDV pris en dehors comptent pour la ligue, mais ne rapportent pas de fiches.</div></div>`);
    }
    if (actifs.premier_rdv && c.en_jeu !== false) {
      const p = c.premier_rdv;
      blocs.push(`<div class="cmd-jeu">
        <div class="cmd-jeu__titre">${ic("medal")}Premier RDV de l'heure</div>
        ${p ? `<div>${p.commercial_id === me ? `<b>C'est vous !</b> RDV à ${esc(heureCourte(p.a))} : vos fiches premium sont dans « Mes fiches gagnées ».` : `<b>${esc(C().prenomDe(p.commercial_id))}</b> à ${esc(heureCourte(p.a))}. Chaque RDV suivant vaut encore une fiche.`}</div>`
            : `<div class="muted">Personne encore sur ce créneau : le premier RDV rapporte 5 fiches premium du secteur libre, les suivants 1 fiche chacun.</div>`}
      </div>`);
    }
    if (actifs.pronostic && c.en_jeu !== false) {
      const pr = c.pronostic;
      let corps;
      if (pr) {
        corps = `<div>Votre pronostic : <b>${esc(pr.annonce)} RDV</b>, pris sur le créneau : <b>${esc(c.mes_rdv || 0)}</b>${pr.resolu ? (pr.reussi ? ` <span class="cmd-badge cmd-badge--ok">Tenu, fiche mystère débloquée</span>` : ` <span class="cmd-badge cmd-badge--gris">Manqué, ça ira mieux au prochain créneau</span>`) : `. <span class="muted">Résultat à la fin du créneau.</span>`}</div>`;
      } else if (c.peut_pronostiquer) {
        corps = `<div class="cmd-row">Combien de RDV sur ce créneau ?
          <select id="jeuProno" class="cmd-sem">${[1, 2, 3, 4, 5].map(v => `<option value="${v}">${v}</option>`).join("")}</select>
          <button id="jeuPronoBtn" class="btn btn--primary btn--sm">Je m'engage</button>
          <span class="muted">Tenir son pronostic débloque une fiche mystère.</span></div>`;
      } else {
        corps = `<div class="muted">Pronostic fermé pour ce créneau : il se fait dans les ${esc(c.delai_min || 20)} premières minutes, avant votre premier RDV.</div>`;
      }
      const passes = (j.pronostics_jour || []).filter(p => p.resolu);
      blocs.push(`<div class="cmd-jeu"><div class="cmd-jeu__titre">${ic("target")}Pronostic du créneau ${esc(creneauCourt(c.debut))}</div>${corps}
        ${passes.length ? `<div class="muted" style="margin-top:6px">Aujourd'hui : ${passes.map(p => `${esc(creneauCourt(p.creneau))}, ${esc(p.annonce)} annoncé${p.annonce > 1 ? "s" : ""} pour ${esc(p.rdv_realises)} pris (${p.reussi ? "tenu" : "manqué"})`).join(" ; ")}</div>` : ""}</div>`);
    }
    const rec = j.recompenses || [];
    blocs.push(`<div class="cmd-jeu"><div class="cmd-jeu__titre">${ic("gift")}Mes fiches gagnées <span class="muted">${rec.length}, dont ${esc(j.nb_recompenses_semaine || 0)} sur ${esc(j.max_fiches_semaine || 15)} cette semaine</span></div>
      ${rec.length ? `<div id="jeuRecompenses"></div>` : `<div class="muted">Aucune pour le moment. Les fiches gagnées viennent du secteur libre et vous sont réservées.</div>`}</div>`);
    // Replié par défaut ; ouvert tout seul quand un pronostic attend le commercial.
    const resume = [c.en_jeu === false ? "hors créneau" : `créneau ${creneauCourt(c.debut)}`,
      actifs.premier_rdv && c.en_jeu !== false ? (c.premier_rdv ? `1er RDV : ${c.premier_rdv.commercial_id === me ? "vous" : C().prenomDe(c.premier_rdv.commercial_id)}` : "1er RDV à prendre") : "",
      c.peut_pronostiquer && !c.pronostic ? "pronostic à faire" : "",
      rec.length ? `${rec.length} fiche${rec.length > 1 ? "s" : ""} gagnée${rec.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
    const ouvert = jeuxOuvert != null ? jeuxOuvert : !!(c.peut_pronostiquer && !c.pronostic);
    box.innerHTML = `<details class="cmd-card cmd-card--jeux cmd-jeux-det" ${ouvert ? "open" : ""}><summary><b>${ic("trophy")}Jeux de l'heure</b> <span class="muted">${esc(resume.charAt(0).toUpperCase() + resume.slice(1))}</span></summary>${blocs.join("")}</details>`;
    box.querySelector("details").addEventListener("toggle", (e) => { jeuxOuvert = e.target.open; });
    const btn = box.querySelector("#jeuPronoBtn");
    if (btn) btn.addEventListener("click", async () => {
      try {
        await C().rpc("commando_pronostic", { _semaine_id: semaine.id, _annonce: Number(box.querySelector("#jeuProno").value) });
        C().toast("Pronostic enregistré, bonne chance");
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
      <b>${ic("calendar-check")}${list.length} rendez-vous à confirmer</b> <span class="muted">Ce RDV a-t-il eu lieu ?</span>
      ${list.map(a => `<div class="cmd-bandeau__item" data-id="${a.id}">
        <span><b>${esc(nom[a.siret] || a.siret)}</b><br><span class="muted">${esc(C().fmtDateTime(a.date_rdv))}</span></span>
        <span class="cmd-bandeau__btns">
          <button class="btn btn--sm" data-rdv="honore">${ic("check")}Honoré</button>
          <button class="btn btn--sm" data-rdv="reporte">${ic("calendar-clock")}Reporté</button>
          <button class="btn btn--sm btn--danger" data-rdv="annule">${ic("x")}Annulé</button>
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
    const quand = quandSemaine();
    el.querySelector("#themHead").innerHTML = quand ? `<div class="cmd-note">${ic("info")}<span>${esc(quand)}</span></div>` : "";
    if (!semaine) { el.querySelector("#themBody").innerHTML = `<p class="cmd-empty">Aucune semaine publiée pour le moment.</p>`; return; }
    el.querySelector("#themTabs").innerHTML = thematiques.map(t => `<button class="tab ${t.id === themeActif ? "tab--active" : ""}" data-theme="${t.id}">${esc(t.titre)}</button>`).join("");
    $$("[data-theme]", el).forEach(b => b.addEventListener("click", () => { themeActif = b.dataset.theme; showThemes(el); }));
    const t = thematiques.find(x => x.id === themeActif);
    if (!t) { el.querySelector("#themBody").innerHTML = `<p class="cmd-empty">Aucune thématique retenue.</p>`; return; }
    el.querySelector("#themIntro").innerHTML = `<div class="cmd-card cmd-card--theme"><h3>${esc(t.titre)}</h3>${t.offre_rex ? `<div class="cmd-offre">${ic("target")}Offre Rex : ${esc(t.offre_rex)}</div>` : ""}<p>${C().gras(t.pourquoi_maintenant)}</p></div>`;
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
    const g = (txt) => C().gras(remplir(txt, r));
    const note = couleur ? "" : (r && r.complement
      ? `<div class="cmd-note">Fiche ajoutée pour compléter votre liste : elle ne correspond à aucun sujet de la semaine. La trame orange de « ${esc((t && t.titre) || "")} » est proposée, adaptez l'accroche${r.signal ? " (ou partez de l'actualité ci-dessus)" : ""}.</div>`
      : `<div class="cmd-note">Entreprise non classée pour cette thématique : la trame orange est proposée par défaut.</div>`);
    if (!tr.accroche && !tr.argument) return note + `<p class="muted">Aucune trame disponible pour cette couleur.</p>`;
    return note + `
      <div class="cmd-trame cmd-trame--${c}">
        ${(tr.points_cles || []).length ? `<ul class="cmd-trame__cles">${tr.points_cles.map(k => `<li>${g(k)}</li>`).join("")}</ul>` : ""}
        <div class="cmd-trame__bloc"><b>Accroche</b><p>${g(tr.accroche)}</p></div>
        ${(tr.questions_decouverte || []).length ? `<div class="cmd-trame__bloc"><b>Questions</b><ol>${tr.questions_decouverte.map(q => `<li>${g(q)}</li>`).join("")}</ol></div>` : ""}
        ${tr.argument ? `<div class="cmd-trame__bloc"><b>Argument</b><p>${g(tr.argument)}</p></div>` : ""}
        ${tr.conclusion ? `<div class="cmd-trame__bloc"><b>Conclusion</b><p>${g(tr.conclusion)}</p></div>` : ""}
      </div>`;
  }
  function objectionsHtml(t) {
    const obj = (t && t.objections) || [];
    if (!obj.length) return "";
    return `<details class="cmd-obj"><summary>Objections probables (${obj.length})</summary>${obj.map(o => `<div class="cmd-obj__item"><b>« ${esc(o.objection)} »</b><p>${C().gras(o.reponse)}</p></div>`).join("")}</details>`;
  }
  let ficheEl = null;
  let dernierAppelMoi = null;   // dernier appel du commercial connecté sur l'entreprise ouverte (7 jours)
  const CRENEAUX_DEFAUT = "mardi matin ou jeudi après-midi";
  function texteMail(txt, r, extra) {
    const base = remplir(String(txt || "").replace(/\*\*/g, ""), r);
    return base.replace(/\{(\w+)\}/g, (m, k) => (k in extra ? extra[k] : m));
  }
  // Mail de suivi : variante selon le dernier appel, aperçu, ouverture dans la messagerie du commercial (mailto).
  function rendreMail(el, t, r) {
    const box = $("#ficheMailBloc", el); if (!box) return;
    const mails = (t && t.mails) || {};
    if (!mails.rdv && !mails.suite) { box.innerHTML = ""; return; }
    const a = dernierAppelMoi;
    const rdvPris = !!(a && a.statut === "rdv" && a.date_rdv);
    let variante = rdvPris && mails.rdv ? "rdv" : (mails.suite ? "suite" : "rdv");
    const dateRdv = rdvPris ? C().fmtDateTime(a.date_rdv) : "";
    const dessiner = () => {
      const m = mails[variante] || {};
      const extra = { date_rdv: ($("#mailDate", box) || {}).value || dateRdv || "{date_rdv}", creneaux: ($("#mailCreneaux", box) || {}).value || CRENEAUX_DEFAUT };
      const objet = texteMail(m.objet, r, extra), corps = texteMail(m.corps, r, extra);
      box.innerHTML = `<div class="cmd-mail">
        <div class="cmd-row"><b>${ic("mail")}Mail de suivi</b>
          <select id="mailVariante" class="cmd-sem">${mails.rdv ? `<option value="rdv" ${variante === "rdv" ? "selected" : ""}>RDV confirmé</option>` : ""}${mails.suite ? `<option value="suite" ${variante === "suite" ? "selected" : ""}>Suite à notre échange</option>` : ""}</select>
          ${variante === "rdv" ? `<input id="mailDate" type="text" class="cmd-mail__champ" value="${esc(extra.date_rdv === "{date_rdv}" ? "" : extra.date_rdv)}" placeholder="date et heure du RDV" />` : `<input id="mailCreneaux" type="text" class="cmd-mail__champ" value="${esc(extra.creneaux)}" placeholder="deux créneaux proposés" />`}
        </div>
        <div class="cmd-mail__apercu"><div class="cmd-mail__objet">Objet : ${esc(objet)}</div><pre class="cmd-mail__corps">${esc(corps)}</pre></div>
        <div class="cmd-row">
          <button id="mailOuvrir" class="btn btn--primary btn--sm" ${r.email ? "" : "disabled"}>${ic("mail")}Ouvrir dans ma messagerie</button>
          <span class="muted">${r.email ? `À ${esc(r.email)}. Le mail part de votre boîte : relisez-le avant d'envoyer.` : "Saisissez l'e-mail du contact (Entreprise et coordonnées) pour activer l'envoi."}</span>
        </div>
        ${a && a.mail_prepare_le ? `<div class="muted">${ic("check")} Mail ${a.mail_variante === "rdv" ? "de confirmation" : "de suivi"} déjà ouvert le ${esc(C().fmtDateTime(a.mail_prepare_le))}.</div>` : ""}
      </div>`;
      $("#mailVariante", box).addEventListener("change", (e) => { variante = e.target.value; dessiner(); });
      const champ = $("#mailDate", box) || $("#mailCreneaux", box);
      if (champ) champ.addEventListener("change", dessiner);
      $("#mailOuvrir", box).addEventListener("click", async () => {
        const email = r.email;
        const btn = $("#mailOuvrir", box); btn.disabled = true;
        try {
          const res = await C().rpc("commando_mail_preparer", { _siret: r.siret, _variante: variante });
          const pts = res && res.points && res.points.bareme ? Number(res.points.bareme.mail || 0) : 0;
          if (!res.deja && pts) C().toast(`Mail prêt dans votre messagerie, +${pts} points`); else C().toast("Mail prêt dans votre messagerie");
          if (a) { a.mail_prepare_le = a.mail_prepare_le || new Date().toISOString(); a.mail_variante = variante; }
        } catch (e) { btn.disabled = false; C().toast(C().erreur(e)); return; }
        const href = "mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(objet) + "&body=" + encodeURIComponent(corps.replace(/\n/g, "\r\n"));
        window.location.href = href;
        btn.disabled = false;
        dessiner();
      });
    };
    dessiner();
  }
  /* ---------- Mode Commando : les fiches s'enchaînent ---------- */
  // « Démarrer » ouvre la première fiche (rappels du jour, puis fiches neuves,
  // avec les filtres affichés) ; après chaque résultat enregistré, la fiche
  // suivante s'ouvre toute seule. Compteurs et points de la session en direct.
  const session = { actif: false, file: [], index: -1, appels: 0, rdv: 0, points: 0 };
  let ptsSemaine = null;      // points de la semaine connus (pour afficher le gain après un appel)
  const ligneDe = (siret) => lignes.find(x => x.siret === siret);
  function fileSession() {
    const v = appliquerFiltres(lignes);
    return v.filter(r => r.bloc === "rappel").concat(v.filter(r => r.bloc === "neuve")).map(r => r.siret);
  }
  function demarrerSession() {
    if (session.actif) { const r = ligneDe(session.file[session.index]); if (r && (r.bloc === "neuve" || r.bloc === "rappel")) { ouvrirFiche(r); return; } ficheSuivante(); return; }
    const file = fileSession();
    if (!file.length) { C().toast("Aucune fiche à appeler avec ces filtres"); return; }
    Object.assign(session, { actif: true, file, index: 0, appels: 0, rdv: 0, points: 0 });
    majBoutonSession();
    ouvrirFiche(ligneDe(file[0]));
  }
  function ficheSuivante() {
    while (++session.index < session.file.length) {
      const r = ligneDe(session.file[session.index]);
      if (r && (r.bloc === "neuve" || r.bloc === "rappel")) { majBoutonSession(); ouvrirFiche(r); return; }
    }
    terminerSession(true);
  }
  function terminerSession(fini) {
    if (!session.actif) return;
    session.actif = false;
    fermerFiche();
    C().toast((fini ? "Liste terminée, bravo : " : "Session terminée : ") + `${session.appels} appel${session.appels > 1 ? "s" : ""}, ${session.rdv} RDV${session.points ? `, +${session.points} points` : ""}`);
    majBoutonSession();
  }
  function majBoutonSession() {
    const b = document.querySelector("#btnSession"); if (!b) return;
    b.innerHTML = ic("play") + (session.actif ? `<span>Reprendre le commando, fiche ${Math.min(session.index + 1, session.file.length)} sur ${session.file.length}</span>` : "<span>Démarrer le commando</span>");
  }
  function barreSession() {
    if (!session.actif) return "";
    const n = session.file.length, i = Math.min(session.index + 1, n);
    return `<div class="cmd-session" role="status" aria-label="Session d'appels en cours">
      <div class="cmd-session__info"><span class="cmd-session__live" aria-hidden="true"></span><span class="cmd-session__pos">Fiche ${i} sur ${n}</span>
        <span class="cmd-session__stats"><span title="Appels">${ic("phone")}${session.appels}</span><span title="RDV">${ic("calendar-check")}${session.rdv}</span>${session.points ? `<span title="Points">${ic("star")}+${session.points}</span>` : ""}</span></div>
      <div class="cmd-session__btns"><button class="btn btn--sm" data-session="suivante">${ic("skip-forward")}Suivante</button><button class="btn btn--sm" data-session="fin">${ic("square")}Terminer</button></div>
      <span class="cmd-session__prog" style="width:${Math.round(i / Math.max(1, n) * 100)}%"></span>
    </div>`;
  }
  // Points crédités tout de suite après un appel : renvoie le gain depuis le dernier relevé.
  async function gainPoints() {
    if (!semaine) return 0;
    try {
      const p = await C().rpc("commando_mes_points", { _semaine_id: semaine.id });
      const avant = ptsSemaine, apres = Number((p && p.semaine) || 0);
      ptsSemaine = apres;
      return avant == null ? 0 : Math.max(0, apres - avant);
    } catch (e) { return 0; }
  }
  // Lien d'appel : un tap sur téléphone lance l'appel (numéro nettoyé).
  function lienTel(tel) {
    const n = String(tel || "").replace(/[^0-9+]/g, "");
    return n.length >= 6 ? "tel:" + n : "";
  }

  async function ouvrirFiche(r) {
    if (!r) return;
    const t = thematiques.find(x => x.id === r.thematique_id);
    const me = C().me();
    if (!ficheEl) {
      ficheEl = document.createElement("div");
      ficheEl.className = "modal cmd-ui"; ficheEl.id = "ficheModal";
      document.body.appendChild(ficheEl);
    }
    const regleTxt = r.couleur
      ? `${COULEUR_LABEL[r.couleur]} — règle ${Number(r.regle_index) + 1} : ${esc(r.raison || "")}`
      : (r.complement ? "Complément : aucun sujet de la semaine ne la vise, mais votre liste comptait moins de fiches neuves que le minimum prévu. Choisie parmi les plus prometteuses (actualité, numéro connu, taille)." : "Non classée : aucune règle de la thématique ne correspond.");
    const dans7j = new Date(); dans7j.setDate(dans7j.getDate() + 7);
    const qui = dirigeantLabel(r.dirigeants);
    const rechercheWeb = "https://www.google.com/search?q=" + encodeURIComponent((r.enseigne || r.raison_sociale || "") + " " + (r.commune || r.code_postal || "") + " téléphone");
    ficheEl.innerHTML = `
      <div class="modal__backdrop" data-fiche-close></div>
      <div class="modal__panel cmd-fiche-panel" role="dialog" aria-modal="true" aria-label="${esc(r.raison_sociale)}">
        <div class="modal__header">
          <div class="cmd-fiche__titre">
            <h2>${esc(r.raison_sociale)}</h2>
            <div class="cmd-fiche__sub">${r.complement ? `<span class="cmd-badge cmd-badge--compl">Complément</span>` : badgeCouleur(r.couleur)}${r.est_nouvelle ? `<span class="cmd-badge cmd-badge--info">Nouvelle</span>` : ""}${r.signal ? badgeSignal(r) : ""}</div>
            <div class="cmd-fiche__qui"><span>${ic("user")}${esc(qui || "Dirigeant non renseigné")}</span><span>${ic("map-pin")}${esc(r.commune || r.code_postal || "")}</span>${r.naf_libelle ? `<span>${ic("building-2")}${esc(r.naf_libelle)}</span>` : ""}</div>
          </div>
          <button class="modal__close" data-fiche-close aria-label="Fermer">${ic("x")}</button>
        </div>
        ${barreSession()}
        <div class="modal__body cmd-fiche">
          <div id="ficheAppel" class="cmd-appel"></div>
          <div id="ficheTelSource" class="muted cmd-appel__source"></div>
          ${r.bloc === "rappel" ? `<div class="cmd-item__warn cmd-item__warn--rappel">${ic("rotate-ccw")}<span>Rappel prévu le ${esc(C().fmtDate(r.bloquee_jusqua))} (appel du ${esc(C().fmtDate(r.dernier_appel_le))} par ${esc(C().prenomDe(r.dernier_appel_par))}).</span></div>` : ""}
          ${r.deja_appelee ? `<div class="cmd-item__warn">${ic("phone")}<span>Déjà appelée : ${esc(STATUTS[r.dernier_appel_statut] || "")} le ${esc(C().fmtDate(r.dernier_appel_le))} par ${esc(C().prenomDe(r.dernier_appel_par))}. Rappel possible à partir du ${esc(C().fmtDate(r.bloquee_jusqua))}.</span></div>` : ""}
          ${r.signal ? `<div class="cmd-signal"><b>${ic("newspaper")}${esc(r.signal)}</b> <span class="muted" style="display:inline">BODACC du ${esc(C().fmtDate(r.signal_le))}</span>${r.signal_url ? ` <a href="${esc(r.signal_url)}" target="_blank" rel="noopener">Voir l'annonce</a>` : ""}${CONSEIL_SIGNAL[r.signal_type] ? `<div class="muted">${esc(CONSEIL_SIGNAL[r.signal_type])}</div>` : ""}</div>` : ""}
          <h3 class="output-title cmd-fiche__sujet">${ic("target")}${esc(r.thematique_titre || "Trame d'appel")}</h3>
          ${trameHtml(t, r.couleur, r)}
          ${objectionsHtml(t)}
          <div id="ficheMailBloc"></div>
          <details class="cmd-fiche__det">
            <summary>${ic("building-2")}Entreprise et coordonnées</summary>
            <div class="cmd-fiche__grid">
              <div><small>Activité</small>${esc(r.naf_libelle || "—")} <span class="muted">(${esc(r.naf_code || "")})</span></div>
              <div><small>Effectif</small>${esc(trancheLabel(r.tranche_effectif, r.annee_effectif))}</div>
              <div><small>Ancienneté</small>${esc(ancienneteLabel(r.anciennete))}${r.date_creation_ul ? ` <span class="muted">(créée le ${esc(C().fmtDate(r.date_creation_ul))})</span>` : ""}</div>
              <div><small>Dirigeant</small>${esc(qui || "non renseigné")}</div>
              ${r.ca ? `<div><small>Chiffre d'affaires</small>${esc(fmtCA(r.ca))}${r.ca_annee ? ` <span class="muted">(${esc(r.ca_annee)})</span>` : ""}</div>` : ""}
              <div class="wide"><small>Adresse</small>${esc(r.adresse || "")}${r.enseigne ? ` <span class="muted">· enseigne ${esc(r.enseigne)}</span>` : ""}</div>
              <div><small>Téléphone</small><input id="ficheTel" type="tel" value="${esc(r.telephone || "")}" placeholder="05 49 …" /></div>
              <div><small>E-mail</small><input id="ficheMail" type="email" value="${esc(r.email || "")}" placeholder="contact@…" /></div>
            </div>
            <div class="cmd-row"><button id="ficheSaveContact" class="btn btn--sm">Enregistrer les coordonnées</button><button id="ficheOppo" class="btn btn--ghost btn--sm">${ic("ban")}Ne plus contacter (opposition)</button></div>
          </details>
          <details class="cmd-fiche__det"><summary>${ic("info")}Pourquoi cette fiche</summary><p class="cmd-regle">${regleTxt}</p></details>
          <details class="cmd-fiche__det"><summary>${ic("history")}Historique des appels <span id="ficheHistNb" class="muted"></span></summary><div id="ficheHist"><span class="cmd-spin"></span></div></details>
          <div id="fichePasser" class="cmd-passer"></div>
        </div>
        <div class="cmd-resultat cmd-resultat--fixe">
          <div id="resExtra" class="cmd-resultat__extra" hidden>
            <label id="resRappelLbl" hidden>Rappeler le<input id="resRappel" type="date" value="${dans7j.toISOString().slice(0, 10)}" /></label>
            <label id="resRdvLbl" hidden>Date et heure du RDV<input id="resRdv" type="datetime-local" /></label>
            <label>Numéro composé <span class="muted">(gardé sur la fiche pour toute l'équipe)</span><input id="resTel" type="tel" value="${esc(r.telephone || "")}" placeholder="05 49 …" /></label>
            ${r.email ? "" : `<label>E-mail du contact <span class="muted">(pour le mail de suivi, demandez-le en fin d'appel)</span><input id="resMail" type="email" placeholder="prenom.nom@entreprise.fr" /></label>`}
            <label>Note (facultatif)<textarea id="resNote" rows="2" placeholder="Interlocuteur, contexte, prochaine étape…"></textarea></label>
            <div class="cmd-row"><button id="resSave" class="btn btn--primary">${session.actif ? `Enregistrer et passer à la suivante${ic("skip-forward")}` : "Enregistrer"}</button><span id="resErr" class="cmd-err" hidden></span></div>
          </div>
          <div class="cmd-resultat__btns" role="group" aria-label="Résultat de l'appel">
            <button class="btn" data-statut="injoignable">${ic("phone-missed")}<span>Injoignable</span></button>
            <button class="btn" data-statut="rappeler">${ic("rotate-ccw")}<span>Rappeler</span></button>
            <button class="btn" data-statut="refus">${ic("x")}<span>Refus</span></button>
            <button class="btn btn--rdv" data-statut="rdv">${ic("calendar-check")}<span>RDV</span></button>
          </div>
        </div>
      </div>`;
    ficheEl.hidden = false;
    document.body.style.overflow = "hidden";
    $$("[data-fiche-close]", ficheEl).forEach(x => x.addEventListener("click", fermerFiche));
    $$("[data-session]", ficheEl).forEach(x => x.addEventListener("click", () => x.dataset.session === "fin" ? terminerSession(false) : ficheSuivante()));

    // Bloc d'appel : un bouton « Appeler » si le numéro est connu, sinon de quoi le trouver.
    const majAppel = () => {
      const box = $("#ficheAppel", ficheEl); if (!box) return;
      const tel = r.telephone || "";
      const href = lienTel(tel);
      box.innerHTML = href
        ? `<a class="btn btn--appel" href="${esc(href)}">${ic("phone")}<span>Appeler</span><span class="cmd-appel__num">${esc(tel)}</span></a>`
        : `<div class="cmd-appel__vide"><span><b>Pas encore de numéro.</b> Trouvez-le puis collez-le ici : il servira à toute l'équipe.</span>
            <div class="cmd-row"><input id="appelTel" type="tel" placeholder="05 49 …" aria-label="Numéro de téléphone" /><button id="appelTelOk" class="btn btn--sm">Enregistrer</button></div>
            <div class="cmd-row"><button id="ficheTelOsm" class="btn btn--sm" title="Recherche gratuite dans OpenStreetMap">${ic("search")}Chercher dans OpenStreetMap</button><a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="${esc(rechercheWeb)}">${ic("globe")}Chercher sur le web</a></div></div>`;
      const ok = $("#appelTelOk", box);
      if (ok) ok.addEventListener("click", async () => {
        const v = $("#appelTel", box).value.trim();
        if (!lienTel(v)) { C().toast("Numéro incomplet"); return; }
        const { error } = await sb().from("commando_contacts").upsert({ siret: r.siret, telephone: v, source: "manuel", updated_by: me.id }, { onConflict: "siret" });
        if (error) { C().toast("Échec : " + error.message); return; }
        r.telephone = v; $("#ficheTel", ficheEl).value = v; $("#resTel", ficheEl).value = v;
        $("#ficheTelSource", ficheEl).textContent = "Numéro saisi par l'équipe.";
        C().toast("Numéro enregistré pour l'équipe"); majAppel();
      });
      const telOsm = $("#ficheTelOsm", box);
      if (telOsm) telOsm.addEventListener("click", async () => {
        telOsm.disabled = true; telOsm.textContent = "Recherche…";
        try {
          const res = await C().fn("commando-telephones", { siret: r.siret });
          const c = res && res.contact;
          if (c && c.telephone) {
            r.telephone = c.telephone; $("#ficheTel", ficheEl).value = c.telephone; $("#resTel", ficheEl).value = c.telephone;
            $("#ficheTelSource", ficheEl).textContent = "Téléphone trouvé dans OpenStreetMap (© les contributeurs OpenStreetMap)" + (c.site_web ? " · site : " + c.site_web : "") + " — à confirmer au premier appel.";
            C().toast("Téléphone trouvé"); majAppel();
          } else { telOsm.textContent = "Introuvable dans OpenStreetMap"; }
        } catch (e) { telOsm.disabled = false; telOsm.innerHTML = ic("search") + "Chercher dans OpenStreetMap"; C().toast(C().erreur(e)); }
      });
    };
    majAppel();

    // Source du téléphone (attribution OpenStreetMap)
    sb().from("commando_contacts").select("source, source_detail, site_web").eq("siret", r.siret).maybeSingle().then(({ data }) => {
      const s = $("#ficheTelSource", ficheEl); if (!s || !data || !r.telephone) return;
      if (data.source === "osm") s.textContent = "Téléphone trouvé dans OpenStreetMap (© les contributeurs OpenStreetMap)" + (data.site_web ? " · site : " + data.site_web : "") + " — à confirmer au premier appel.";
      else if (data.source === "rge") s.textContent = "Numéro de l'annuaire RGE de l'ADEME (déclaré par l'entreprise) — à confirmer au premier appel.";
      else if (data.source === "finess") s.textContent = "Numéro du fichier FINESS (établissements de santé et médico-sociaux) — à confirmer au premier appel.";
      else if (data.source === "manuel") s.textContent = "Numéro saisi par l'équipe.";
    });

    rendrePasser(r);

    // Coordonnées
    $("#ficheSaveContact", ficheEl).addEventListener("click", async () => {
      const row = { siret: r.siret, telephone: $("#ficheTel", ficheEl).value.trim() || null, email: $("#ficheMail", ficheEl).value.trim() || null, updated_by: me.id, source: "manuel" };
      const { error } = await sb().from("commando_contacts").upsert(row, { onConflict: "siret" });
      if (error) { C().toast("Échec : " + error.message); return; }
      r.telephone = row.telephone; r.email = row.email;
      C().toast("Coordonnées enregistrées");
      majAppel();
      rendreMail(ficheEl, t, r);
    });
    $("#ficheOppo", ficheEl).addEventListener("click", async () => {
      if (!confirm("Marquer « " + r.raison_sociale + " » en opposition ?\nL'entreprise ne sera plus jamais proposée dans les listes d'appel.")) return;
      const { error } = await sb().from("commando_contacts").upsert({ siret: r.siret, opposition: true, opposition_le: new Date().toISOString(), updated_by: me.id }, { onConflict: "siret" });
      if (error) { C().toast("Échec : " + error.message); return; }
      C().toast("Opposition enregistrée");
      await rafraichir();
      if (session.actif) ficheSuivante(); else fermerFiche();
    });

    // Résultat d'appel
    let statut = null;
    $$("[data-statut]", ficheEl).forEach(b => b.addEventListener("click", () => {
      statut = b.dataset.statut;
      $$("[data-statut]", ficheEl).forEach(x => x.classList.toggle("is-choisi", x === b));
      $("#resExtra", ficheEl).hidden = false;
      $("#resRappelLbl", ficheEl).hidden = statut !== "rappeler";
      $("#resRdvLbl", ficheEl).hidden = statut !== "rdv";
      const rt = $("#resTel", ficheEl), ft = $("#ficheTel", ficheEl);
      if (rt && ft && !rt.value.trim() && ft.value.trim()) rt.value = ft.value.trim();
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
      const telSaisi = (($("#resTel", ficheEl) || {}).value || "").trim();
      if (telSaisi && telSaisi !== (r.telephone || "")) {
        const { error: tErr } = await sb().from("commando_contacts").upsert({ siret: r.siret, telephone: telSaisi, source: "manuel", updated_by: me.id }, { onConflict: "siret" });
        if (tErr) { b.disabled = false; err.textContent = "Numéro non enregistré : " + tErr.message; err.hidden = false; return; }
        r.telephone = telSaisi;
      }
      const mailSaisi = ($("#resMail", ficheEl) || {}).value || "";
      if (mailSaisi.trim()) {
        const { error: mErr } = await sb().from("commando_contacts").upsert({ siret: r.siret, email: mailSaisi.trim(), updated_by: me.id }, { onConflict: "siret" });
        if (mErr) { b.disabled = false; err.textContent = "E-mail non enregistré : " + mErr.message; err.hidden = false; return; }
        r.email = mailSaisi.trim();
      }
      const { error } = await sb().from("commando_appels").insert(row);
      if (error) { b.disabled = false; err.textContent = "Échec : " + error.message; err.hidden = false; return; }
      dernierAppelMoi = { statut, date_rdv: row.date_rdv || null, created_at: new Date().toISOString() };
      const gain = await gainPoints();
      if (session.actif) { session.appels++; if (statut === "rdv") session.rdv++; session.points += gain; }
      const bravo = statut === "rdv" ? "RDV enregistré, bravo" : "Appel enregistré";
      const pts = gain ? `, +${gain} point${gain > 1 ? "s" : ""}` : "";
      await rafraichir();
      b.disabled = false;
      // Mail de suivi : si la thématique en a un et que l'e-mail est connu, on reste sur la fiche pour l'envoyer.
      if (t && t.mails && (t.mails.rdv || t.mails.suite) && r.email) {
        C().toast(bravo + pts + ". Le mail de suivi est prêt.");
        $("#resExtra", ficheEl).hidden = true;
        $$("[data-statut]", ficheEl).forEach(x => x.disabled = true);
        rendreMail(ficheEl, t, r);
        const sbar = $(".cmd-session", ficheEl); if (sbar) sbar.outerHTML = barreSession();
        $$("[data-session]", ficheEl).forEach(x => x.addEventListener("click", () => x.dataset.session === "fin" ? terminerSession(false) : ficheSuivante()));
        const m = $("#ficheMailBloc", ficheEl); if (m) m.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      C().toast(bravo + pts);
      if (session.actif) ficheSuivante(); else fermerFiche();
    });

    // Historique
    const { data: hist } = await sb().from("commando_appels").select("*").eq("siret", r.siret).order("created_at", { ascending: false }).limit(8);
    dernierAppelMoi = (hist || []).find(a => a.commercial_id === me.id && (Date.now() - new Date(a.created_at).getTime()) < 7 * 86400000) || null;
    rendreMail(ficheEl, t, r);
    const h = $("#ficheHist", ficheEl);
    if (!h) return;
    const nb = $("#ficheHistNb", ficheEl); if (nb) nb.textContent = (hist || []).length ? `(${hist.length})` : "(jamais appelée)";
    h.innerHTML = (hist || []).length ? `<ul class="cmd-hist">${hist.map(a => `<li><b>${esc(STATUTS[a.statut] || a.statut)}</b>${a.statut === "rdv" ? ` (${esc(C().fmtDateTime(a.date_rdv))}, ${esc(RDV_STATUTS[a.rdv_statut] || "")})` : ""}${a.statut === "rappeler" && a.date_rappel ? ` (le ${esc(C().fmtDate(a.date_rappel))})` : ""}<br><span class="muted">${esc(C().fmtDateTime(a.created_at))}, ${esc(C().prenomDe(a.commercial_id))}${a.couleur_au_moment ? `, cible ${esc(COULEUR_LABEL[a.couleur_au_moment].toLowerCase())}` : ""}${a.mail_prepare_le ? `, mail ${a.mail_variante === "rdv" ? "de confirmation" : "de suivi"} envoyé` : ""}</span>${a.note ? `<br>${esc(a.note)}` : ""}</li>`).join("")}</ul>` : `<p class="muted">Jamais appelée.</p>`;
  }
  // « Passer » : la fiche quitte la liste (8 semaines, 52 si fermée ou doublon).
  function rendrePasser(r) {
    const box = $("#fichePasser", ficheEl); if (!box) return;
    if (r.bloc === "passee") {
      box.innerHTML = `<div class="cmd-row"><span class="muted">Fiche passée (${esc(RAISONS_PASSER[r.passee_raison] || "")}) jusqu'au ${esc(C().fmtDate(r.passee_jusqua))}.</span><button id="passerAnnuler" class="btn btn--sm">${ic("undo-2")}Remettre dans ma liste</button></div>`;
      $("#passerAnnuler", box).addEventListener("click", async () => {
        try { await C().rpc("commando_passer_annuler", { _siret: r.siret }); } catch (e) { C().toast(C().erreur(e)); return; }
        C().toast("Fiche remise dans votre liste"); fermerFiche(); rafraichir();
      });
      return;
    }
    box.innerHTML = `<details class="cmd-passer__det"><summary>${ic("skip-forward")}Passer cette fiche</summary>
      <div class="cmd-row"><select id="passerRaison" class="cmd-sem">${Object.entries(RAISONS_PASSER).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <button id="passerOk" class="btn btn--sm">Passer</button>
      <span class="muted">Elle disparaît de votre liste pendant 8 semaines (un an si fermée ou doublon).</span></div></details>`;
    $("#passerOk", box).addEventListener("click", async () => {
      const raison = $("#passerRaison", box).value;
      try { await C().rpc("commando_passer", { _siret: r.siret, _raison: raison }); } catch (e) { C().toast(C().erreur(e)); return; }
      C().toast("Fiche passée");
      await rafraichir();
      if (session.actif) ficheSuivante(); else fermerFiche();
    });
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

  C().registerTab({ id: "liste", label: "Ma liste", icone: "list", render: renderListe, onShow: showListe });
  C().registerTab({ id: "thematiques", label: "Thématiques", icone: "layers", render: renderThemes, onShow: showThemes });
  window.RexCommandoListe = { rafraichir };
})();
