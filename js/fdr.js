/* ============================================================
   Feuille de route — onglet de l'équipe de Poitiers
   ------------------------------------------------------------
   - Accès : mêmes membres que le Rex Commando (commando_membres).
   - Commercial : « Ma semaine » (feuille courante, tout éditable en
     ligne) et « Historique » (lecture seule).
   - La sécurité réelle est en base (RLS + gardes) ; l'écran ne fait
     que refléter les droits.
   Données : tables fdr_* et vue fdr_feuilles_resume (calculs).
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const TYPES = ["NC", "CA", "UP", "RNV"];
  const TYPES_LIB = { NC: "Nouveau client", CA: "Client acquis", UP: "Cross-sell", RNV: "Renouvellement" };
  const GAMMES = [["copieur_mps", "Copieur-MPS"], ["it", "IT"], ["ged", "GED"], ["telephonie", "Téléphonie"], ["sauvegarde", "Sauvegarde"]];
  const ETAPES = [["r1", "R1"], ["r2", "R2"], ["audit", "Audit"], ["signature", "Signature"]];
  const SUIVANTE = { "": "r1", r1: "r2", r2: "signature", audit: "signature" };
  const SIGNATURES = [["s1", "S+1"], ["mois", "Dans le mois"], ["apres", "Après"]];
  const STATUTS_LIB = { signee: "Signée", perdue: "Perdue", reportee: "Reportée" };
  const RDV_TYPES = ["NC", "CA", "Audit"];

  let membre = null;          // { role } ou null
  let wired = false;
  let onglet = "semaine";     // semaine | historique
  let cible = null;           // commercial affiché (soi-même, ou choix du manager)
  let data = null;            // feuille affichée et ses données
  let lectureSeule = false;

  function sb() { return window.rexSupa; }
  function moi() { return window.RexDB && window.RexDB.me(); }
  function estManager() { return !!membre && membre.role === "responsable"; }
  function toast(m) { const t = $("#toast"); if (!t) return; t.textContent = m; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2600); }
  function erreur(e) { return (e && e.message) ? e.message : String(e); }

  /* ---------- Dates et nombres (français) ---------- */
  function dIso(d) { return d.toISOString().slice(0, 10); }
  function dDe(iso) { return new Date(iso + "T12:00:00Z"); }
  function plusJours(iso, n) { const d = dDe(iso); d.setUTCDate(d.getUTCDate() + n); return dIso(d); }
  function lundi(iso) { const d = dDe(iso); const j = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - (j - 1)); return dIso(d); }
  function aujourdhui() { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); }
  function semaineCourante() { return lundi(aujourdhui()); }
  function jjmm(iso) { if (!iso) return ""; const [, m, j] = iso.split("-"); return `${j}/${m}`; }
  function jjmmaaaa(iso) { if (!iso) return ""; const [a, m, j] = iso.split("-"); return `${j}/${m}/${a}`; }
  function libSemaine(iso) { return `du ${jjmm(iso)} au ${jjmm(plusJours(iso, 4))}`; }
  function keur(v) {
    if (v == null || v === "") return "—";
    return Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " k€";
  }
  // Valeur d'un champ montant : une décimale, virgule française (7,7 ; 15,0).
  function montantSaisie(v) {
    return v == null || v === "" ? "" : Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  }
  function nombre(s) {
    const t = String(s == null ? "" : s).trim().replace(/\s/g, "").replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : NaN;
  }
  function nomDe(id) {
    const p = ((window.RexDB && window.RexDB.profiles && window.RexDB.profiles()) || []).find(x => x.id === id);
    if (p) return p.full_name || p.email;
    const me = moi(); return me && me.id === id ? (me.full_name || me.email) : "—";
  }
  function prenom(nom) { return String(nom || "").split(/\s+/)[0] || "—"; }

  /* ---------- Indicateur d'enregistrement ---------- */
  function etat(txt, err) {
    const el = $("#fdrSave"); if (!el) return;
    el.textContent = txt; el.classList.toggle("fdr__save--err", !!err);
  }

  /* ============================================================
     Chargement d'une feuille et de tout ce qu'elle affiche
     ============================================================ */
  async function q(promesse) {
    const { data: d, error } = await promesse;
    if (error) throw new Error(error.message || String(error));
    return d;
  }
  async function chargerFeuille(f) {
    const c = f.commercial_id, s = f.semaine;
    const [resume, pistes, rdv, engagements, prec, besoins] = await Promise.all([
      q(sb().from("fdr_feuilles_resume").select("*").eq("id", f.id).maybeSingle()),
      // Pistes en cours / reportées, et celles clôturées pendant la semaine de la feuille ou après.
      q(sb().from("fdr_pistes").select("*").eq("commercial_id", c)
        .or(`statut.in.(en_cours,reportee),clos_semaine.gte.${s}`)
        .order("chaude", { ascending: false }).order("created_at", { ascending: true })),
      q(sb().from("fdr_rdv").select("*").eq("commercial_id", c)
        .gte("semaine", s).lte("semaine", plusJours(s, 14))
        .order("semaine").order("date_rdv", { ascending: true, nullsFirst: false }).order("created_at")),
      q(sb().from("fdr_engagements").select("*").eq("feuille_id", f.id).order("ordre")),
      q(sb().from("fdr_feuilles").select("id,semaine,statut").eq("commercial_id", c).lt("semaine", s)
        .order("semaine", { ascending: false }).limit(1)),
      q(sb().from("fdr_besoins").select("*, feuille:fdr_feuilles!inner(commercial_id,semaine)")
        .eq("feuille.commercial_id", c).order("created_at"))
    ]);
    const ids = (pistes || []).map(p => p.id);
    const histo = ids.length ? await q(sb().from("fdr_pistes_historique").select("piste_id,champ,nouveau,le")
      .in("piste_id", ids).eq("champ", "etape").order("le", { ascending: true })) : [];
    const precedente = prec && prec[0] ? prec[0] : null;
    const engagementsPrec = precedente
      ? await q(sb().from("fdr_engagements").select("*").eq("feuille_id", precedente.id).order("ordre"))
      : [];
    const moisInitial = resume ? await q(sb().from("fdr_previsions_mois").select("*")
      .eq("commercial_id", c).eq("mois", resume.mois).maybeSingle()) : null;
    return {
      feuille: f, resume, pistes: pistes || [], rdv: rdv || [], engagements: engagements || [],
      precedente, engagementsPrec,
      // Besoins de la feuille + ceux, non traités, des semaines précédentes.
      besoins: (besoins || []).filter(b => b.feuille_id === f.id || (!b.traite && b.feuille.semaine < s)),
      historique: histo || [], moisInitial
    };
  }
  // Recharge la feuille affichée et redessine (après une action structurante).
  async function recharger() {
    if (!data) return;
    const y = window.scrollY;
    const f = await q(sb().from("fdr_feuilles").select("*").eq("id", data.feuille.id).single());
    data = await chargerFeuille(f);
    dessinerFeuille();
    window.scrollTo({ top: y });
  }
  // Rafraîchit uniquement les prévisions (après un changement de montant / signature / statut).
  async function rafraichirPrevisions() {
    if (!data) return;
    data.resume = await q(sb().from("fdr_feuilles_resume").select("*").eq("id", data.feuille.id).maybeSingle());
    const el = $("#fdrPrevisions"); if (el) el.outerHTML = blocC();
  }

  /* ============================================================
     Écritures (enregistrement en ligne)
     ============================================================ */
  async function enregistrer(table, cle, patch) {
    etat("Enregistrement…");
    try {
      let req = sb().from(table).update(patch);
      Object.keys(cle).forEach(k => { req = req.eq(k, cle[k]); });
      await q(req);
      etat("Enregistré ✓");
      return true;
    } catch (e) {
      etat("Non enregistré ✕", true);
      toast(erreur(e));
      return false;
    }
  }
  async function inserer(table, ligne) {
    etat("Enregistrement…");
    try { const r = await q(sb().from(table).insert(ligne).select().single()); etat("Enregistré ✓"); return r; }
    catch (e) { etat("Non enregistré ✕", true); toast(erreur(e)); return null; }
  }
  async function supprimer(table, id) {
    etat("Enregistrement…");
    try { await q(sb().from(table).delete().eq("id", id)); etat("Enregistré ✓"); return true; }
    catch (e) { etat("Non enregistré ✕", true); toast(erreur(e)); return false; }
  }

  /* ============================================================
     Rendu — petites briques
     ============================================================ */
  function chip(label, on, attrs, cls) {
    return `<button type="button" class="fdr-chip ${on ? "fdr-chip--on" : ""} ${cls || ""}" ${attrs}>${esc(label)}</button>`;
  }
  function bloc(lettre, titre, corps, extra, id) {
    return `<section class="fdr-bloc" ${id ? `id="${id}"` : ""}>
      <div class="fdr-bloc__h"><h3><span class="fdr-lettre">${lettre}</span>${esc(titre)}</h3>${extra || ""}</div>
      ${corps}</section>`;
  }

  /* ---------- A. Engagements du point précédent ---------- */
  function blocA() {
    const p = data.precedente;
    if (!p) return bloc("A", "Engagements du point précédent", `<div class="fdr-vide">Pas de feuille précédente : rien à reprendre cette semaine.</div>`);
    const lignes = data.engagementsPrec.map(e => `
      <div class="fdr-eng">
        <div class="fdr-eng__n">${e.ordre}</div>
        <div class="fdr-eng__c">
          <div style="font-weight:700;font-size:.9rem;padding-top:4px">${esc(e.texte)}${e.fait ? ` <span class="fdr-statut fdr-statut--signee">coché fait</span>` : ""}</div>
          <div class="fdr-ligne">
            <span class="fdr-seg">
              ${chip("Tenu", e.tenu === "tenu", `data-act="tenu" data-id="${e.id}" data-v="tenu"`, "fdr-chip--ok")}
              ${chip("Non tenu", e.tenu === "non_tenu", `data-act="tenu" data-id="${e.id}" data-v="non_tenu"`, "fdr-chip--ko")}
            </span>
            <input class="fdr-in grow" data-t="fdr_engagements" data-id="${e.id}" data-f="tenu_commentaire" value="${esc(e.tenu_commentaire)}" placeholder="Commentaire court">
          </div>
        </div>
      </div>`).join("");
    return bloc("A", "Engagements du point précédent",
      `<div class="muted" style="margin:-4px 0 6px">Feuille de la semaine ${esc(libSemaine(p.semaine))}</div>${lignes || `<div class="fdr-vide">Aucun engagement sur la feuille précédente.</div>`}`);
  }

  /* ---------- B. Pistes ---------- */
  // Historique des changements d'étape (ex. « R1 le 03/11 → R2 le 10/11 »).
  function histoEtapes(p) {
    const h = (data.historique || []).filter(x => x.piste_id === p.id && x.nouveau);
    if (!h.length) return "";
    const lib = k => (ETAPES.find(e => e[0] === k) || [k, k])[1];
    const jour = ts => new Date(ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });
    return `<div class="muted" style="font-size:.74rem;margin:-2px 0 4px">Parcours : ${h.map(x => `${esc(lib(x.nouveau))} le ${jour(x.le)}`).join(" → ")}</div>`;
  }
  function cartePiste(p) {
    const close = p.statut === "signee" || p.statut === "perdue";
    const suiv = SUIVANTE[p.etape || ""];
    const suivLib = suiv ? (ETAPES.find(e => e[0] === suiv) || [])[1] : null;
    return `<article class="fdr-piste ${p.chaude ? "fdr-piste--chaude" : ""} ${close ? "fdr-piste--close" : ""}" data-piste="${p.id}">
      <div class="fdr-piste__head">
        <input class="fdr-in fdr-in--titre" data-t="fdr_pistes" data-id="${p.id}" data-f="compte" value="${esc(p.compte)}" aria-label="Compte">
        ${p.statut !== "en_cours" ? `<span class="fdr-statut fdr-statut--${p.statut}">${STATUTS_LIB[p.statut]}</span>` : ""}
        <button type="button" class="fdr-chaude ${p.chaude ? "fdr-chaude--on" : ""}" data-act="chaude" data-id="${p.id}" title="Piste chaude">🔥</button>
      </div>
      <div class="fdr-ligne">
        <span class="fdr-seg">${TYPES.map(t => chip(t, p.type === t, `data-act="type" data-id="${p.id}" data-v="${t}" title="${TYPES_LIB[t]}"`)).join("")}</span>
        <span class="fdr-montant"><input class="fdr-in fdr-in--num" inputmode="decimal" data-t="fdr_pistes" data-id="${p.id}" data-f="montant" data-num="1" value="${montantSaisie(p.montant)}" placeholder="—" aria-label="Montant k€ HT"><span>k€ HT</span></span>
        <span class="fdr-seg">${GAMMES.map(([k, l]) => chip(l, (p.gammes || []).includes(k), `data-act="gamme" data-id="${p.id}" data-v="${k}"`)).join("")}</span>
      </div>
      <div class="fdr-ligne">
        <span class="fdr-groupe"><span class="fdr-lbl">Étape</span>
          ${ETAPES.map(([k, l]) => chip(l, p.etape === k, `data-act="etape" data-id="${p.id}" data-v="${k}"`)).join("")}
          ${suiv && !close ? `<button type="button" class="fdr-btn fdr-act" data-act="etape" data-id="${p.id}" data-v="${suiv}">→ ${esc(suivLib)}</button>` : ""}</span>
        <span class="fdr-groupe"><span class="fdr-lbl">Signature</span>
          ${SIGNATURES.map(([k, l]) => chip(l, p.signature_prevue === k, `data-act="signature" data-id="${p.id}" data-v="${k}"`)).join("")}</span>
      </div>
      ${histoEtapes(p)}
      <div class="fdr-ligne">
        <input class="fdr-in grow" data-t="fdr_pistes" data-id="${p.id}" data-f="prochaine_action" value="${esc(p.prochaine_action)}" placeholder="Prochaine action">
        <input class="fdr-in fdr-in--date" type="date" data-t="fdr_pistes" data-id="${p.id}" data-f="prochaine_action_date" value="${esc(p.prochaine_action_date)}" aria-label="Date de la prochaine action">
      </div>
      <input class="fdr-in" data-t="fdr_pistes" data-id="${p.id}" data-f="blocage" value="${esc(p.blocage)}" placeholder="Blocage éventuel">
      ${p.decide_au_point ? `<div class="fdr-decide">🎯 <b>Décidé au point :</b> ${esc(p.decide_au_point)}</div>` : ""}
      <div class="fdr-piste__actions fdr-act">
        ${p.statut === "en_cours" ? `
          <button type="button" class="fdr-btn fdr-btn--ok" data-act="statut" data-id="${p.id}" data-v="signee">✓ Signée</button>
          <button type="button" class="fdr-btn fdr-btn--ko" data-act="statut" data-id="${p.id}" data-v="perdue">✕ Perdue</button>
          <button type="button" class="fdr-btn" data-act="statut" data-id="${p.id}" data-v="reportee">⏳ Reportée</button>`
        : `<button type="button" class="fdr-btn" data-act="statut" data-id="${p.id}" data-v="en_cours">↺ Remettre en cours</button>`}
        <button type="button" class="fdr-btn fdr-btn--icone" data-act="suppr-piste" data-id="${p.id}" title="Supprimer la piste" style="margin-left:auto">🗑</button>
      </div>
    </article>`;
  }
  function blocB() {
    const enCours = data.pistes.filter(p => p.statut === "en_cours" || p.statut === "reportee");
    const closes = data.pistes.filter(p => p.statut === "signee" || p.statut === "perdue");
    const ajout = `<form class="fdr-ajout fdr-act" id="fdrAjoutPiste" autocomplete="off">
        <input class="fdr-in grow" name="compte" placeholder="Nouvelle piste : compte" required>
        <select class="fdr-in" name="type" style="max-width:96px" aria-label="Type">${TYPES.map(t => `<option ${t === "NC" ? "selected" : ""}>${t}</option>`).join("")}</select>
        <input class="fdr-in fdr-in--num" name="montant" inputmode="decimal" placeholder="k€ (option)">
        <button class="fdr-btn fdr-btn--primaire" type="submit">＋ Ajouter</button>
      </form>`;
    const corps = (enCours.length ? `<div class="fdr-pistes">${enCours.map(cartePiste).join("")}</div>` : `<div class="fdr-vide">Aucune piste en cours.</div>`)
      + (closes.length ? `<div class="fdr-sub">Clôturées cette semaine</div><div class="fdr-pistes">${closes.map(cartePiste).join("")}</div>` : "")
      + ajout;
    const chaudes = enCours.filter(p => p.chaude && p.statut === "en_cours").length;
    return bloc("B", "Pistes", corps, `<span class="muted" style="margin:0">${enCours.length} en cours · ${chaudes} 🔥</span>`);
  }

  /* ---------- C. Prévisions ---------- */
  function blocC() {
    const r = data.resume || {};
    const mi = data.moisInitial;
    const moisLib = r.mois ? new Date(r.mois + "T12:00:00Z").toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" }) : "";
    const initial = mi
      ? `<div class="fdr-kpi__v">${keur(mi.montant)}</div><div class="fdr-kpi__l">Mois initial (${esc(moisLib)}) 🔒</div>`
      : `<div class="fdr-kpi__l" style="margin-bottom:6px">Mois initial (${esc(moisLib)}) — à saisir une fois</div>
         <form class="fdr-ligne fdr-act" id="fdrMoisInitial" style="margin:0">
           <input class="fdr-in fdr-in--num" name="montant" inputmode="decimal" placeholder="k€" required>
           <button class="fdr-btn fdr-btn--primaire" type="submit">Figer</button>
         </form>`;
    return `<section class="fdr-bloc" id="fdrPrevisions">
      <div class="fdr-bloc__h"><h3><span class="fdr-lettre">C</span>Prévisions</h3></div>
      <div class="fdr-kpis">
        <div class="fdr-kpi"><div class="fdr-kpi__v">${keur(r.prevision_s1 || 0)}</div><div class="fdr-kpi__l">S+1 (pistes signature S+1)</div></div>
        <div class="fdr-kpi"><div class="fdr-kpi__v">${keur(r.mois_ajuste_calcule || 0)}</div><div class="fdr-kpi__l">Mois ajusté (calculé)</div>
          <div class="fdr-kpi__x">Déclaré :
            <input class="fdr-in fdr-in--num" style="display:inline-block;width:90px;padding:5px 8px;font-size:14px" inputmode="decimal" data-t="fdr_feuilles" data-id="${data.feuille.id}" data-f="mois_ajuste_declare" data-num="1" data-prev="1" value="${montantSaisie(data.feuille.mois_ajuste_declare)}" placeholder="—"> k€
            <input class="fdr-in" style="flex:1 1 100%;padding:5px 8px;font-size:14px" data-t="fdr_feuilles" data-id="${data.feuille.id}" data-f="mois_ajuste_note" value="${esc(data.feuille.mois_ajuste_note)}" placeholder="Pourquoi (facultatif)">
          </div></div>
        <div class="fdr-kpi">${initial}</div>
      </div>
    </section>`;
  }

  /* ---------- D. Portefeuille ---------- */
  function blocD() {
    const f = data.feuille;
    const recos = Array.isArray(f.recos) ? f.recos : [];
    const lignes = recos.map((r, i) => `
      <div class="fdr-ligne">
        <input class="fdr-in grow" data-reco="${i}" data-k="a_qui" value="${esc(r.a_qui)}" placeholder="À qui demander">
        <input class="fdr-in grow" data-reco="${i}" data-k="pour_qui" value="${esc(r.pour_qui)}" placeholder="Pour qui">
        <button type="button" class="fdr-btn fdr-btn--icone fdr-act" data-act="suppr-reco" data-i="${i}" title="Retirer">✕</button>
      </div>`).join("");
    return bloc("D", "Portefeuille", `
      <label class="fdr-lbl">Visites clients prévues</label>
      <textarea class="fdr-in" rows="2" data-t="fdr_feuilles" data-id="${f.id}" data-f="visites" placeholder="Comptes à visiter cette semaine">${esc(f.visites)}</textarea>
      <div class="fdr-sub">Recommandations à demander</div>
      ${lignes || `<div class="fdr-vide">Aucune pour l'instant.</div>`}
      <button type="button" class="fdr-btn fdr-act" data-act="ajout-reco" style="margin-top:6px">＋ Recommandation</button>`);
  }

  /* ---------- E. Plan d'attaque ---------- */
  function blocE() {
    const f = data.feuille, s = f.semaine;
    const cols = [1, 2, 3].map(k => {
      const sem = plusJours(s, (k - 1) * 7);
      const liste = data.rdv.filter(r => r.semaine === sem);
      const det = liste.filter(r => r.type || r.libelle);
      const sd = liste.filter(r => !r.type && !r.libelle);
      const cpt = t => liste.filter(r => r.type === t).length;
      return `<div class="fdr-sem">
        <div class="fdr-sem__h"><b>S+${k}</b><small>${esc(libSemaine(sem))}</small></div>
        <div class="fdr-sem__n">${liste.length} <span style="font-size:.8rem;font-weight:700;color:var(--muted)">RDV</span></div>
        <div class="fdr-sem__types">${cpt("CA")} CA · ${cpt("NC")} NC · ${cpt("Audit")} Audit${sd.length ? ` · ${sd.length} sans détail` : ""}</div>
        ${det.map(r => `<div class="fdr-rdv"><span title="${esc(r.libelle)}">${esc(r.libelle || "RDV")}</span>
            <em>${esc(r.type || "")}${r.date_rdv ? " · " + jjmm(r.date_rdv) : ""}</em>
            <button type="button" class="fdr-btn fdr-btn--icone fdr-act" data-act="suppr-rdv" data-id="${r.id}" title="Retirer" style="min-height:28px;padding:2px 7px">✕</button></div>`).join("")}
        <div class="fdr-sd fdr-act">Sans détail :
          <button type="button" class="fdr-btn fdr-btn--icone" data-act="sd-moins" data-sem="${sem}" ${sd.length ? "" : "disabled"}>−</button>
          <b>${sd.length}</b>
          <button type="button" class="fdr-btn fdr-btn--icone" data-act="sd-plus" data-sem="${sem}">＋</button>
        </div>
        <form class="fdr-act" data-ajout-rdv="${sem}" autocomplete="off" style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
          <input class="fdr-in" name="libelle" placeholder="＋ RDV : compte — objet" required>
          <div style="display:flex;gap:6px">
            <select class="fdr-in" name="type" aria-label="Type">${RDV_TYPES.map(t => `<option ${t === "NC" ? "selected" : ""}>${t}</option>`).join("")}</select>
            <input class="fdr-in" type="date" name="date_rdv" min="${sem}" max="${plusJours(sem, 6)}" aria-label="Date (facultative)">
          </div>
          <button class="fdr-btn fdr-btn--primaire" type="submit">Ajouter</button>
        </form>
      </div>`;
    }).join("");
    return bloc("E", "Plan d'attaque", `
      <div class="fdr-semaines">${cols}</div>
      <div class="fdr-sub">Trous à combler</div>
      <div class="fdr-grille">
        <div><label class="fdr-lbl">Cible</label><input class="fdr-in" data-t="fdr_feuilles" data-id="${f.id}" data-f="trous_cible" value="${esc(f.trous_cible)}"></div>
        <div><label class="fdr-lbl">Canal</label><input class="fdr-in" data-t="fdr_feuilles" data-id="${f.id}" data-f="trous_canal" value="${esc(f.trous_canal)}"></div>
        <div><label class="fdr-lbl">Créneaux bloqués</label><input class="fdr-in" data-t="fdr_feuilles" data-id="${f.id}" data-f="trous_creneaux" value="${esc(f.trous_creneaux)}"></div>
        <div><label class="fdr-lbl">Objectif RDV</label><input class="fdr-in fdr-in--num" inputmode="numeric" data-t="fdr_feuilles" data-id="${f.id}" data-f="trous_objectif_rdv" data-entier="1" value="${f.trous_objectif_rdv == null ? "" : f.trous_objectif_rdv}"></div>
      </div>
      <div class="fdr-sub">Thème commando du lundi</div>
      <input class="fdr-in" data-t="fdr_feuilles" data-id="${f.id}" data-f="theme_commando" value="${esc(f.theme_commando)}" placeholder="Thématique d'appel">`);
  }

  /* ---------- F. Engagements de la semaine ---------- */
  function blocF() {
    const lignes = data.engagements.map(e => `
      <div class="fdr-eng ${e.fait ? "fdr-eng--fait" : ""}">
        <input type="checkbox" class="fdr-check" data-act="fait" data-id="${e.id}" ${e.fait ? "checked" : ""} title="Fait">
        <div class="fdr-eng__c">
          <textarea class="fdr-in" rows="2" data-t="fdr_engagements" data-id="${e.id}" data-f="texte">${esc(e.texte)}</textarea>
          <div class="fdr-ligne"><span class="fdr-lbl" style="margin:0">Pour le</span>
            <input class="fdr-in fdr-in--date" type="date" data-t="fdr_engagements" data-id="${e.id}" data-f="echeance" value="${esc(e.echeance)}">
            <button type="button" class="fdr-btn fdr-btn--icone fdr-act" data-act="suppr-eng" data-id="${e.id}" title="Retirer" style="margin-left:auto">🗑</button>
          </div>
        </div>
      </div>`).join("");
    const ajout = data.engagements.length < 3 ? `
      <form class="fdr-ajout fdr-act" id="fdrAjoutEng" autocomplete="off">
        <input class="fdr-in grow" name="texte" placeholder="Nouvel engagement (${3 - data.engagements.length} restant${data.engagements.length === 2 ? "" : "s"})" required>
        <button class="fdr-btn fdr-btn--primaire" type="submit">＋</button>
      </form>` : "";
    const faits = data.engagements.filter(e => e.fait).length;
    return bloc("F", "Engagements de la semaine", (lignes || `<div class="fdr-vide">Aucun engagement.</div>`) + ajout,
      `<span class="muted" style="margin:0">${faits}/${data.engagements.length} fait${faits > 1 ? "s" : ""}</span>`);
  }

  /* ---------- G. Besoin de Scott ---------- */
  function blocG() {
    const f = data.feuille;
    const lignes = data.besoins.map(b => {
      const ancien = b.feuille_id !== f.id;
      const modifiable = !b.traite && !ancien;
      return `<div class="fdr-besoin">
        ${modifiable ? `<input class="fdr-in grow" data-t="fdr_besoins" data-id="${b.id}" data-f="texte" value="${esc(b.texte)}">`
                     : `<span class="grow" style="font-size:.9rem">${esc(b.texte)}${ancien ? ` <em class="muted" style="font-size:.74rem">(depuis le ${jjmm(b.feuille.semaine)})</em>` : ""}</span>`}
        <span class="fdr-statut ${b.traite ? "fdr-statut--signee" : "fdr-statut--reportee"}">${b.traite ? "Traité ✓" : "En attente"}</span>
        ${modifiable ? `<button type="button" class="fdr-btn fdr-btn--icone fdr-act" data-act="suppr-besoin" data-id="${b.id}" title="Retirer">✕</button>` : ""}
      </div>`;
    }).join("");
    return bloc("G", "Besoin de Scott", (lignes || `<div class="fdr-vide">Aucun besoin.</div>`) + `
      <form class="fdr-ajout fdr-act" id="fdrAjoutBesoin" autocomplete="off">
        <input class="fdr-in grow" name="texte" placeholder="Ce dont j'ai besoin de Scott" required>
        <button class="fdr-btn fdr-btn--primaire" type="submit">＋</button>
      </form>`);
  }

  /* ============================================================
     Vue d'une feuille
     ============================================================ */
  function dessinerFeuille() {
    const el = $("#fdrBody"); if (!el || !data) return;
    const f = data.feuille;
    const titre = estManager() && f.commercial_id !== (moi() || {}).id ? prenom(nomDe(f.commercial_id)) + " — " : "";
    el.innerHTML = `<div class="${lectureSeule ? "fdr--ro" : ""}" id="fdrFeuille">
      <div class="fdr-head">
        <h2>${esc(titre)}Semaine ${esc(libSemaine(f.semaine))}</h2>
        <p class="muted">Point du ${jjmm(plusJours(f.semaine, -3))}${f.statut === "figee" ? " · feuille figée 🔒" : ""}${lectureSeule ? " · lecture seule" : ""}</p>
      </div>
      ${lectureSeule && !f.instantane ? `<div class="fdr-note">Pistes et RDV affichés dans leur état actuel.</div>` : ""}
      ${blocA()}${blocB()}${blocC()}${blocD()}${blocE()}${blocF()}${blocG()}
    </div>`;
    if (lectureSeule) {
      $$("#fdrFeuille input, #fdrFeuille textarea, #fdrFeuille select, #fdrFeuille button").forEach(x => { x.disabled = true; });
    }
  }

  async function ouvrirSemaine() {
    const el = $("#fdrBody");
    el.innerHTML = `<div class="fdr-vide">Chargement…</div>`;
    lectureSeule = false;
    try {
      const derniere = await q(sb().from("fdr_feuilles").select("*").eq("commercial_id", cible)
        .order("semaine", { ascending: false }).limit(1));
      if (!derniere || !derniere.length) {
        data = null;
        const sem = semaineCourante();
        el.innerHTML = `<section class="fdr-bloc"><p>Pas encore de feuille de route${cible === (moi() || {}).id ? "" : " pour " + esc(prenom(nomDe(cible)))}.</p>
          <button type="button" class="fdr-btn fdr-btn--primaire" id="fdrCreer">Créer la feuille de la semaine ${esc(libSemaine(sem))}</button></section>`;
        $("#fdrCreer").addEventListener("click", async () => {
          const f = await inserer("fdr_feuilles", { commercial_id: cible, semaine: sem });
          if (f) ouvrirSemaine();
        });
        return;
      }
      data = await chargerFeuille(derniere[0]);
      dessinerFeuille();
    } catch (e) {
      el.innerHTML = `<div class="fdr-note" style="background:var(--danger-bg);color:var(--danger)">Erreur de chargement : ${esc(erreur(e))}</div>`;
    }
  }

  async function ouvrirHistorique() {
    const el = $("#fdrBody");
    el.innerHTML = `<div class="fdr-vide">Chargement…</div>`;
    data = null;
    try {
      const liste = await q(sb().from("fdr_feuilles_resume").select("id,semaine,statut,prevision_s1,pistes_chaudes,rdv")
        .eq("commercial_id", cible).order("semaine", { ascending: false }));
      const passees = (liste || []).slice(1);   // la plus récente est la feuille courante
      el.innerHTML = `<section class="fdr-bloc">
        <div class="fdr-bloc__h"><h3>Feuilles précédentes</h3></div>
        ${passees.length ? `<div class="fdr-histo">${passees.map(f => `
          <button type="button" class="fdr-histo__item" data-histo="${f.id}">
            <span><b>Semaine ${esc(libSemaine(f.semaine))}</b><br><span class="muted" style="font-size:.78rem">Point du ${jjmm(plusJours(f.semaine, -3))}</span></span>
            <span class="fdr-statut ${f.statut === "figee" ? "fdr-statut--signee" : "fdr-statut--reportee"}">${f.statut === "figee" ? "Figée 🔒" : "Ouverte"}</span>
          </button>`).join("")}</div>`
          : `<div class="fdr-vide">Aucune feuille précédente pour l'instant : l'historique se remplira à chaque point du vendredi.</div>`}
      </section>`;
      $$("[data-histo]", el).forEach(b => b.addEventListener("click", async () => {
        try {
          const f = await q(sb().from("fdr_feuilles").select("*").eq("id", b.dataset.histo).single());
          data = await chargerFeuille(f);
          lectureSeule = true;
          dessinerFeuille();
          $("#fdrFeuille").insertAdjacentHTML("afterbegin", `<button type="button" class="fdr-btn" id="fdrRetourHisto" style="margin-bottom:10px">← Historique</button>`);
          $("#fdrRetourHisto").addEventListener("click", ouvrirHistorique);
          window.scrollTo({ top: 0 });
        } catch (e) { toast(erreur(e)); }
      }));
    } catch (e) {
      el.innerHTML = `<div class="fdr-note" style="background:var(--danger-bg);color:var(--danger)">Erreur de chargement : ${esc(erreur(e))}</div>`;
    }
  }

  /* ============================================================
     Interactions (délégation sur le corps de la vue)
     ============================================================ */
  function pisteDe(id) { return data && data.pistes.find(p => p.id === id); }

  // Champs texte / nombre / date : enregistrés à la sortie du champ.
  async function surChangement(ev) {
    if (!data || lectureSeule) return;
    const el = ev.target;
    // Recommandations : la liste entière est enregistrée.
    if (el.dataset.reco != null) {
      const recos = (data.feuille.recos || []).slice();
      recos[+el.dataset.reco] = Object.assign({}, recos[+el.dataset.reco], { [el.dataset.k]: el.value.trim() });
      if (await enregistrer("fdr_feuilles", { id: data.feuille.id }, { recos })) data.feuille.recos = recos;
      return;
    }
    const t = el.dataset.t, id = el.dataset.id, f = el.dataset.f;
    if (!t || !id || !f) return;
    let v = el.value;
    if (el.dataset.num) {
      v = nombre(v);
      if (Number.isNaN(v)) { toast("Montant invalide (ex. 7,5)"); return; }
      el.value = montantSaisie(v);
    } else if (el.dataset.entier) {
      v = v.trim() === "" ? null : parseInt(v, 10);
      if (v != null && (!Number.isFinite(v) || v < 0)) { toast("Nombre invalide"); return; }
    } else if (el.type === "date") {
      v = v || null;
    } else {
      v = v.trim();
      if (f === "compte" || f === "texte") {
        if (!v) { toast("Ce champ ne peut pas être vide"); return recharger(); }
      } else if (v === "") v = null;
    }
    const ok = await enregistrer(t, { id }, { [f]: v });
    if (!ok) return recharger();
    // Garder les données locales à jour.
    const src = t === "fdr_pistes" ? data.pistes : t === "fdr_engagements" ? data.engagements.concat(data.engagementsPrec)
      : t === "fdr_besoins" ? data.besoins : [data.feuille];
    const row = src.find(x => x.id === id); if (row) row[f] = v;
    if ((t === "fdr_pistes" && f === "montant") || el.dataset.prev) rafraichirPrevisions();
  }

  async function surClic(ev) {
    const b = ev.target.closest("[data-act]");
    if (!b || !data || lectureSeule || b.disabled) return;
    const act = b.dataset.act, id = b.dataset.id, v = b.dataset.v;
    const p = id ? pisteDe(id) : null;
    switch (act) {
      case "chaude": if (await enregistrer("fdr_pistes", { id }, { chaude: !p.chaude })) recharger(); break;
      case "type": if (await enregistrer("fdr_pistes", { id }, { type: p.type === v ? null : v })) recharger(); break;
      case "gamme": {
        const g = new Set(p.gammes || []); g.has(v) ? g.delete(v) : g.add(v);
        if (await enregistrer("fdr_pistes", { id }, { gammes: Array.from(g) })) recharger();
        break;
      }
      case "etape": if (await enregistrer("fdr_pistes", { id }, { etape: p.etape === v ? null : v })) recharger(); break;
      case "signature": if (await enregistrer("fdr_pistes", { id }, { signature_prevue: p.signature_prevue === v ? null : v })) recharger(); break;
      case "statut":
        if (await enregistrer("fdr_pistes", { id }, { statut: v })) {
          if (v === "signee") toast(`🎉 ${p.compte} signée !`);
          recharger();
        }
        break;
      case "suppr-piste":
        if (confirm(`Supprimer la piste « ${p.compte} » ? (Pour une affaire perdue, préférez « Perdue ».)`) && await supprimer("fdr_pistes", id)) recharger();
        break;
      case "tenu": {
        const e = data.engagementsPrec.find(x => x.id === id);
        if (await enregistrer("fdr_engagements", { id }, { tenu: e.tenu === v ? null : v })) recharger();
        break;
      }
      case "fait": {
        const e = data.engagements.find(x => x.id === id);
        if (await enregistrer("fdr_engagements", { id }, { fait: b.checked })) { e.fait = b.checked; b.closest(".fdr-eng").classList.toggle("fdr-eng--fait", b.checked); recharger(); }
        else b.checked = !b.checked;
        break;
      }
      case "suppr-eng": if (confirm("Retirer cet engagement ?") && await supprimer("fdr_engagements", id)) recharger(); break;
      case "suppr-besoin": if (await supprimer("fdr_besoins", id)) recharger(); break;
      case "suppr-rdv": if (await supprimer("fdr_rdv", id)) recharger(); break;
      case "sd-plus":
        if (await inserer("fdr_rdv", { commercial_id: data.feuille.commercial_id, semaine: b.dataset.sem })) recharger();
        break;
      case "sd-moins": {
        const r = data.rdv.filter(x => x.semaine === b.dataset.sem && !x.type && !x.libelle).pop();
        if (r && await supprimer("fdr_rdv", r.id)) recharger();
        break;
      }
      case "ajout-reco": {
        const recos = (data.feuille.recos || []).concat([{ a_qui: "", pour_qui: "" }]);
        if (await enregistrer("fdr_feuilles", { id: data.feuille.id }, { recos })) { data.feuille.recos = recos; dessinerFeuille(); }
        break;
      }
      case "suppr-reco": {
        const recos = (data.feuille.recos || []).filter((_, i) => i !== +b.dataset.i);
        if (await enregistrer("fdr_feuilles", { id: data.feuille.id }, { recos })) { data.feuille.recos = recos; dessinerFeuille(); }
        break;
      }
    }
  }

  async function surEnvoi(ev) {
    const form = ev.target;
    if (!data || lectureSeule) return;
    ev.preventDefault();
    const fd = new FormData(form);
    const c = data.feuille.commercial_id;
    if (form.id === "fdrAjoutPiste") {
      const montant = nombre(fd.get("montant"));
      if (Number.isNaN(montant)) { toast("Montant invalide (ex. 7,5)"); return; }
      const compte = String(fd.get("compte") || "").trim(); if (!compte) return;
      if (await inserer("fdr_pistes", { commercial_id: c, compte, type: fd.get("type") || null, montant })) {
        await recharger();
        const champ = $("#fdrAjoutPiste input[name=compte]"); if (champ) champ.focus();
      }
    } else if (form.id === "fdrAjoutEng") {
      const texte = String(fd.get("texte") || "").trim(); if (!texte) return;
      const pris = data.engagements.map(e => e.ordre);
      const ordre = [1, 2, 3].find(n => !pris.includes(n));
      if (!ordre) { toast("3 engagements au maximum"); return; }
      if (await inserer("fdr_engagements", { feuille_id: data.feuille.id, ordre, texte })) recharger();
    } else if (form.id === "fdrAjoutBesoin") {
      const texte = String(fd.get("texte") || "").trim(); if (!texte) return;
      if (await inserer("fdr_besoins", { feuille_id: data.feuille.id, texte })) recharger();
    } else if (form.id === "fdrMoisInitial") {
      const montant = nombre(fd.get("montant"));
      if (montant == null || Number.isNaN(montant)) { toast("Montant invalide (ex. 25,0)"); return; }
      if (!confirm(`Figer la prévision du mois à ${keur(montant)} ? Elle ne sera plus modifiable (sauf par Scott).`)) return;
      if (await inserer("fdr_previsions_mois", { commercial_id: c, mois: data.resume.mois, montant })) recharger();
    } else if (form.dataset.ajoutRdv) {
      const libelle = String(fd.get("libelle") || "").trim(); if (!libelle) return;
      const ligne = { commercial_id: c, semaine: form.dataset.ajoutRdv, libelle, type: fd.get("type") || null, date_rdv: fd.get("date_rdv") || null };
      if (await inserer("fdr_rdv", ligne)) recharger();
    }
  }

  /* ============================================================
     Navigation : vue plein écran, onglets, choix du commercial
     ============================================================ */
  function onglets() {
    return [["semaine", estManager() ? "📋 Feuille de la semaine" : "📋 Ma semaine"], ["historique", "🗂️ Historique"]];
  }
  function dessinerBarre() {
    const nav = $("#fdrTabs"); if (!nav) return;
    nav.innerHTML = onglets().map(([id, l]) => `<button class="tab ${id === onglet ? "tab--active" : ""}" data-fdr-tab="${id}">${esc(l)}</button>`).join("");
    $$("[data-fdr-tab]", nav).forEach(b => b.addEventListener("click", () => montrer(b.dataset.fdrTab)));
    const who = $("#fdrWho");
    if (who) who.hidden = !estManager();
  }
  async function remplirChoixCommercial() {
    const sel = $("#fdrWhoSel"); if (!sel || !estManager()) return;
    const membres = await q(sb().from("commando_membres").select("user_id,role").eq("role", "commercial"));
    const liste = (membres || []).map(m => ({ id: m.user_id, nom: nomDe(m.user_id) })).sort((a, b) => a.nom.localeCompare(b.nom));
    sel.innerHTML = liste.map(m => `<option value="${m.id}">${esc(m.nom)}</option>`).join("");
    if (!cible || !liste.some(m => m.id === cible)) cible = liste[0] ? liste[0].id : null;
    sel.value = cible || "";
  }
  function montrer(id) {
    onglet = id;
    dessinerBarre();
    try { history.replaceState(null, "", location.pathname + location.search + "#fdr/" + id); } catch (e) { /* ignoré */ }
    if (!cible) { $("#fdrBody").innerHTML = `<div class="fdr-vide">Aucun commercial dans l'équipe.</div>`; return; }
    if (id === "historique") ouvrirHistorique(); else ouvrirSemaine();
  }
  async function ouvrir(id) {
    // Une seule vue plein écran à la fois : on referme le Rex Commando.
    if (window.RexCommando && document.body.classList.contains("cmd-mode")) window.RexCommando.close();
    document.body.classList.add("fdr-mode");
    $("#fdrView").hidden = false;
    window.scrollTo({ top: 0 });
    if (estManager()) {
      try { await remplirChoixCommercial(); } catch (e) { toast(erreur(e)); }
    } else {
      cible = (moi() || {}).id;
    }
    montrer(id || onglet);
  }
  function fermer() {
    document.body.classList.remove("fdr-mode");
    const v = $("#fdrView"); if (v) v.hidden = true;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignoré */ }
  }
  function wire() {
    if (wired) return; wired = true;
    const b = $("#btnFdr"); if (b) b.addEventListener("click", () => document.body.classList.contains("fdr-mode") ? fermer() : ouvrir());
    const back = $("#fdrBack"); if (back) back.addEventListener("click", fermer);
    // Ouvrir le Rex Commando referme la feuille de route.
    const bc = $("#btnCommando"); if (bc) bc.addEventListener("click", () => { if (document.body.classList.contains("fdr-mode")) fermer(); }, true);
    const sel = $("#fdrWhoSel"); if (sel) sel.addEventListener("change", () => { cible = sel.value; montrer(onglet); });
    const body = $("#fdrBody");
    body.addEventListener("change", ev => {
      if (ev.target.matches(".fdr-check")) return;   // case « fait » : gérée au clic
      if (ev.target.closest("form")) return;          // formulaires d'ajout : gérés à l'envoi
      surChangement(ev);
    });
    body.addEventListener("click", surClic);
    body.addEventListener("submit", surEnvoi);
  }

  /* ---------- Démarrage (appelé par app.js après connexion) ---------- */
  async function onBoot() {
    const me = moi();
    const btn = $("#btnFdr");
    if (!me || !sb()) { if (btn) btn.hidden = true; return; }
    try {
      const { data: m } = await sb().from("commando_membres").select("role").eq("user_id", me.id).maybeSingle();
      membre = m || null;
    } catch (e) { membre = null; }
    if (btn) btn.hidden = !membre;
    if (!membre) return;
    wire();
    const h = /^#fdr(?:\/([\w-]+))?/.exec(location.hash || "");
    if (h) ouvrir(h[1] || null);
  }

  window.RexFdr = { onBoot, ouvrir, fermer, recharger };
})();
