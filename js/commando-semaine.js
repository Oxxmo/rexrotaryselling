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
  let voteEtat = null;      // état du vote de la semaine affichée (commando_vote_etat)
  let consultation = false; // semaine passée ouverte depuis « Semaines précédentes » (lecture seule)
  const ic = (x) => C().ic(x);
  const num = (s) => C().numSemaine(s);
  const periode = (s) => { const p = C().periodeSemaine(s); return p.charAt(0).toUpperCase() + p.slice(1); };

  /* ---------- Chargement ---------- */
  // Par défaut, la semaine du commando (semaineCible). Une semaine passée ne
  // s'ouvre que depuis « Semaines précédentes », en lecture seule.
  async function charger() {
    const [s, p] = await Promise.all([
      sb().from("commando_semaines").select("*").order("semaine", { ascending: false }).limit(16).then(r => r.data || []),
      sb().from("commando_parametres").select("*").eq("id", true).single().then(r => r.data)
    ]);
    semaines = s; parametres = p;
    const cible = C().semaineCible();
    const ouverte = consultation && semaine && semaines.find(x => x.id === semaine.id);
    if (ouverte) semaine = ouverte;
    else { consultation = false; semaine = semaines.find(x => x.semaine === cible) || null; }
    if (semaine) {
      const [t, g] = await Promise.all([
        sb().from("commando_thematiques").select("*").eq("semaine_id", semaine.id).order("ordre").then(r => r.data || []),
        sb().from("commando_generations").select("*").eq("semaine_id", semaine.id).order("lancee_le", { ascending: false }).then(r => r.data || [])
      ]);
      thematiques = t; generations = g;
      try { voteEtat = await C().rpc("commando_vote_etat", { _semaine_id: semaine.id }); } catch (e) { voteEtat = null; }
    } else { thematiques = []; generations = []; voteEtat = null; }
  }

  /* ---------- Rendu principal ---------- */
  async function render(el) {
    el.innerHTML = `<div id="semHead"></div><div id="semCockpit"></div><div id="semNotifs"></div><div id="semValider"></div><div id="semVeille"></div><div id="semProps"></div><div id="semVote"></div><div id="semPub"></div><div id="semSuivi"></div><div id="semHisto"></div>`;
  }
  async function show(el) {
    await charger();
    rendreTete(el);
    rendreCockpit(el);
    rendreValidation(el);
    rendreVeille(el);
    rendrePropositions(el);
    rendreVote(el);
    rendrePublication(el);
    await rendreSuivi(el);
    rendreHistorique(el);
    if (!consultation && generations.some(g => g.statut === "en_cours")) C().poll(() => show(el), 5000);
    else if (!consultation && voteActif()) C().poll(() => rafraichirVote(el), 15000);
    else C().stopPoll();
  }
  const voteActif = () => !!(voteEtat && voteEtat.vote && (voteEtat.ouvert || voteEtat.en_cloture));
  // Pendant le vote : seul le bloc du vote est rafraîchi ; à la clôture, toute la page.
  async function rafraichirVote(el) {
    if (!semaine) return;
    const avant = voteActif();
    try { voteEtat = await C().rpc("commando_vote_etat", { _semaine_id: semaine.id }); } catch (e) { return; }
    if (avant && !voteActif()) { show(el); return; }
    if (!document.activeElement || !$("#semVote", el).contains(document.activeElement)) rendreVote(el);
  }

  /* ---------- Cockpit : la semaine en 5 étapes + pilote automatique ---------- */
  const PILOTE_DEFAUT = { actif: false, jour: 1, heure_veille: "07:00", cloture_vote: "13:30", nb_choix: 3, auto_publier: true };
  const heureTxt = (h) => String(h || "").replace(":", "h");
  const pilote = () => Object.assign({}, PILOTE_DEFAUT, (parametres || {}).pilote || {});
  async function rendreCockpit(el) {
    const box = $("#semCockpit", el); if (!box) return;
    if (window.RexCommandoNotifs && !consultation) window.RexCommandoNotifs.rendre($("#semNotifs", el));
    else $("#semNotifs", el).innerHTML = "";
    if (!semaine || consultation) { box.innerHTML = ""; return; }
    const pil = pilote();
    let journal = [], appels = 0, rdv = 0;
    try { const e = await C().rpc("commando_pilote_etat"); journal = (e && e.journal) || []; } catch (e) { /* facultatif */ }
    try {
      const [a, r] = await Promise.all([
        sb().from("commando_appels").select("id", { count: "exact", head: true }).eq("semaine_id", semaine.id),
        sb().from("commando_appels").select("id", { count: "exact", head: true }).eq("semaine_id", semaine.id).eq("statut", "rdv")
      ]);
      appels = Number(a.count || 0); rdv = Number(r.count || 0);
    } catch (e) { /* facultatif */ }
    const gen = generations.find(g => g.type === "veille") || null;
    const nbSujets = thematiques.filter(t => t.statut !== "ecartee").length;
    const nbRetenues = thematiques.filter(t => t.statut === "retenue").length;
    const publiee = semaine.statut === "publiee";
    const v = voteEtat && voteEtat.vote ? voteEtat : null;
    const etapes = [];
    // ① Veille
    if (gen && gen.statut === "en_cours") etapes.push({ titre: "Veille", etat: "encours", txt: `En cours, étape ${(gen.etat && gen.etat.etape) || 1} sur ${(gen.etat && gen.etat.total) || 6}` });
    else if (gen && gen.statut === "erreur" && !nbSujets) etapes.push({ titre: "Veille", etat: "alerte", txt: "Erreur : relancez-la ci-dessous" });
    else if (nbSujets) etapes.push({ titre: "Veille", etat: "fait", txt: `${nbSujets} sujet${nbSujets > 1 ? "s" : ""} proposé${nbSujets > 1 ? "s" : ""}` });
    else etapes.push({ titre: "Veille", etat: pil.actif ? "auto" : "afaire", txt: pil.actif ? `Automatique lundi à ${heureTxt(pil.heure_veille)}` : "À lancer" });
    // ② Vote
    if (v && (v.ouvert || v.en_cloture)) etapes.push({ titre: "Vote", etat: "encours", txt: `${Number((v.participation || {}).votants || 0)} sur ${Number((v.participation || {}).commerciaux || 0)} ont voté, clôture ${heureFinVote(v.fin)}` });
    else if (v && v.clos_le) etapes.push({ titre: "Vote", etat: "fait", txt: "Clos" });
    else if (publiee) etapes.push({ titre: "Vote", etat: "fait", txt: "Pas de vote cette semaine" });
    else etapes.push({ titre: "Vote", etat: pil.actif ? "auto" : "option", txt: pil.actif ? `S'ouvre seul après la veille, jusqu'à ${heureTxt(pil.cloture_vote)}` : "Facultatif" });
    // ③ Publication
    if (publiee) etapes.push({ titre: "Publication", etat: "fait", txt: `Publiée le ${C().fmtDateTime(semaine.publiee_le)}` });
    else if (v && v.auto_publier && (v.ouvert || v.en_cloture)) etapes.push({ titre: "Publication", etat: "auto", txt: `Automatique à ${heureFinVote(v.fin)}` });
    else if (pil.actif && !v) etapes.push({ titre: "Publication", etat: "auto", txt: `Automatique à ${heureTxt(pil.cloture_vote)}` });
    else etapes.push({ titre: "Publication", etat: "afaire", txt: `Retenir 3 sujets (${nbRetenues} sur 3), puis publier` });
    // ④ Commando
    etapes.push({ titre: "Commando", etat: publiee ? (appels ? "encours" : "pret") : "attente", txt: publiee ? `${appels} appel${appels > 1 ? "s" : ""}, ${rdv} RDV` : "Lundi 14h–17h" });
    // ⑤ Bilan
    etapes.push({ titre: "Bilan", etat: appels ? "fait" : "attente", txt: appels ? "Ligue et efficacité à jour" : "Après le commando" });
    // Prochaine action (une seule, la plus utile)
    let action = "";
    if (!publiee) {
      if (gen && gen.statut === "en_cours") action = "La veille travaille (8 à 12 minutes). Les propositions arrivent ci-dessous au fur et à mesure.";
      else if (!nbSujets) action = pil.actif ? `Rien à faire : la veille partira seule lundi à ${heureTxt(pil.heure_veille)}. Vous pouvez aussi la lancer maintenant.` : "Lancez la veille (bloc « Veille IA » ci-dessous).";
      else if (v && (v.ouvert || v.en_cloture)) action = "Le vote tourne. Vous pouvez écarter un sujet, changer l'heure de clôture ou clore maintenant (bloc « Vote de l'équipe »).";
      else if (pil.actif && nbSujets >= 4 && !nbRetenues) action = "Le vote va s'ouvrir tout seul dans quelques minutes. Écartez d'abord les sujets qui ne vous plaisent pas si besoin.";
      else action = `Retenez 3 sujets (${nbRetenues} sur 3) puis publiez, ou ouvrez un vote.`;
    } else action = appels ? "La semaine est lancée. Suivez la ligue et validez les RDV honorés quand ils ont eu lieu." : "Tout est prêt : les commerciaux ont leurs listes.";
    const JOURNAL = { veille_lancee: "Veille lancée automatiquement", vote_ouvert: "Vote ouvert automatiquement", veille_impossible: "Veille automatique impossible", vote_impossible: "Vote automatique impossible" };
    const dernier = journal.find(j => j.semaine === semaine.semaine);
    box.innerHTML = `<div class="cmd-card cmd-cockpit">
      <ol class="cmd-etapes">${etapes.map((e, i) => `<li class="cmd-etape cmd-etape--${e.etat}"><span class="cmd-etape__num">${e.etat === "fait" ? ic("check") : i + 1}</span><div><b>${esc(e.titre)}</b><small>${esc(e.txt)}</small></div></li>`).join("")}</ol>
      <div class="cmd-cockpit__action">${ic("arrow-up-right")}<span><b>Maintenant :</b> ${esc(action)}</span></div>
      <div class="cmd-pilote ${pil.actif ? "cmd-pilote--on" : ""}">
        <label class="cmd-switch"><input type="checkbox" id="piloteActif" ${pil.actif ? "checked" : ""} /><span></span><b>${ic("bot")}Pilote automatique du lundi</b></label>
        <p class="muted">${pil.actif ? `Veille à ${esc(heureTxt(pil.heure_veille))}, vote jusqu'à ${esc(heureTxt(pil.cloture_vote))}, les 3 sujets les plus votés retenus${pil.auto_publier ? " et publiés" : ""}. Vous gardez la main à tout moment.` : "Désactivé : vous lancez la veille, le vote et la publication à la main."}</p>
        <details class="cmd-pilote__det"><summary>Réglages du pilote</summary>
          <div class="cmd-row">
            <label>Veille à <input type="time" id="piloteVeille" value="${esc(pil.heure_veille)}" /></label>
            <label>Clôture du vote <input type="time" id="piloteCloture" value="${esc(pil.cloture_vote)}" /></label>
            <label>Choix par commercial <select id="piloteChoix">${[1, 2, 3].map(n => `<option ${Number(pil.nb_choix) === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
            <label class="cmd-check"><input type="checkbox" id="pilotePublier" ${pil.auto_publier ? "checked" : ""} /> Publier à la clôture</label>
            <button id="piloteSave" class="btn btn--sm">Enregistrer</button>
          </div>
        </details>
        ${dernier ? `<div class="muted cmd-pilote__journal">${ic("history")}<span>${esc(JOURNAL[dernier.action] || dernier.action)} le ${esc(C().fmtDateTime(dernier.le))}${dernier.detail && dernier.detail.erreur ? " : " + esc(dernier.detail.erreur) : ""}</span></div>` : ""}
      </div>
    </div>`;
    const enregistrer = async (patch) => {
      const pilote = Object.assign({}, pil, patch);
      const { error } = await sb().from("commando_parametres").update({ pilote }).eq("id", true);
      if (error) { C().toast("Échec : " + error.message); return; }
      parametres = Object.assign({}, parametres, { pilote });
      C().toast(pilote.actif ? "Pilote automatique activé" : "Pilote automatique désactivé");
      rendreCockpit(el);
    };
    $("#piloteActif", box).addEventListener("change", (e) => enregistrer({ actif: e.target.checked }));
    $("#piloteSave", box).addEventListener("click", () => enregistrer({
      heure_veille: $("#piloteVeille", box).value || "07:00", cloture_vote: $("#piloteCloture", box).value || "13:30",
      nb_choix: Number($("#piloteChoix", box).value) || 3, auto_publier: $("#pilotePublier", box).checked
    }));
  }

  /* ---------- Vote de l'équipe ---------- */
  function finParDefaut() {
    // Aujourd'hui 13 h 30 (avant le commando de 14 h) ; passé 13 h, dans une heure.
    const d = new Date();
    const cible = new Date(d); cible.setHours(13, 30, 0, 0);
    const fin = d.getHours() < 13 ? cible : new Date(Math.ceil((d.getTime() + 3600000) / 300000) * 300000);
    const p = (n) => String(n).padStart(2, "0");
    return `${fin.getFullYear()}-${p(fin.getMonth() + 1)}-${p(fin.getDate())}T${p(fin.getHours())}:${p(fin.getMinutes())}`;
  }
  function heureFinVote(ts) {
    try { return new Date(ts).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function lienVote() { return location.origin + location.pathname + "#commando/vote"; }
  function messageEquipe(v) {
    return `Commando, semaine ${num(v.semaine)} : votez pour vos ${v.nb_choix} sujets préférés dans RexSeller avant ${heureFinVote(v.fin)}. ${lienVote()}`;
  }
  function formulaireVote(nb, reouvrir) {
    const maxChoix = Math.max(1, Math.min(5, nb - 1));
    const defChoix = Math.min(3, maxChoix);
    return `<div class="cmd-form cmd-vote__form">
      <label>Clôture du vote<input type="datetime-local" id="voteFin" value="${finParDefaut()}" /></label>
      <label>Choix par commercial<select id="voteNb">${Array.from({ length: maxChoix }, (_, i) => i + 1).map(n => `<option value="${n}" ${n === defChoix ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="wide">Message à l'équipe <span class="muted">(facultatif, affiché en haut du vote)</span><input type="text" id="voteMessage" maxlength="300" placeholder="Ex. : je suis en clientèle ce matin, choisissez vos sujets avant 13 h 30 !" /></label>
      <label class="wide"><span class="cmd-checks">
        <label><input type="checkbox" id="voteAutoRetenir" checked /> À la clôture, retenir automatiquement les 3 sujets les plus votés</label>
        <label><input type="checkbox" id="voteAutoPublier" checked /> Puis publier la semaine (les listes apparaissent chez les commerciaux)</label>
      </span></label>
      <div class="cmd-row wide"><button id="voteOuvrir" class="btn btn--primary" ${nb < 4 ? "disabled" : ""}>${ic("vote")}${reouvrir ? "Rouvrir le vote" : `Soumettre les ${nb} sujets au vote`}</button>
        ${nb < 4 ? `<span class="muted">Il faut au moins 4 sujets non écartés.</span>` : ""}</div>
    </div>`;
  }
  function brancherFormulaire(el, box) {
    const auto = $("#voteAutoRetenir", box), pub = $("#voteAutoPublier", box);
    if (auto && pub) { pub.disabled = !auto.checked; auto.addEventListener("change", () => { pub.disabled = !auto.checked; if (!auto.checked) pub.checked = false; }); }
    const b = $("#voteOuvrir", box); if (!b) return;
    b.addEventListener("click", async () => {
      const fin = $("#voteFin", box).value;
      if (!fin) { C().toast("Indiquez l'heure de clôture."); return; }
      b.disabled = true;
      try {
        await C().rpc("commando_vote_ouvrir", {
          _semaine_id: semaine.id, _fin: new Date(fin).toISOString(), _nb_choix: Number($("#voteNb", box).value),
          _auto_retenir: auto.checked, _auto_publier: pub.checked, _message: $("#voteMessage", box).value.trim() || null,
        });
        C().toast("Vote ouvert : prévenez l'équipe avec le message à copier");
        show(el);
      } catch (e) { b.disabled = false; C().toast(C().erreur(e)); }
    });
  }
  function rendreVote(el) {
    const box = $("#semVote", el); if (!box) return;
    if (!semaine) { box.innerHTML = ""; return; }
    const candidats = thematiques.filter(t => t.statut !== "ecartee");
    const v = voteEtat;
    if (!v || !v.vote) {
      if (semaine.statut === "publiee" || consultation) { box.innerHTML = ""; return; }
      box.innerHTML = `<div class="cmd-card"><h3>${ic("vote")}Vote de l'équipe</h3>
        <p class="muted">Vous n'êtes pas avec l'équipe ce matin ? Soumettez les sujets au vote : chaque commercial choisit ses préférés dans RexSeller (onglet « Vote »), jusqu'à l'heure de clôture. Écartez d'abord les sujets que vous ne voulez pas proposer : tous les sujets non écartés (${candidats.length}) seront soumis.</p>
        ${formulaireVote(candidats.length, false)}</div>`;
      brancherFormulaire(el, box);
      return;
    }
    const p = v.participation || {};
    const sujets = (v.sujets || []).slice().sort((a, b) => (a.rang || 99) - (b.rang || 99));
    const total = Math.max(1, Number(p.votants || 0));
    const tableau = `<div class="tbl-scroll" style="margin-top:10px"><table class="grid"><thead><tr><th class="num">Rang</th><th>Sujet</th><th class="num">Votes</th><th></th><th>Votants</th></tr></thead><tbody>
      ${sujets.map(s => `<tr><td class="num">${s.rang && s.rang <= 3 ? `<b>${esc(s.rang)}</b>` : esc(s.rang || "")}</td><td>${esc(s.titre)}${s.statut === "retenue" ? ` <span class="cmd-badge cmd-badge--ok">Retenue</span>` : ""}</td>
        <td class="num"><b>${esc(s.votes ?? 0)}</b></td><td style="min-width:120px"><div class="cmd-vote__barre"><span style="width:${Math.round(Number(s.votes || 0) / total * 100)}%"></span></div></td>
        <td class="muted">${esc((s.votants || []).map(id => C().prenomDe(id)).join(", "))}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted" style="margin-top:6px">À égalité de votes, l'ordre des propositions départage.</p>`;
    const commentaires = (v.votants || []).filter(x => x.commentaire);
    const coms = commentaires.length ? `<ul class="cmd-hist">${commentaires.map(x => `<li><b>${esc(C().prenomDe(x.commercial_id))}</b> : ${esc(x.commentaire)}</li>`).join("")}</ul>` : "";
    const options = `${v.auto_retenir ? "les 3 sujets les plus votés seront retenus" : "rien ne sera retenu automatiquement"}${v.auto_retenir && v.auto_publier ? " et la semaine publiée" : ""}`;
    if (v.ouvert || v.en_cloture) {
      box.innerHTML = `<div class="cmd-card cmd-vote__pilote"><h3>${ic("vote")}Vote de l'équipe <span class="cmd-badge cmd-badge--warn">${v.en_cloture ? "Clôture en cours" : "Ouvert"}</span></h3>
        <p><b>${esc(p.votants || 0)} sur ${esc(p.commerciaux || 0)}</b> commerciaux ont voté. Clôture <b>${esc(heureFinVote(v.fin))}</b>, ${esc(v.nb_choix)} choix chacun. À la clôture, ${esc(options)}.</p>
        ${tableau}${coms}
        <div class="cmd-row">
          <button id="voteCopier" class="btn btn--sm">${ic("copy")}Copier le message pour l'équipe</button>
          <button id="voteClore" class="btn btn--sm" ${v.en_cloture ? "disabled" : ""}>${ic("square")}Clore le vote maintenant</button>
          <button id="voteEcheance" class="btn btn--sm" ${v.en_cloture ? "disabled" : ""}>${ic("calendar-clock")}Changer l'échéance</button>
        </div>
        <div id="voteEcheanceForm" hidden></div>
        <p class="muted" style="margin-top:6px">Le lien ouvre directement l'onglet Vote.</p></div>`;
      $("#voteCopier", box).addEventListener("click", async () => {
        const txt = messageEquipe(v);
        try { await navigator.clipboard.writeText(txt); C().toast("Message copié : collez-le dans Teams"); }
        catch (e) { prompt("Copiez ce message :", txt); }
      });
      $("#voteClore", box).addEventListener("click", async () => {
        if (!confirm(`Clore le vote maintenant ? ${options.charAt(0).toUpperCase() + options.slice(1)}.`)) return;
        try { await C().rpc("commando_vote_clore", { _semaine_id: semaine.id }); C().toast("Vote clos"); show(el); }
        catch (e) { C().toast(C().erreur(e)); }
      });
      $("#voteEcheance", box).addEventListener("click", () => {
        const f = $("#voteEcheanceForm", box);
        f.hidden = !f.hidden;
        if (!f.hidden) {
          f.innerHTML = formulaireVote(thematiques.filter(t => t.statut !== "ecartee").length, true);
          const nbSel = $("#voteNb", f); if (nbSel) nbSel.value = String(v.nb_choix);
          $("#voteAutoRetenir", f).checked = !!v.auto_retenir; $("#voteAutoPublier", f).checked = !!v.auto_publier;
          $("#voteMessage", f).value = v.message || "";
          $("#voteOuvrir", f).textContent = "Enregistrer (les votes déjà faits sont conservés)";
          brancherFormulaire(el, f);
          $("#voteAutoPublier", f).disabled = !v.auto_retenir;
        }
      });
      return;
    }
    // Vote clos
    const r = v.resultat || {};
    const retenues = thematiques.filter(t => t.statut === "retenue").length;
    const corps = `<p>Clos le ${esc(C().fmtDateTime(v.clos_le))}, ${esc(p.votants || 0)} sur ${esc(p.commerciaux || 0)} commerciaux ont voté.
        ${r.retenue_auto ? " Les 3 sujets les plus votés ont été retenus." : ""}${r.publie ? " La semaine a été publiée automatiquement." : ""}</p>
      ${r.note ? `<div class="cmd-note">${ic("info")}<span>${esc(r.note)}</span></div>` : ""}
      ${r.erreur_publication ? `<div class="cmd-err">${ic("triangle-alert")}<span>Publication automatique impossible : ${esc(r.erreur_publication)}. Vérifiez les sujets retenus puis publiez ci-dessous.</span></div>` : ""}
      ${tableau}${coms}
      ${semaine.statut === "brouillon" && !consultation ? `<div class="cmd-row">
        <button id="voteRetenir" class="btn btn--sm">${ic("check")}Retenir les 3 plus votés</button>
        <button id="voteRouvrir" class="btn btn--sm">${ic("rotate-ccw")}Rouvrir le vote</button>
        <span class="muted" style="margin:0">${retenues} sur 3 retenue(s) actuellement.</span></div><div id="voteRouvrirForm" hidden></div>` : ""}`;
    // Semaine publiée : le vote est derrière nous, il reste consultable replié.
    box.innerHTML = semaine.statut === "publiee" || consultation
      ? `<details class="cmd-plie"><summary>${ic("vote")}Vote de l'équipe <span class="muted">Clos, ${esc(p.votants || 0)} sur ${esc(p.commerciaux || 0)} ont voté</span></summary><div class="cmd-plie__corps">${corps}</div></details>`
      : `<div class="cmd-card"><h3>${ic("vote")}Vote de l'équipe <span class="cmd-badge cmd-badge--gris">Clos</span></h3>${corps}</div>`;
    const rt = $("#voteRetenir", box);
    if (rt) rt.addEventListener("click", async () => {
      try {
        const res = await C().rpc("commando_vote_retenir", { _semaine_id: semaine.id });
        if ((res.retenues || []).length === 3) C().toast("3 sujets retenus d'après le vote"); else C().toast("Rien de retenu : " + (res.raison || ""));
        show(el);
      } catch (e) { C().toast(C().erreur(e)); }
    });
    const ro = $("#voteRouvrir", box);
    if (ro) ro.addEventListener("click", () => {
      const f = $("#voteRouvrirForm", box); f.hidden = !f.hidden;
      if (!f.hidden) { f.innerHTML = formulaireVote(thematiques.filter(t => t.statut !== "ecartee").length, true); brancherFormulaire(el, f); }
    });
  }
  function rendreTete(el) {
    const cible = C().semaineCible();
    const head = $("#semHead", el);
    if (!semaine) {
      const pil = pilote();
      head.innerHTML = `<div class="cmd-semaine-tete"><div><div class="cmd-semaine-tete__titre">Semaine ${esc(num(cible))} <span class="cmd-badge">Pas encore préparée</span></div><div class="cmd-semaine-tete__quand">${esc(periode(cible))}</div></div></div>
        <div class="cmd-card">
          <p>${pil.actif ? `Le pilote automatique la prépare lundi à ${esc(heureTxt(pil.heure_veille))} : veille, vote, puis publication à ${esc(heureTxt(pil.cloture_vote))}.` : "Préparez-la pour lancer la veille et choisir les sujets."}</p>
          <button id="semCreer" class="btn ${pil.actif ? "" : "btn--primary"}">${ic("plus")}Préparer la semaine ${esc(num(cible))} maintenant</button>
        </div>`;
    } else {
      const v = voteActif();
      const etat = consultation ? ["Terminée", "gris"] : semaine.statut === "publiee" ? ["Publiée", "ok"] : v ? ["Vote en cours", "warn"] : ["En préparation", "info"];
      head.innerHTML = `${consultation ? `<div class="cmd-consult"><b>${ic("history")}Semaine ${esc(num(semaine.semaine))}, en lecture seule</b><button id="semRetour" class="btn btn--sm">${ic("arrow-left")}Revenir à la semaine en cours</button></div>` : ""}
        <div class="cmd-semaine-tete">
          <div><div class="cmd-semaine-tete__titre">Semaine ${esc(num(semaine.semaine))} <span class="cmd-badge cmd-badge--${etat[1]}">${etat[0]}</span></div><div class="cmd-semaine-tete__quand">${esc(periode(semaine.semaine))}</div></div>
          ${semaines.some(s => s.semaine < cible && s.id !== semaine.id) ? `<button id="semVersHisto" class="btn btn--ghost btn--sm">${ic("history")}Semaines précédentes</button>` : ""}
        </div>`;
    }
    const cr = $("#semCreer", head);
    if (cr) cr.addEventListener("click", async () => {
      const { data, error } = await sb().from("commando_semaines").insert({ semaine: cible }).select().single();
      if (error) { C().toast("Échec : " + error.message); return; }
      semaine = data; consultation = false; C().toast("Semaine créée"); show(el);
    });
    const ret = $("#semRetour", head);
    if (ret) ret.addEventListener("click", () => { consultation = false; semaine = null; window.scrollTo({ top: 0 }); show(el); });
    const vh = $("#semVersHisto", head);
    if (vh) vh.addEventListener("click", () => { const h = $("#semHisto", el); if (h) h.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }

  /* ---------- Semaines précédentes ---------- */
  async function rendreHistorique(el) {
    const box = $("#semHisto", el); if (!box) return;
    const cible = C().semaineCible();
    const passees = semaines.filter(s => s.semaine < cible && !(consultation && semaine && s.id === semaine.id));
    if (!passees.length) { box.innerHTML = ""; return; }
    const ids = passees.map(s => s.id);
    const [t, a] = await Promise.all([
      sb().from("commando_thematiques").select("semaine_id, titre, ordre").in("semaine_id", ids).eq("statut", "retenue").order("ordre").then(r => r.data || []),
      sb().from("commando_appels").select("semaine_id, statut").in("semaine_id", ids).limit(5000).then(r => r.data || [])
    ]);
    box.innerHTML = `<div class="cmd-section">${ic("history")}Semaines précédentes</div>
      <div class="cmd-card" style="padding:0"><ul class="cmd-histo">${passees.map(s => {
        const sujets = t.filter(x => x.semaine_id === s.id).map(x => x.titre);
        const appels = a.filter(x => x.semaine_id === s.id);
        const rdv = appels.filter(x => x.statut === "rdv").length;
        return `<li><button data-semaine="${esc(s.id)}">
          <span class="cmd-histo__sem">Semaine ${esc(num(s.semaine))} <span class="muted" style="display:inline;font-weight:500">${esc(C().periodeSemaine(s.semaine))}</span></span>
          <span class="cmd-histo__chiffres">${appels.length} appel${appels.length > 1 ? "s" : ""}, ${rdv} RDV</span>
          <span class="cmd-histo__sujets">${sujets.length ? sujets.map(esc).join(", ") : s.statut === "publiee" ? "" : "Non publiée"}</span>
        </button></li>`;
      }).join("")}</ul></div>`;
    $$("[data-semaine]", box).forEach(b => b.addEventListener("click", () => {
      semaine = semaines.find(s => s.id === b.dataset.semaine) || null;
      consultation = !!semaine;
      window.scrollTo({ top: 0 });
      show(el);
    }));
  }

  /* ---------- Veille IA ---------- */
  function coutMois() {
    const debut = new Date(); debut.setDate(1); debut.setHours(0, 0, 0, 0);
    return generations.filter(g => new Date(g.lancee_le) >= debut).reduce((a, g) => a + Number(g.cout_estime || 0), 0);
  }
  function rendreVeille(el) {
    const box = $("#semVeille", el);
    if (!semaine || consultation) { box.innerHTML = ""; return; }
    const publiee = semaine.statut === "publiee";
    const enCours = generations.find(g => g.statut === "en_cours");
    const nbSemaine = generations.filter(g => g.type !== "fiche_rex").length;
    const limite = Number((parametres || {}).limite_generations_semaine || 5);
    const fiche = parametres && parametres.fiche_rex && parametres.fiche_rex_validee_le;
    const ETAT = (g) => g.statut === "en_cours"
      ? `<span class="cmd-badge cmd-badge--info"><span class="cmd-spin"></span>En cours${g.etat && g.etat.total ? `, étape ${esc(g.etat.etape || 1)} sur ${esc(g.etat.total)}` : ""}</span>${g.etat && g.etat.libelle ? `<div class="muted" style="font-size:12px;margin-top:3px">${esc(g.etat.libelle)}${g.etat.note ? ". " + esc(g.etat.note) : ""}</div>` : ""}`
      : g.statut === "erreur" ? `<span class="cmd-badge cmd-badge--err">Erreur</span>` : `<span class="cmd-badge cmd-badge--ok">Terminée</span>`;
    const outils = `<div class="cmd-row">
        <button id="veilleResserrer" class="btn btn--sm" title="Trames plus courtes et plus percutantes, arguments clés en gras, pour les thématiques retenues">${ic("scissors")}Resserrer les trames des retenues</button>
        <button id="veilleMails" class="btn btn--sm" title="Rédige les mails de suivi des thématiques retenues qui n'en ont pas encore">${ic("mail")}Rédiger les mails des retenues</button>
        <button id="veilleFiche" class="btn btn--sm" ${enCours ? "disabled" : ""}>${ic("file-text")}Rédiger la fiche Rex (brouillon)</button>
        <button id="veilleImporter" class="btn btn--sm">${ic("upload")}Importer un fichier de thématiques</button>
        <input type="file" id="veilleFichier" accept="application/json,.json" hidden />
        <button id="veilleManuelle" class="btn btn--sm">${ic("pencil")}Ajouter une thématique à la main</button>
      </div>`;
    const historique = generations.length ? `<details class="cmd-plus"><summary>${ic("history")}Historique des générations (${generations.length}), coût du mois ${coutMois().toFixed(2)} $</summary><div class="tbl-scroll" style="margin-top:10px"><table class="grid"><thead><tr><th>Lancée</th><th>Type</th><th>État</th><th>Modèle</th><th class="num">Jetons</th><th class="num">Recherches</th><th class="num">Coût</th><th class="num">Durée</th><th>Erreur</th></tr></thead><tbody>
        ${generations.map(g => `<tr><td>${esc(C().fmtDateTime(g.lancee_le))}</td><td>${esc(g.type)}</td><td>${ETAT(g)}</td><td>${esc(g.modele || "")} v${esc(g.prompt_version || "")}</td><td class="num">${Number(g.jetons_entree || 0) + Number(g.jetons_sortie || 0) || "—"}</td><td class="num">${g.nb_recherches ?? "—"}</td><td class="num">${g.cout_estime != null ? Number(g.cout_estime).toFixed(2) + " $" : "—"}</td><td class="num">${g.duree_ms ? Math.round(g.duree_ms / 1000) + " s" : "—"}</td><td class="muted">${esc(g.erreur || "")}</td></tr>`).join("")}
      </tbody></table></div></details>` : "";
    if (publiee) {
      // Semaine publiée : la veille est faite ; ses outils restent à portée, repliés.
      box.innerHTML = `<details class="cmd-plie"><summary>${ic("radar")}Veille IA et outils <span class="muted">${generations.length} génération${generations.length > 1 ? "s" : ""}</span></summary>
        <div class="cmd-plie__corps"><div id="veilleMsg"></div>${outils}${historique}</div></details>`;
    } else {
      box.innerHTML = `<div class="cmd-card">
        <h3>${ic("radar")}Veille IA</h3>
        <p class="muted">La veille cherche l'actualité des 14 derniers jours, la relie aux offres de la fiche Rex et propose 5 thématiques avec règles de ciblage et trames. Modèle : ${esc((parametres || {}).modele || "")}. Générations cette semaine : ${nbSemaine} sur ${limite}.</p>
        ${fiche ? "" : `<div class="cmd-note">${ic("info")}<span>La fiche Rex-Rotary n'est pas encore validée. Lancez d'abord « Rédiger la fiche Rex » (recherche sur le site public), puis corrigez et validez la fiche dans Réglages, Paramètres. La veille hebdomadaire n'utilise que la fiche validée.</span></div>`}
        <div id="veilleMsg"></div>
        <div class="cmd-row">
          <button id="veilleLancer" class="btn btn--primary" ${enCours || !fiche || nbSemaine >= limite ? "disabled" : ""}>${ic("radar")}Lancer la veille (5 propositions)</button>
        </div>
        <details class="cmd-plus"><summary>${ic("ellipsis")}Autres actions</summary>${outils}</details>
        ${historique}
      </div>`;
    }
    $("#veilleResserrer", el).addEventListener("click", () => {
      const retenues = thematiques.filter(t => t.statut === "retenue");
      if (!retenues.length) { C().toast("Aucune thématique retenue pour cette semaine."); return; }
      if (!confirm(`Resserrer les trames des ${retenues.length} thématique(s) retenue(s) ? Les textes actuels seront remplacés par une version plus courte (rien n'est inventé).`)) return;
      resserrer(el, retenues);
    });
    $("#veilleMails", el).addEventListener("click", () => {
      const retenues = thematiques.filter(t => t.statut === "retenue");
      if (!retenues.length) { C().toast("Aucune thématique retenue pour cette semaine."); return; }
      const sans = retenues.filter(t => !(t.mails && (t.mails.rdv || t.mails.suite)));
      const cibles = sans.length ? sans : retenues;
      if (!sans.length && !confirm("Toutes les retenues ont déjà leurs mails. Les réécrire ?")) return;
      redigerMails(el, cibles);
    });
    const lancer = $("#veilleLancer", el);
    if (lancer) lancer.addEventListener("click", () => lancerVeille(el, { type: "veille" }, "Veille lancée en 6 étapes (recherche, puis une thématique à la fois) : comptez 8 à 12 minutes. Les propositions apparaissent au fur et à mesure, la page se met à jour toute seule."));
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
  // Resserrage : une thématique à la fois (un appel au modèle, 20 à 40 s chacune).
  async function resserrer(el, liste) {
    const msg = $("#veilleMsg", el);
    let n = 0;
    for (const t of liste) {
      n++;
      msg.innerHTML = `<div class="cmd-note"><span class="cmd-spin"></span>Resserrage ${n}/${liste.length} : « ${esc(t.titre)} »… (20 à 40 s)</div>`;
      try { await C().fn("commando-veille", { type: "resserrage", semaine_id: semaine.id, thematique_id: t.id }); }
      catch (e) { msg.innerHTML = `<div class="cmd-err">« ${esc(t.titre)} » : ${esc(C().erreur(e))}</div>`; return; }
    }
    msg.innerHTML = `<div class="cmd-ok">${ic("circle-check")}<span>${liste.length} thématique${liste.length > 1 ? "s" : ""} resserrée${liste.length > 1 ? "s" : ""} : trames plus courtes, arguments clés en gras.</span></div>`;
    await show(el);
  }
  async function redigerMails(el, liste) {
    const msg = $("#veilleMsg", el);
    let n = 0;
    for (const t of liste) {
      n++;
      msg.innerHTML = `<div class="cmd-note"><span class="cmd-spin"></span>Mails ${n}/${liste.length} : « ${esc(t.titre)} »… (15 à 30 s)</div>`;
      try { await C().fn("commando-veille", { type: "mails", semaine_id: semaine.id, thematique_id: t.id }); }
      catch (e) { msg.innerHTML = `<div class="cmd-err">« ${esc(t.titre)} » : ${esc(C().erreur(e))}</div>`; return; }
    }
    msg.innerHTML = `<div class="cmd-ok">${ic("circle-check")}<span>Mails de suivi rédigés pour ${liste.length} thématique${liste.length > 1 ? "s" : ""}. Relisez-les dans chaque proposition (« Mails de suivi »).</span></div>`;
    await show(el);
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
        await charger();
        const importee = semaines.find(s => s.id === id);
        if (importee) { semaine = importee; consultation = importee.semaine !== C().semaineCible(); }
        await show(el);
      } catch (e) { C().toast("Import impossible : " + C().erreur(e)); }
    };
    r.readAsText(f);
    $("#veilleFichier", el).value = "";
  }

  /* ---------- Propositions ---------- */
  const COULEUR_NOM = { vert: "Vert", orange: "Orange", rouge: "Rouge" };
  function sourceHtml(s) {
    const d = s.date ? C().fmtDate(s.date) : "sans date";
    const recent = s.date && (Date.now() - new Date(s.date).getTime()) <= 14 * 86400000;
    const badge = s.verifiee === true ? `<span class="cmd-badge cmd-badge--ok">Vérifiée</span>` : `<span class="cmd-badge cmd-badge--warn">Non vérifiée</span>`;
    const url = /^https?:\/\//i.test(s.url || "") ? s.url : "";
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.titre || s.url)}</a>` : esc(s.titre || "(sans URL)")} <span class="muted" style="display:inline">(${esc(d)}${recent ? "" : ", plus de 14 jours"})</span> ${badge}</li>`;
  }
  function regleHtml(r, i) {
    const si = r.si || {};
    const conds = [];
    if (si.naf_prefixes) conds.push("NAF " + si.naf_prefixes.join(" ou "));
    if (si.naf_exclus) conds.push("sauf NAF " + si.naf_exclus.join(", "));
    if (si.tranches) conds.push("effectif " + si.tranches.map(t => TRANCHES[t] || t).join(" ou "));
    if (si.anciennete) conds.push("ancienneté " + si.anciennete.map(a => ANC[a] || a).join(" ou "));
    return `<li><span class="cmd-badge cmd-badge--${esc(r.couleur)}">${esc(COULEUR_NOM[r.couleur] || r.couleur)}</span> <b>Règle ${i + 1}</b> : ${esc(conds.join(" et ") || "toutes les entreprises")}${r.raison ? ` <span class="muted" style="display:inline">(${esc(r.raison)})</span>` : ""}</li>`;
  }
  function trameHtml(t) {
    const trames = t.trames || {};
    const g = (x) => C().gras(x);
    return COULEURS.map(c => {
      const tr = trames[c]; if (!tr) return `<div class="cmd-trame cmd-trame--${c}"><p class="muted">Pas de trame ${c}.</p></div>`;
      return `<div class="cmd-trame cmd-trame--${c}">
        <div class="cmd-trame__bloc" style="margin-bottom:0"><span class="cmd-badge cmd-badge--${c}">Cible ${c}</span></div>
        ${(tr.points_cles || []).length ? `<ul class="cmd-trame__cles">${tr.points_cles.map(k => `<li>${g(k)}</li>`).join("")}</ul>` : ""}
        <div class="cmd-trame__bloc"><b>Accroche</b><p>${g(tr.accroche || "")}</p></div>
        ${(tr.questions_decouverte || []).length ? `<div class="cmd-trame__bloc"><b>Questions</b><ol>${tr.questions_decouverte.map(q => `<li>${g(q)}</li>`).join("")}</ol></div>` : ""}
        ${tr.argument ? `<div class="cmd-trame__bloc"><b>Argument</b><p>${g(tr.argument)}</p></div>` : ""}
        ${tr.conclusion ? `<div class="cmd-trame__bloc"><b>Conclusion</b><p>${g(tr.conclusion)}</p></div>` : ""}
      </div>`;
    }).join("");
  }
  function mailsHtml(t) {
    const m = t.mails || {};
    const un = (titre, x) => x ? `<div class="cmd-mail__apercu"><b>${esc(titre)}</b><div class="cmd-mail__objet">Objet : ${esc(x.objet || "")}</div><pre class="cmd-mail__corps">${esc(x.corps || "")}</pre></div>` : "";
    if (!m.rdv && !m.suite) return `<p class="muted">Aucun mail pour cette thématique : utilisez « Rédiger les mails » dans le menu de la proposition.</p>`;
    return un("RDV confirmé", m.rdv) + un("Suite à notre échange", m.suite) + `<p class="muted">Variables remplies à l'envoi : {dirigeant}, {raison_sociale}, {commercial}, {date_rdv}, {creneaux}. Le mail part de la messagerie du commercial.</p>`;
  }
  // lecture : semaine passée ou proposition non retenue d'une semaine publiée (aucune action).
  // Semaine publiée : le détail est replié en un seul bloc, et seules les retouches
  // (modifier, resserrer, mails) restent : retenir ou écarter demanderait de republier.
  function propositionHtml(t, lecture) {
    const publiee = semaine && semaine.statut === "publiee";
    const conc = t.concurrence || {};
    const alertes = (t.alertes || []).concat((t.sources || []).every(s => !s.date || (Date.now() - new Date(s.date).getTime()) > 14 * 86400000) ? ["Aucune source datée de moins de 14 jours"] : []);
    const nbVerif = (t.sources || []).filter(s => s.verifiee === true).length;
    const STATUT = { retenue: ["Retenue", "ok"], proposee: ["Proposée", "info"], ecartee: ["Écartée", "gris"] };
    const st = STATUT[t.statut] || [t.statut, ""];
    const sv = voteEtat && voteEtat.vote && (voteEtat.sujets || []).find(x => x.id === t.id);
    return `<div class="cmd-card cmd-prop cmd-prop--${esc(t.statut)}" data-id="${t.id}">
      <div class="cmd-prop__head">
        <div>
          <span class="cmd-badge cmd-badge--${st[1]}">${esc(st[0])}</span>
          <span class="cmd-badge">${t.origine === "ia" ? "Veille IA" : "Manuelle"}</span>
          ${t.famille ? `<span class="cmd-badge">${esc(FAMILLES[t.famille] || t.famille)}</span>` : ""}
          ${sv && sv.votes != null ? `<span class="cmd-badge cmd-badge--warn">${ic("vote")}${esc(sv.votes)} vote${Number(sv.votes) > 1 ? "s" : ""}</span>` : ""}
          ${t.modifiee_le ? `<span class="cmd-badge">Modifiée le ${esc(C().fmtDate(t.modifiee_le))}</span>` : ""}
        </div>
        ${lecture ? "" : `<div class="admin-actions">
          ${publiee ? "" : t.statut !== "retenue" ? `<button class="btn btn--primary btn--sm" data-statut="retenue">${ic("check")}Retenir</button>` : `<button class="btn btn--sm" data-statut="proposee">${ic("undo-2")}Ne plus retenir</button>`}
          ${publiee ? "" : t.statut !== "ecartee" ? `<button class="btn btn--sm" data-statut="ecartee">Écarter</button>` : `<button class="btn btn--sm" data-statut="proposee">Reproposer</button>`}
          <details class="cmd-plus cmd-plus--inline"><summary aria-label="Autres actions">${ic("ellipsis")}</summary><div class="admin-actions">
          <button class="btn btn--ghost btn--sm" data-edit>${ic("pencil")}Modifier</button>
          ${t.origine === "ia" ? `<button class="btn btn--ghost btn--sm" data-regen>${ic("refresh-cw")}Régénérer</button>` : ""}
          <button class="btn btn--ghost btn--sm" data-resserrer title="Trames plus courtes et plus percutantes, arguments clés en gras (sans rien inventer)">${ic("scissors")}Resserrer les trames</button>
          <button class="btn btn--ghost btn--sm" data-mails title="Rédige les deux mails de suivi (RDV confirmé, suite à notre échange), sans rien inventer">${ic("mail")}Rédiger les mails</button>
          ${publiee ? "" : `<button class="btn btn--ghost btn--sm" data-del style="color:var(--c-rouge)">${ic("trash-2")}Supprimer</button>`}
          </div></details>
        </div>`}
      </div>
      <h3>${esc(t.titre)}</h3>
      <p class="muted"><b>Offre Rex :</b> ${esc(t.offre_rex || "—")}</p>
      ${publiee || lecture ? `<details class="cmd-prop__tout"><summary>Pourquoi maintenant, sources, trames, mails et objections</summary><div>` : ""}
      <p><b>Pourquoi maintenant :</b> ${C().gras(t.pourquoi_maintenant || "")}</p>
      ${alertes.length && !lecture && !publiee ? `<div class="cmd-err">${ic("triangle-alert")}<span>${alertes.map(esc).join(" ; ")}</span></div>` : ""}
      <details><summary>Sources (${nbVerif} sur ${(t.sources || []).length} vérifiées), concurrence et ciblage</summary>
      <h4>Sources</h4>
      ${(t.sources || []).length ? `<ul class="cmd-sources">${t.sources.map(sourceHtml).join("")}</ul>` : `<p class="muted">Aucune source.</p>`}
      <h4>Concurrence</h4>
      <p><b>Constat :</b> ${esc(conc.constat || "—")}</p>
      <p><b>Angle Rex :</b> ${esc(conc.angle_rex || "—")}</p>
      ${(conc.sources || []).length ? `<ul class="cmd-sources">${conc.sources.map(sourceHtml).join("")}</ul>` : ""}
      <h4>Règles de couleur ${lecture ? "" : `<button class="btn btn--sm" data-apercu>${ic("chart-column")}Aperçu des compteurs</button>`}</h4>
      <ol class="cmd-regles">${(t.regles || []).map(regleHtml).join("")}</ol>
      <div class="cmd-apercu" data-apercu-box hidden></div>
      </details>
      <details><summary>Trames d'appel par couleur</summary>${trameHtml(t)}</details>
      <details><summary>Mails de suivi ${(t.mails && (t.mails.rdv || t.mails.suite)) ? "" : "<span class='muted' style='margin:0'>(à rédiger)</span>"}</summary>${mailsHtml(t)}</details>
      <details><summary>Objections (${(t.objections || []).length})</summary>${(t.objections || []).map(o => `<div class="cmd-obj__item"><b>« ${esc(o.objection)} »</b><p>${C().gras(o.reponse)}</p></div>`).join("") || "<p class='muted'>Aucune.</p>"}</details>
      <details><summary>Hypothèses (${(t.hypotheses || []).length}), à distinguer des faits</summary><ul>${(t.hypotheses || []).map(h => `<li>${esc(h)}</li>`).join("") || "<li class='muted'>Aucune.</li>"}</ul></details>
      ${publiee || lecture ? `</div></details>` : ""}
    </div>`;
  }
  // Règles trop larges : plus de 40 % de la base en vert ou orange, les listes deviennent ingérables.
  function alerteLargeur(c) {
    const t = (c && c.total) || {};
    const total = Number(t.total || 0), prio = Number(t.vert || 0) + Number(t.orange || 0);
    if (!total) return "";
    const part = prio / total;
    if (part > 0.4) return `<div class="cmd-item__warn">${ic("triangle-alert")}<span>Règles larges : ${Math.round(part * 100)} % de la base en vert ou orange (${prio} entreprises). Visez un cœur de cible précis : resserrez les NAF ou les tranches avec « Modifier », ou régénérez.</span></div>`;
    return `<div class="muted" style="font-size:12px">Cible vert et orange : ${prio} entreprises (${Math.round(part * 100)} % de la base).</div>`;
  }
  // Semaine en préparation : propositions actives, écartées repliées.
  // Semaine publiée ou passée : les 3 sujets retenus ; le reste replié, en lecture seule.
  function rendrePropositions(el) {
    const box = $("#semProps", el);
    if (!semaine) { box.innerHTML = ""; return; }
    if (!thematiques.length) { box.innerHTML = consultation ? "" : `<div class="cmd-card"><p class="cmd-empty">Aucune proposition pour cette semaine. Lancez la veille, importez un fichier ou ajoutez une thématique à la main.</p></div>`; return; }
    const parOrdre = (a, b) => a.ordre - b.ordre;
    const retenues = thematiques.filter(t => t.statut === "retenue").sort(parOrdre);
    const proposees = thematiques.filter(t => t.statut === "proposee").sort(parOrdre);
    const ecartees = thematiques.filter(t => t.statut === "ecartee").sort(parOrdre);
    const repli = (icone, titre, liste, lecture) => liste.length ? `<details class="cmd-plie"><summary>${ic(icone)}${esc(titre)} <span class="cmd-compte">${liste.length}</span></summary><div class="cmd-plie__corps">${liste.map(t => propositionHtml(t, lecture)).join("")}</div></details>` : "";
    if (semaine.statut === "publiee" || consultation) {
      box.innerHTML = `<div class="cmd-section">${ic("layers")}Sujets de la semaine <span class="cmd-compte">${retenues.length}</span></div>`
        + retenues.map(t => propositionHtml(t, consultation)).join("")
        + repli("archive", "Propositions non retenues", proposees.concat(ecartees), true);
    } else {
      box.innerHTML = `<div class="cmd-section">${ic("layers")}Propositions <span class="muted" style="margin:0;font-weight:500">${retenues.length} retenue${retenues.length > 1 ? "s" : ""} sur 3</span></div>`
        + retenues.concat(proposees).map(t => propositionHtml(t, false)).join("")
        + repli("archive", "Écartées", ecartees, false);
    }
    // Compteurs par couleur calculés d'office pour les propositions actives (les règles trop larges se voient tout de suite).
    if (!consultation && semaine.statut !== "publiee") retenues.concat(proposees).forEach(async (t) => {
      const card = box.querySelector(`[data-id="${t.id}"]`); if (!card) return;
      const b = $("[data-apercu-box]", card); if (!b) return;
      try {
        const c = await C().rpc("commando_apercu_compteurs", { _thematique_id: t.id });
        b.hidden = false; b.innerHTML = apercuHtml(c) + alerteLargeur(c);
      } catch (e) { /* aperçu facultatif */ }
    });
    $$(".cmd-prop", box).forEach(card => {
      const id = card.dataset.id; const t = thematiques.find(x => x.id === id);
      const on = (sel, f) => { const x = $(sel, card); if (x) x.addEventListener("click", f); };
      $$("[data-statut]", card).forEach(b => b.addEventListener("click", () => changerStatut(el, t, b.dataset.statut)));
      on("[data-edit]", () => ouvrirEdition(el, t));
      on("[data-del]", async () => {
        if (!confirm(`Supprimer la thématique « ${t.titre} » ?`)) return;
        const { error } = await sb().from("commando_thematiques").delete().eq("id", id);
        if (error) { C().toast("Échec : " + error.message); return; }
        C().toast("Thématique supprimée"); show(el);
      });
      on("[data-resserrer]", () => resserrer(el, [t]));
      on("[data-mails]", () => redigerMails(el, [t]));
      on("[data-regen]", () => {
        if (!confirm("Régénérer uniquement cette proposition par la veille IA ? L'actuelle sera remplacée.")) return;
        lancerVeille(el, { type: "regeneration", thematique_id: id }, "Régénération en 2 étapes (recherche, puis rédaction) : 3 à 4 minutes.");
      });
      on("[data-apercu]", async () => {
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
    const alerte = Number(tot.non_classee || 0) > Number(tot.total || 0) * 0.3 ? `<div class="cmd-note">${ic("triangle-alert")}<span>${Number(tot.non_classee || 0)} entreprises non classées : les règles laissent des trous.</span></div>` : "";
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
    if (!editEl) { editEl = document.createElement("div"); editEl.className = "modal cmd-ui"; editEl.id = "editThemeModal"; document.body.appendChild(editEl); }
    const js = (o) => esc(JSON.stringify(o, null, 2));
    editEl.innerHTML = `<div class="modal__backdrop" data-edit-close></div>
      <div class="modal__panel"><div class="modal__header"><h2>${t ? "Modifier la thématique" : "Nouvelle thématique (manuelle)"}</h2><button class="modal__close" data-edit-close aria-label="Fermer">${ic("x")}</button></div>
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
          <label class="wide">Mails de suivi (JSON : {"rdv": {"objet","corps"}, "suite": {"objet","corps"}})<textarea name="mails" rows="8" class="mono">${js(v.mails || {})}</textarea></label>
          <label class="wide">Hypothèses (une par ligne)<textarea name="hypotheses" rows="3">${esc((v.hypotheses || []).join("\n"))}</textarea></label>
          <div class="wide cmd-row"><button type="submit" class="btn btn--primary">Enregistrer</button><button type="button" class="btn btn--ghost" data-edit-close>Annuler</button></div>
        </form></div></div>`;
    editEl.hidden = false; document.body.style.overflow = "hidden";
    $$("[data-edit-close]", editEl).forEach(x => x.addEventListener("click", fermerEdition));
    $("#editForm", editEl).addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target; const err = $("#editErr", editEl);
      let sources, regles, trames, objections, mails;
      try {
        sources = JSON.parse(f.sources.value || "[]"); regles = JSON.parse(f.regles.value || "[]");
        trames = JSON.parse(f.trames.value || "{}"); objections = JSON.parse(f.objections.value || "[]"); mails = JSON.parse(f.mails.value || "{}");
      } catch (ex) { err.innerHTML = `<div class="cmd-err">JSON invalide : ${esc(ex.message)}</div>`; return; }
      const row = {
        titre: f.titre.value.trim(), offre_rex: f.offre_rex.value.trim(), cle: f.cle.value.trim() || null,
        pourquoi_maintenant: f.pourquoi_maintenant.value.trim(),
        concurrence: Object.assign({}, (t && t.concurrence) || {}, { constat: f.constat.value.trim(), angle_rex: f.angle_rex.value.trim() }),
        sources: sources.map(s => Object.assign({ verifiee: false }, s)), regles, trames, objections, mails,
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
    if (!semaine || consultation) { box.innerHTML = ""; return; }
    const nb = thematiques.filter(t => t.statut === "retenue").length;
    const publiee = semaine.statut === "publiee";
    box.innerHTML = `<div class="cmd-card">
      <h3>${ic("send")}Publication</h3>
      ${publiee ? `<div class="cmd-ok">${ic("circle-check")}<span>Semaine publiée le ${esc(C().fmtDateTime(semaine.publiee_le))} par ${esc(C().nomDe(semaine.publiee_par))}. Les couleurs sont figées ; les commerciaux ont leurs listes.</span></div>` : `<p class="muted">À la publication, chaque entreprise reçoit une couleur figée pour chacune des 3 thématiques retenues, et les listes apparaissent chez les commerciaux.</p>`}
      <div id="pubStock" class="cmd-stock"></div>
      <div id="pubMsg"></div>
      <div class="cmd-row">
        ${voteActif() ? `<span class="muted" style="margin:0">Vote en cours : ${voteEtat.auto_publier ? "la semaine sera publiée automatiquement à la clôture." : "publiez une fois le vote clos."}</span>` : ""}
        ${publiee
          ? `<button id="pubBtn" class="btn btn--sm" ${nb !== 3 || voteActif() ? "disabled" : ""}>${ic("refresh-cw")}Republier (recalculer les couleurs)</button>`
          : `<button id="pubBtn" class="btn btn--primary" ${nb !== 3 || voteActif() ? "disabled" : ""}>${ic("send")}Publier la semaine (${nb} sur 3 retenues)</button>`}
      </div>
    </div>`;
    if (nb) rendreStock($("#pubStock", el));
    $("#pubBtn", el).addEventListener("click", async () => {
      if (!confirm(semaine.statut === "publiee" ? "Recalculer l'instantané des couleurs ? Possible uniquement si aucun appel n'a encore été enregistré." : "Publier la semaine et figer les couleurs ?")) return;
      const msg = $("#pubMsg", el);
      try {
        const r = await C().rpc("commando_publier", { _semaine_id: semaine.id });
        msg.innerHTML = `<div class="cmd-ok">${ic("circle-check")}<span>Publié : ${Number(r.entreprises)} entreprises, dont ${Number(r.vert)} vertes, ${Number(r.orange)} orange, ${Number(r.rouge)} rouges et ${Number(r.non_classee)} non classées (sur 3 thématiques).</span></div>`;
        const garde = msg.innerHTML;
        await show(el); const m = $("#pubMsg", el); if (m) m.innerHTML = garde;
      } catch (e) { msg.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; }
    });
  }

  // Fiches neuves (jamais appelées) que les sujets retenus donnent à chaque
  // commercial ; sous le plancher, sa liste est complétée automatiquement.
  async function rendreStock(box) {
    if (!box) return;
    let r;
    try { r = await C().rpc("commando_stock_semaine", { _semaine_id: semaine.id }); } catch (e) { box.innerHTML = ""; return; }
    const plancher = Number(r.plancher || 0);
    const lignes = (r.secteurs || []).filter(x => Number(x.stock_total) > 0);
    if (!lignes.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<b>Fiches neuves par commercial</b> <span class="muted" style="display:inline">Jamais appelées, vertes ou orange avec ${Number(r.retenues)} sujet${Number(r.retenues) > 1 ? "s" : ""} retenu${Number(r.retenues) > 1 ? "s" : ""} ; minimum ${plancher}.</span>
      <table><thead><tr><th>Secteur</th><th class="num">Vert</th><th class="num">Orange</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${lignes.map(x => `<tr><td>${esc(x.nom || x.code)}${x.commercial_id ? `, ${esc(C().prenomDe(x.commercial_id))}` : ", secteur libre"}</td><td class="num">${Number(x.vert)}</td><td class="num">${Number(x.orange)}</td><td class="num"><b>${Number(x.neuves)}</b></td>
        <td>${Number(x.complement) > 0 ? `<span class="cmd-stock__alerte">${ic("triangle-alert")}+${Number(x.complement)} en complément</span>` : `<span class="cmd-badge cmd-badge--ok">${ic("check")}Suffisant</span>`}</td></tr>`).join("")}
      </tbody></table>
      ${lignes.some(x => Number(x.complement) > 0) ? `<p class="muted" style="margin-top:8px">Sous le minimum, la liste du commercial est complétée par les meilleures fiches hors sujets (actualité, numéro connu, taille). Pour plus de fiches dans les sujets, élargissez les règles vertes ou orange.</p>` : ""}`;
  }

  /* ---------- RDV passés à valider (toutes semaines) ---------- */
  // Seuls les RDV honorés validés ici comptent pour le badge Fidèle et les
  // fiches du Fidèle : les RDV ont souvent lieu une ou deux semaines après l'appel.
  async function rendreValidation(el) {
    const box = $("#semValider", el);
    if (consultation) { box.innerHTML = ""; return; }
    const { data } = await sb().from("commando_appels").select("id, siret, commercial_id, date_rdv, rdv_statut, note")
      .eq("statut", "rdv").is("rdv_valide_le", null).neq("rdv_statut", "annule").lt("date_rdv", new Date().toISOString()).order("date_rdv").limit(50);
    const list = data || [];
    if (!list.length) { box.innerHTML = ""; return; }
    const { data: ents } = await sb().from("commando_entreprises").select("siret, raison_sociale").in("siret", list.map(a => a.siret));
    const nom = {}; (ents || []).forEach(e => { nom[e.siret] = e.raison_sociale; });
    const RDV = { prevu: "prévu", honore: "honoré (déclaré)", reporte: "reporté" };
    box.innerHTML = `<div class="cmd-bandeau">
      <b>${ic("calendar-check")}${list.length} RDV passé${list.length > 1 ? "s" : ""} à valider</b> <span class="muted">Votre validation alimente le badge Fidèle et les fiches du Fidèle.</span>
      ${list.map(a => `<div class="cmd-bandeau__item" data-id="${a.id}">
        <span><b>${esc(nom[a.siret] || a.siret)}</b><br><span class="muted">${esc(C().nomDe(a.commercial_id))}, ${esc(C().fmtDateTime(a.date_rdv))}, ${esc(RDV[a.rdv_statut] || a.rdv_statut || "")}${a.note ? ". " + esc(a.note) : ""}</span></span>
        <span class="cmd-bandeau__btns">
          <button class="btn btn--sm" data-valider="honore">${ic("check")}Honoré</button>
          <button class="btn btn--sm btn--danger" data-valider="annule">${ic("x")}Annulé</button>
        </span></div>`).join("")}
    </div>`;
    $$("[data-valider]", box).forEach(b => b.addEventListener("click", async () => {
      const id = b.closest(".cmd-bandeau__item").dataset.id;
      try {
        await C().rpc("commando_rdv_valider", { _appel_id: id, _statut: b.dataset.valider });
        C().toast(b.dataset.valider === "honore" ? "RDV validé comme honoré" : "RDV marqué annulé");
        rendreValidation(el);
      } catch (e) { C().toast(C().erreur(e)); }
    }));
  }

  /* ---------- Suivi : RDV de la semaine, nouvelles entreprises ---------- */
  async function rendreSuivi(el) {
    const box = $("#semSuivi", el);
    if (!semaine) { box.innerHTML = ""; return; }
    const [{ data: nouvelles }, { data: rdvs }] = await Promise.all([
      consultation ? Promise.resolve({ data: [] }) : sb().from("commando_entreprises_v").select("siret, raison_sociale, naf_libelle, tranche_effectif, annee_effectif, commune, secteur_code, est_client, exclu_le").eq("nouvelle_semaine", semaine.semaine).is("archived_at", null).order("raison_sociale").limit(300),
      sb().from("commando_appels").select("id, siret, commercial_id, date_rdv, rdv_statut, note, created_at, couleur_au_moment").eq("semaine_id", semaine.id).eq("statut", "rdv").order("date_rdv")
    ]);
    const sirets = (rdvs || []).map(a => a.siret);
    let noms = {};
    if (sirets.length) {
      const { data } = await sb().from("commando_entreprises").select("siret, raison_sociale").in("siret", sirets);
      (data || []).forEach(e => { noms[e.siret] = e.raison_sociale; });
    }
    const RDV = { prevu: "Prévu", honore: "Honoré", annule: "Annulé", reporte: "Reporté" };
    const nb = (rdvs || []).length, nn = (nouvelles || []).length;
    box.innerHTML = `<div class="cmd-card">
      <h3>${ic("calendar-check")}RDV pris ${consultation ? "pendant la semaine" : "cette semaine"} <span class="cmd-compte">${nb}</span></h3>
      ${nb ? `<div class="tbl-scroll" style="margin-top:10px"><table class="grid"><thead><tr><th>Entreprise</th><th>Commercial</th><th>Date du RDV</th><th>État</th><th>Cible</th><th>Note</th></tr></thead><tbody>
        ${rdvs.map(a => `<tr><td>${esc(noms[a.siret] || a.siret)}</td><td>${esc(C().nomDe(a.commercial_id))}</td><td>${esc(C().fmtDateTime(a.date_rdv))}</td><td><span class="cmd-badge ${a.rdv_statut === "honore" ? "cmd-badge--ok" : a.rdv_statut === "annule" ? "cmd-badge--err" : ""}">${esc(RDV[a.rdv_statut] || "")}</span></td><td>${a.couleur_au_moment ? `<span class="cmd-badge cmd-badge--${a.couleur_au_moment}">${esc(COULEUR_NOM[a.couleur_au_moment] || a.couleur_au_moment)}</span>` : ""}</td><td class="muted">${esc(a.note || "")}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Aucun RDV pris pour le moment.</p>`}
    </div>
    ${consultation ? "" : `<details class="cmd-plie"><summary>${ic("building-2")}Nouvelles entreprises de la semaine <span class="cmd-compte">${nn}</span></summary><div class="cmd-plie__corps">
      <p class="muted">Apparues au dernier import. Vous pouvez en exclure définitivement des listes d'appel.</p>
      ${nn ? `<div class="tbl-scroll"><table class="grid"><thead><tr><th>Entreprise</th><th>Activité</th><th>Effectif</th><th>Commune</th><th>Secteur</th><th></th></tr></thead><tbody>
        ${nouvelles.map(e => `<tr data-siret="${esc(e.siret)}"><td>${esc(e.raison_sociale)}${e.est_client ? ' <span class="cmd-badge">Client</span>' : ""}</td><td>${esc(e.naf_libelle || "")}</td><td>${esc(TRANCHES[e.tranche_effectif] || e.tranche_effectif || "?")}${e.annee_effectif ? ` (${e.annee_effectif})` : ""}</td><td>${esc(e.commune || "")}</td><td>${esc(e.secteur_code || "")}</td><td>${e.exclu_le ? `<span class="cmd-badge cmd-badge--gris">Exclue</span>` : `<button class="btn btn--sm" data-exclure>Exclure</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Aucune nouvelle entreprise cette semaine.</p>`}
    </div></details>`}`;
    $$("[data-exclure]", box).forEach(b => b.addEventListener("click", async () => {
      const tr = b.closest("tr"); const raison = prompt("Raison de l'exclusion (facultatif) :") ;
      if (raison === null) return;
      const { error } = await sb().from("commando_entreprises").update({ exclu_le: new Date().toISOString(), exclu_par: C().me().id, exclu_raison: raison || null }).eq("siret", tr.dataset.siret);
      if (error) { C().toast("Échec : " + error.message); return; }
      C().toast("Entreprise exclue"); rendreSuivi(el);
    }));
  }

  C().registerTab({ id: "semaine", label: "Semaine", icone: "calendar-range", roles: ["responsable"], render, onShow: show });
})();
