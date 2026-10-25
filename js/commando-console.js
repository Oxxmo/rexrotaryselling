/* ============================================================
   Rex Commando — console du responsable (partie 1)
   ------------------------------------------------------------
   Onglets : Base (compteurs), Secteurs, Membres, Imports (rapport,
   lancement, liste clients) et Paramètres. Réservés au rôle
   « responsable » ; la base refuse de toute façon les autres.
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const C = () => window.RexCommando;
  const esc = (s) => C().esc(s);
  const sb = () => C().sb();

  const TRANCHES = { "02": "3 à 5", "03": "6 à 9", "11": "10 à 19", "12": "20 à 49", "21": "50 à 99" };
  const FAMILLES = { impression: "Impression et copieurs", ged: "Gestion documentaire et dématérialisation", cyber: "Cybersécurité et réseau", telephonie: "Téléphonie", informatique: "Informatique (serveurs, sauvegarde, postes)" };
  const EXCLUSIONS = {
    ferme: "établissement fermé", diffusion_partielle: "diffusion partielle (non publiable)",
    effectif_non_renseigne: "effectif non renseigné", tranche_hors_perimetre: "tranche hors périmètre"
  };
  const n = (v) => Number(v || 0);

  /* ============================================================
     Onglet « Base » : compteurs par secteur et code postal
     ============================================================ */
  async function renderBase(el) {
    el.innerHTML = `<div class="cmd-card">
      <h3>Base d'entreprises</h3>
      <p class="muted">Établissements actifs par secteur et code postal (source : API Recherche d'entreprises). Les clients et les oppositions restent en base mais sont exclus des listes d'appel.</p>
      <div id="baseCards" class="cmd-cards"></div>
      <div id="baseTables"></div>
    </div>`;
  }
  async function showBase(el) {
    const [stats, cps, secteurs] = await Promise.all([
      C().rpc("commando_stats_base"),
      sb().from("commando_codes_postaux").select("*").order("code_postal").then(r => r.data || []),
      sb().from("commando_secteurs").select("*").order("ordre").then(r => r.data || [])
    ]);
    const parCp = {}; (stats || []).forEach(s => { parCp[s.code_postal] = s; });
    const tot = { actives: 0, archivees: 0, clients: 0, oppositions: 0, effectif_inconnu: 0, nouvelles: 0 };
    const parSect = {};
    cps.forEach(cp => {
      const s = parCp[cp.code_postal] || {};
      const ps = parSect[cp.secteur_code] ||= { actives: 0, archivees: 0, clients: 0, oppositions: 0, effectif_inconnu: 0, nouvelles: 0, cps: [] };
      ["actives", "archivees", "clients", "oppositions", "effectif_inconnu", "nouvelles"].forEach(k => { ps[k] += n(s[k]); tot[k] += n(s[k]); });
      ps.cps.push(Object.assign({ ville: cp.ville, code_postal: cp.code_postal }, s));
    });
    const card = (v, l) => `<div class="pilot-card"><div class="pilot-card__val">${v}</div><div class="pilot-card__lbl">${esc(l)}</div></div>`;
    $("#baseCards", el).innerHTML = card(tot.actives, "Établissements actifs") + card(tot.nouvelles, "Nouveaux cette semaine")
      + card(tot.clients, "Clients (exclus)") + card(tot.oppositions, "Oppositions (exclues)") + card(tot.archivees, "Archivés");
    if (!tot.actives && !tot.archivees) {
      $("#baseTables", el).innerHTML = `<p class="cmd-empty">La base est vide : lancez un import depuis l'onglet « Imports ».</p>`;
      return;
    }
    $("#baseTables", el).innerHTML = secteurs.map(sec => {
      const ps = parSect[sec.code]; if (!ps) return "";
      const rows = ps.cps.map(c => `<tr><td>${esc(c.code_postal)}</td><td>${esc(c.ville)}</td>
        <td class="num">${n(c.actives)}</td><td class="num">${n(c.nouvelles)}</td><td class="num">${n(c.clients)}</td><td class="num">${n(c.effectif_inconnu)}</td><td class="num">${n(c.archivees)}</td></tr>`).join("");
      return `<h4>${esc(sec.nom)} (${esc(sec.code)}) · ${sec.commercial_id ? esc(C().nomDe(sec.commercial_id)) : "secteur libre"} · <b>${ps.actives}</b> actives</h4>
        <div class="tbl-scroll"><table class="grid"><thead><tr><th>CP</th><th>Ville</th><th class="num">Actives</th><th class="num">Nouvelles</th><th class="num">Clients</th><th class="num">Effectif inconnu</th><th class="num">Archivées</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="2">Total ${esc(sec.nom)}</td><td class="num">${ps.actives}</td><td class="num">${ps.nouvelles}</td><td class="num">${ps.clients}</td><td class="num">${ps.effectif_inconnu}</td><td class="num">${ps.archivees}</td></tr></tbody></table></div>`;
    }).join("");
  }

  /* ============================================================
     Onglet « Secteurs » : réaffectation des secteurs et codes postaux
     ============================================================ */
  async function renderSecteurs(el) {
    el.innerHTML = `
      <div class="cmd-card">
        <h3>Secteurs</h3>
        <p class="muted">Chaque secteur est affecté à un commercial membre du commando, ou laissé libre (distribué par vous). Le code « NO » est provisoire et peut être renommé.</p>
        <div id="sectErr"></div>
        <div class="tbl-scroll"><table class="grid"><thead><tr><th>Code</th><th>Nom</th><th>Commercial</th><th class="num">Codes postaux</th><th></th></tr></thead><tbody id="sectBody"></tbody></table></div>
        <div class="cmd-row"><button id="sectAdd" class="btn btn--sm">＋ Ajouter un secteur</button></div>
      </div>
      <div class="cmd-card">
        <h3>Codes postaux</h3>
        <p class="muted">Un changement de secteur est enregistré immédiatement. Le filtre d'import repose sur cette liste (pas sur le département : 37160 Buxeuil en fait partie).</p>
        <div class="cmd-row"><input id="cpSearch" class="admin-search grow" type="search" placeholder="Rechercher une ville ou un code postal…" autocomplete="off" /></div>
        <div class="tbl-scroll"><table class="grid"><thead><tr><th>Code postal</th><th>Ville</th><th>Secteur</th><th></th></tr></thead><tbody id="cpBody"></tbody></table></div>
        <div class="cmd-row">
          <input id="cpNew" type="text" placeholder="Code postal" maxlength="5" class="admin-search" style="max-width:130px" />
          <input id="cpNewVille" type="text" placeholder="Ville" class="admin-search grow" />
          <select id="cpNewSect" class="admin-search" style="max-width:200px"></select>
          <button id="cpAdd" class="btn btn--sm">＋ Ajouter</button>
        </div>
      </div>`;
    $("#cpSearch", el).addEventListener("input", () => renderCpRows(el));
    $("#sectAdd", el).addEventListener("click", () => ajouterSecteur(el));
    $("#cpAdd", el).addEventListener("click", () => ajouterCp(el));
  }
  let secteurs = [], codesPostaux = [], membres = [];
  async function chargerReferentiel() {
    const [s, c, m] = await Promise.all([
      sb().from("commando_secteurs").select("*").order("ordre").then(r => r.data || []),
      sb().from("commando_codes_postaux").select("*").order("code_postal").then(r => r.data || []),
      sb().from("commando_membres").select("*").then(r => r.data || [])
    ]);
    secteurs = s; codesPostaux = c; membres = m;
  }
  function optionsCommerciaux(selected) {
    const coms = membres.filter(m => m.role === "commercial").map(m => m.user_id);
    const me = C().me().id; if (!coms.includes(me)) coms.push(me);
    return `<option value="">— Secteur libre —</option>` + coms.map(id =>
      `<option value="${id}" ${id === selected ? "selected" : ""}>${esc(C().nomDe(id))}</option>`).join("");
  }
  function optionsSecteurs(selected) {
    return secteurs.map(s => `<option value="${esc(s.code)}" ${s.code === selected ? "selected" : ""}>${esc(s.nom)} (${esc(s.code)})</option>`).join("");
  }
  async function showSecteurs(el) {
    await chargerReferentiel();
    const nbCp = {}; codesPostaux.forEach(c => { nbCp[c.secteur_code] = (nbCp[c.secteur_code] || 0) + 1; });
    $("#sectBody", el).innerHTML = secteurs.map(s => `<tr data-code="${esc(s.code)}">
      <td style="width:90px"><input type="text" data-f="code" value="${esc(s.code)}" maxlength="6" /></td>
      <td><input type="text" data-f="nom" value="${esc(s.nom)}" /></td>
      <td><select data-f="commercial_id">${optionsCommerciaux(s.commercial_id)}</select></td>
      <td class="num">${nbCp[s.code] || 0}</td>
      <td><div class="admin-actions"><button class="btn btn--ghost btn--sm" data-save>Enregistrer</button>${(nbCp[s.code] || 0) ? "" : `<button class="btn btn--danger btn--sm" data-del>Supprimer</button>`}</div></td>
    </tr>`).join("");
    $$("#sectBody tr", el).forEach(tr => {
      $("[data-save]", tr).addEventListener("click", () => enregistrerSecteur(el, tr));
      const del = $("[data-del]", tr); if (del) del.addEventListener("click", () => supprimerSecteur(el, tr.dataset.code));
    });
    $("#cpNewSect", el).innerHTML = optionsSecteurs();
    renderCpRows(el);
  }
  function renderCpRows(el) {
    const q = ($("#cpSearch", el).value || "").toLowerCase();
    const rows = codesPostaux.filter(c => !q || c.code_postal.includes(q) || (c.ville || "").toLowerCase().includes(q));
    $("#cpBody", el).innerHTML = rows.map(c => `<tr data-cp="${esc(c.code_postal)}">
      <td style="width:110px"><b>${esc(c.code_postal)}</b></td><td>${esc(c.ville)}</td>
      <td style="width:220px"><select data-f="secteur_code">${optionsSecteurs(c.secteur_code)}</select></td>
      <td style="width:60px"><button class="btn btn--danger btn--sm" data-del title="Retirer de la liste">✕</button></td></tr>`).join("");
    $$("#cpBody tr", el).forEach(tr => {
      $("select", tr).addEventListener("change", async (e) => {
        const { error } = await sb().from("commando_codes_postaux").update({ secteur_code: e.target.value }).eq("code_postal", tr.dataset.cp);
        if (error) { C().toast("Échec : " + error.message); return; }
        const c = codesPostaux.find(x => x.code_postal === tr.dataset.cp); if (c) c.secteur_code = e.target.value;
        C().toast("Code postal réaffecté");
      });
      $("[data-del]", tr).addEventListener("click", async () => {
        if (!confirm(`Retirer ${tr.dataset.cp} de la liste du commando ?\nLes entreprises déjà importées restent en base mais ne seront plus mises à jour.`)) return;
        const { error } = await sb().from("commando_codes_postaux").delete().eq("code_postal", tr.dataset.cp);
        if (error) { C().toast("Échec : " + error.message); return; }
        await showSecteurs(el); C().toast("Code postal retiré");
      });
    });
  }
  async function enregistrerSecteur(el, tr) {
    const ancien = tr.dataset.code;
    const code = $('[data-f="code"]', tr).value.trim().toUpperCase();
    const nom = $('[data-f="nom"]', tr).value.trim();
    const commercial_id = $('[data-f="commercial_id"]', tr).value || null;
    if (!code || !nom) { C().toast("Code et nom obligatoires"); return; }
    const { error } = await sb().from("commando_secteurs").update({ code, nom, commercial_id }).eq("code", ancien);
    if (error) { $("#sectErr", el).innerHTML = `<div class="cmd-err">${esc(error.message)}</div>`; return; }
    $("#sectErr", el).innerHTML = "";
    await showSecteurs(el); C().toast("Secteur enregistré");
  }
  async function ajouterSecteur(el) {
    const code = prompt("Code du nouveau secteur (ex. 66) :"); if (!code) return;
    const nom = prompt("Nom du secteur :"); if (!nom) return;
    const { error } = await sb().from("commando_secteurs").insert({ code: code.trim().toUpperCase(), nom: nom.trim(), ordre: secteurs.length + 1 });
    if (error) { C().toast("Échec : " + error.message); return; }
    await showSecteurs(el); C().toast("Secteur ajouté");
  }
  async function supprimerSecteur(el, code) {
    if (!confirm(`Supprimer le secteur ${code} ?`)) return;
    const { error } = await sb().from("commando_secteurs").delete().eq("code", code);
    if (error) { C().toast("Échec : " + error.message); return; }
    await showSecteurs(el); C().toast("Secteur supprimé");
  }
  async function ajouterCp(el) {
    const code_postal = $("#cpNew", el).value.trim(), ville = $("#cpNewVille", el).value.trim(), secteur_code = $("#cpNewSect", el).value;
    if (!/^\d{5}$/.test(code_postal) || !ville) { C().toast("Code postal (5 chiffres) et ville obligatoires"); return; }
    const { error } = await sb().from("commando_codes_postaux").insert({ code_postal, ville, secteur_code });
    if (error) { C().toast("Échec : " + error.message); return; }
    $("#cpNew", el).value = ""; $("#cpNewVille", el).value = "";
    await showSecteurs(el); C().toast("Code postal ajouté (pris en compte au prochain import)");
  }

  /* ============================================================
     Onglet « Membres »
     ============================================================ */
  async function renderMembres(el) {
    el.innerHTML = `<div class="cmd-card">
      <h3>Membres du commando</h3>
      <p class="muted">Seules les personnes listées ici voient l'onglet Rex Commando. Le rôle « responsable » donne accès à la console et au lancement de la veille.</p>
      <div class="tbl-scroll"><table class="grid"><thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th></th></tr></thead><tbody id="membBody"></tbody></table></div>
      <h4>Ajouter une personne</h4>
      <div class="cmd-row">
        <select id="membNew" class="admin-search grow"></select>
        <select id="membNewRole" class="admin-search" style="max-width:180px"><option value="commercial">Commercial</option><option value="responsable">Responsable</option></select>
        <button id="membAdd" class="btn btn--primary btn--sm">Ajouter</button>
      </div>
    </div>`;
    $("#membAdd", el).addEventListener("click", async () => {
      const user_id = $("#membNew", el).value, role = $("#membNewRole", el).value;
      if (!user_id) return;
      const { error } = await sb().from("commando_membres").insert({ user_id, role });
      if (error) { C().toast("Échec : " + error.message); return; }
      await showMembres(el); C().toast("Membre ajouté");
    });
  }
  async function showMembres(el) {
    try { await window.RexDB.reloadTeam(); } catch (e) { /* on garde la liste connue */ }
    const { data } = await sb().from("commando_membres").select("*").order("role");
    membres = data || [];
    const me = C().me().id;
    $("#membBody", el).innerHTML = membres.map(m => {
      const p = (window.RexDB.profiles() || []).find(x => x.id === m.user_id) || {};
      return `<tr data-id="${m.user_id}"><td>${esc(p.full_name || "—")}</td><td>${esc(p.email || m.user_id)}</td>
        <td><select data-role ${m.user_id === me ? "disabled" : ""}><option value="commercial" ${m.role === "commercial" ? "selected" : ""}>Commercial</option><option value="responsable" ${m.role === "responsable" ? "selected" : ""}>Responsable</option></select></td>
        <td>${m.user_id === me ? `<span class="muted">vous</span>` : `<button class="btn btn--danger btn--sm" data-del>Retirer</button>`}</td></tr>`;
    }).join("");
    $$("#membBody tr", el).forEach(tr => {
      $("[data-role]", tr).addEventListener("change", async (e) => {
        const { error } = await sb().from("commando_membres").update({ role: e.target.value }).eq("user_id", tr.dataset.id);
        C().toast(error ? "Échec : " + error.message : "Rôle mis à jour");
      });
      const del = $("[data-del]", tr);
      if (del) del.addEventListener("click", async () => {
        if (!confirm("Retirer cette personne du commando ? Ses appels enregistrés sont conservés.")) return;
        const { error } = await sb().from("commando_membres").delete().eq("user_id", tr.dataset.id);
        if (error) { C().toast("Échec : " + error.message); return; }
        await showMembres(el); C().toast("Membre retiré");
      });
    });
    const dejà = new Set(membres.map(m => m.user_id));
    const candidats = (window.RexDB.profiles() || []).filter(p => !dejà.has(p.id)).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
    $("#membNew", el).innerHTML = `<option value="">— Choisir une personne —</option>` + candidats.map(p =>
      `<option value="${p.id}">${esc(p.full_name || p.email)}${p.agence ? " · " + esc(p.agence) : ""}</option>`).join("");
  }

  /* ============================================================
     Onglet « Imports » : lancement, rapports, liste clients
     ============================================================ */
  async function renderImports(el) {
    el.innerHTML = `
      <div class="cmd-card">
        <h3>Mise à jour de la base</h3>
        <p class="muted">Le job automatique tourne chaque dimanche soir. Vous pouvez aussi lancer un import à la main. Relancer un import ne crée jamais de doublon ; les établissements disparus sont archivés, jamais supprimés.</p>
        <div id="impMsg"></div>
        <div class="cmd-row">
          <button id="impTest" class="btn btn--sm">🔎 Tester sur 86000 (sans écriture)</button>
          <button id="imp86000" class="btn btn--sm">Importer 86000 seulement</button>
          <button id="impFull" class="btn btn--primary btn--sm">⬇️ Lancer l'import complet (51 codes postaux)</button>
          <button id="impRefresh" class="btn btn--ghost btn--sm">↻ Actualiser</button>
        </div>
        <div id="impRapport" class="import-detail"></div>
      </div>
      <div class="cmd-card cmd-imports">
        <h3>Historique des imports</h3>
        <div id="impList"></div>
      </div>
      <div class="cmd-card">
        <h3>Liste des clients (SIREN)</h3>
        <p class="muted">Collez une liste de numéros SIREN (9 chiffres, un par ligne ou séparés par des virgules), ou chargez un fichier texte/CSV. Les clients restent en base mais sont exclus des listes d'appel.</p>
        <div class="cmd-row"><textarea id="cliText" class="output-text grow" rows="4" placeholder="123456789&#10;987654321"></textarea></div>
        <div class="cmd-row">
          <input type="file" id="cliFile" accept=".csv,.txt,text/plain,text/csv" />
          <button id="cliApply" class="btn btn--primary btn--sm">Enregistrer la liste et marquer les clients</button>
          <span id="cliCount" class="muted"></span>
        </div>
        <div id="cliMsg"></div>
      </div>`;
    $("#impTest", el).addEventListener("click", () => lancerImport(el, { codes_postaux: ["86000"], dry_run: true }, "Test sur 86000 en cours…"));
    $("#imp86000", el).addEventListener("click", () => {
      if (!confirm("Importer les établissements de 86000 (Poitiers) dans la base ?")) return;
      lancerImport(el, { codes_postaux: ["86000"] }, "Import de 86000 en cours…");
    });
    $("#impFull", el).addEventListener("click", () => {
      if (!confirm("Lancer l'import complet des 51 codes postaux ? Cela prend 1 à 3 minutes ; la page peut rester ouverte ou non.")) return;
      lancerImport(el, {}, "Import complet lancé en arrière-plan…");
    });
    $("#impRefresh", el).addEventListener("click", () => showImports(el));
    $("#cliFile", el).addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader(); r.onload = () => { $("#cliText", el).value = String(r.result || ""); compterSiren(el); }; r.readAsText(f);
    });
    $("#cliText", el).addEventListener("input", () => compterSiren(el));
    $("#cliApply", el).addEventListener("click", () => appliquerClients(el));
  }
  function extraireSiren(txt) {
    const set = new Set();
    (txt.match(/\d[\d\s]{7,}\d/g) || []).forEach(m => { const d = m.replace(/\s+/g, ""); if (d.length === 9) set.add(d); else if (d.length === 14) set.add(d.slice(0, 9)); });
    return Array.from(set);
  }
  function compterSiren(el) { $("#cliCount", el).textContent = extraireSiren($("#cliText", el).value).length + " SIREN détectés"; }
  async function appliquerClients(el) {
    const sirens = extraireSiren($("#cliText", el).value);
    if (!sirens.length) { C().toast("Aucun SIREN détecté"); return; }
    if (!confirm(`Enregistrer ${sirens.length} SIREN clients et marquer les entreprises correspondantes ?`)) return;
    const msg = $("#cliMsg", el);
    try {
      const me = C().me().id;
      for (let i = 0; i < sirens.length; i += 500) {
        const { error } = await sb().from("commando_clients_siren").upsert(sirens.slice(i, i + 500).map(s => ({ siren: s, importe_par: me })), { onConflict: "siren" });
        if (error) throw error;
      }
      const res = await C().rpc("commando_appliquer_clients");
      msg.innerHTML = `<div class="cmd-ok">Liste enregistrée : ${sirens.length} SIREN. Entreprises marquées client : ${n(res.marquees_client)} ; retirées : ${n(res.retirees_client)}.</div>`;
    } catch (e) { msg.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`; }
  }
  async function lancerImport(el, payload, libelle) {
    const msg = $("#impMsg", el);
    msg.innerHTML = `<div class="cmd-note"><span class="cmd-spin"></span>${esc(libelle)}</div>`;
    $$("#impTest,#imp86000,#impFull", el).forEach(b => b.disabled = true);
    try {
      const res = await C().fn("commando-import", payload);
      if (res.statut === "en_cours") {
        msg.innerHTML = `<div class="cmd-note"><span class="cmd-spin"></span>Import en cours en arrière-plan. Le rapport apparaîtra ci-dessous.</div>`;
      } else {
        msg.innerHTML = res.erreur ? `<div class="cmd-err">Import terminé avec une erreur : ${esc(res.erreur)}</div>` : `<div class="cmd-ok">Import terminé.</div>`;
        $("#impRapport", el).innerHTML = rapportHtml(res);
      }
    } catch (e) {
      msg.innerHTML = `<div class="cmd-err">${esc(C().erreur(e))}</div>`;
    } finally {
      $$("#impTest,#imp86000,#impFull", el).forEach(b => b.disabled = false);
      showImports(el);
    }
  }
  function rapportHtml(imp) {
    const c = imp.compteurs || {}; const t = c.total || {};
    const card = (v, l) => `<div class="pilot-card"><div class="pilot-card__val">${v}</div><div class="pilot-card__lbl">${esc(l)}</div></div>`;
    const excl = Object.entries(t.exclues || {}).map(([k, v]) => `${EXCLUSIONS[k] || k} : <b>${v}</b>`).join(" · ") || "aucune";
    const sect = Object.entries(c.par_secteur || {}).map(([code, s]) =>
      `<tr><td><b>${esc(code)}</b></td><td class="num">${n(s.vues)}</td><td class="num">${n(s.importees)}</td><td class="num">${n(s.ajoutees)}</td><td class="num">${n(s.reactivees)}</td><td class="num">${n(s.mises_a_jour)}</td><td class="num">${n(s.archivees)}</td><td class="num">${n(s.clients)}</td><td class="num">${n(s.effectif_non_renseigne)}</td><td>${esc(Object.entries(s.exclues || {}).map(([k, v]) => `${EXCLUSIONS[k] || k} ${v}`).join(", "))}</td></tr>`).join("");
    const anomalies = (imp.anomalies || []).length
      ? `<h4>Anomalies (${imp.anomalies.length})</h4><div class="tbl-scroll"><table class="grid"><thead><tr><th>Type</th><th>SIRET</th><th>Code postal</th><th>Raison sociale</th></tr></thead><tbody>${imp.anomalies.slice(0, 100).map(a => `<tr><td>${esc(a.type)}</td><td>${esc(a.siret)}</td><td>${esc(a.code_postal)}</td><td>${esc(a.raison_sociale)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">Aucune anomalie (tous les établissements renvoyés sont dans la liste des codes postaux).</p>`;
    return `<div class="cmd-cards">${card(n(t.vues), "Établissements vus")}${card(n(t.importees), imp.dry_run ? "Retenus (non écrits)" : "Retenus")}${card(n(t.ajoutees), "Ajoutés")}${card(n(t.archivees), "Archivés")}${card(n(c.unites_legales), "Unités légales")}${card(n(c.requetes), "Requêtes API")}</div>
      <p class="muted">Exclusions : ${excl}. Semaine cible : ${esc(c.semaine_cible || "")}. Durée : ${Math.round(n(c.duree_ms) / 1000)} s.${imp.initial ? " Import initial : aucune entreprise n'est marquée « nouvelle »." : ""}</p>
      <div class="tbl-scroll"><table class="grid"><thead><tr><th>Secteur</th><th class="num">Vus</th><th class="num">Retenus</th><th class="num">Ajoutés</th><th class="num">Réactivés</th><th class="num">Mis à jour</th><th class="num">Archivés</th><th class="num">Clients</th><th class="num">Eff. inconnu</th><th>Exclusions</th></tr></thead><tbody>${sect}</tbody></table></div>
      ${anomalies}${imp.erreur ? `<div class="cmd-err">${esc(imp.erreur)}</div>` : ""}`;
  }
  async function showImports(el) {
    const { data } = await sb().from("commando_imports").select("*").order("lance_le", { ascending: false }).limit(15);
    const list = data || [];
    const wrap = $("#impList", el);
    if (!list.length) { wrap.innerHTML = `<p class="cmd-empty">Aucun import pour le moment.</p>`; return; }
    wrap.innerHTML = list.map(i => {
      const t = (i.compteurs || {}).total || {};
      const badge = i.statut === "en_cours" ? `<span class="cmd-badge cmd-badge--info"><span class="cmd-spin"></span>en cours</span>`
        : i.statut === "erreur" ? `<span class="cmd-badge cmd-badge--err">erreur</span>` : `<span class="cmd-badge cmd-badge--ok">terminé</span>`;
      return `<div class="import-line" data-id="${i.id}">
        <span class="import-line__when">${esc(C().fmtDateTime(i.lance_le))}</span>
        ${badge}<span class="cmd-badge">${i.declencheur === "cron" ? "automatique" : "manuel"}</span>${i.dry_run ? `<span class="cmd-badge cmd-badge--warn">test</span>` : ""}
        <span class="import-line__sum">${(i.codes_postaux || []).length} CP · vus ${n(t.vues)} · ajoutés ${n(t.ajoutees)} · archivés ${n(t.archivees)}${i.erreur ? " · " + esc(i.erreur) : ""}</span>
        <button class="btn btn--ghost btn--sm" data-detail>Détail</button>
      </div><div class="import-detail" data-detail-for="${i.id}" hidden></div>`;
    }).join("");
    $$("[data-detail]", wrap).forEach(b => b.addEventListener("click", () => {
      const id = b.closest(".import-line").dataset.id;
      const box = $(`[data-detail-for="${id}"]`, wrap);
      if (!box.hidden) { box.hidden = true; return; }
      box.innerHTML = rapportHtml(list.find(x => x.id === id)); box.hidden = false;
    }));
    // Tant qu'un import tourne, on rafraîchit toutes les 5 s.
    if (list.some(i => i.statut === "en_cours")) C().poll(() => showImports(el), 5000); else C().stopPoll();
  }

  /* ============================================================
     Onglet « Paramètres »
     ============================================================ */
  async function renderParametres(el) {
    el.innerHTML = `<div class="cmd-card">
      <h3>Paramètres du commando</h3>
      <p class="muted">Ces réglages s'appliquent à l'import hebdomadaire, aux listes et à la veille IA. Les changements de tranches prennent effet au prochain import.</p>
      <div id="parMsg"></div>
      <form id="parForm" class="cmd-form" autocomplete="off">
        <label class="wide">Tranches d'effectif importées
          <div class="cmd-checks">${Object.entries(TRANCHES).map(([k, v]) => `<label><input type="checkbox" name="tranche" value="${k}" /> ${k} (${v} salariés)</label>`).join("")}
          <label><input type="checkbox" name="inclure_effectif_inconnu" /> inclure les établissements sans effectif renseigné</label></div>
        </label>
        <label>Ancienneté « moins de … ans »<input type="number" name="b_moins" min="1" max="20" /></label>
        <label>Ancienneté « plus de … ans »<input type="number" name="b_plus" min="1" max="50" /></label>
        <label>Délai de rappel après un refus (semaines)<input type="number" name="delai_rappel_refus_semaines" min="1" max="52" /></label>
        <label>Délai de rappel après un injoignable (semaines)<input type="number" name="delai_rappel_injoignable_semaines" min="1" max="52" /></label>
        <label>Objectif de RDV par commercial et par semaine<input type="number" name="objectif_rdv_semaine" min="1" max="50" /></label>
        <label>Seuil d'échantillon (appels) pour un taux fiable<input type="number" name="seuil_echantillon" min="5" max="500" /></label>
        <label>Secteur libre visible par<select name="secteur_libre_visible_par"><option value="responsable">le responsable seulement</option><option value="equipe">toute l'équipe</option></select></label>
        <label>Limite de générations IA par semaine<input type="number" name="limite_generations_semaine" min="1" max="50" /></label>
        <label>Modèle Claude<input type="text" name="modele" /></label>
        <label>Site public Rex-Rotary<input type="url" name="site_rex" /></label>
        <div class="wide"><b>Familles de métiers pour la veille</b> <span class="muted">— « privilégier » : la majorité des propositions s'y rattachent ; « exclure » : aucune proposition.</span>
          <div class="cmd-checks" id="famillesChamps">${Object.entries(FAMILLES).map(([k, v]) => `<label>${esc(v)} <select name="famille_${k}"><option value="neutre">neutre</option><option value="privilegier">privilégier</option><option value="exclure">exclure</option></select></label>`).join("")}</div></div>
        <div class="wide"><b>Jeux du commando</b> <span class="muted">— récompenses en fiches du secteur libre, jamais en argent. Un RDV annulé reprend sa récompense.</span>
          <div class="cmd-checks">
            <label><input type="checkbox" name="jeu_premier_rdv" /> Premier RDV de l'heure (et 1 fiche par RDV suivant)</label>
            <label><input type="checkbox" name="jeu_pronostic" /> Pronostic du créneau (fiche mystère)</label>
            <label><input type="checkbox" name="jeu_ligue" /> Ligue et badges (le Fidèle reçoit ses fiches à la publication)</label>
          </div></div>
        <label>Fiches pour le premier RDV de l'heure<input type="number" name="jeu_fiches_premier_rdv" min="1" max="20" /></label>
        <label>Fiches par RDV suivant<input type="number" name="jeu_fiches_rdv" min="0" max="5" /></label>
        <label>Fiches du Fidèle (à la publication)<input type="number" name="jeu_fiches_fidele" min="0" max="30" /></label>
        <label>Plafond de fiches par commercial et par semaine<input type="number" name="jeu_max_fiches_semaine" min="1" max="100" /></label>
        <label>Fenêtre du Fidèle (semaines de RDV validés)<input type="number" name="jeu_semaines_fidele" min="1" max="12" /></label>
        <label>Délai pour pronostiquer (minutes après le début du créneau)<input type="number" name="jeu_delai_pronostic_min" min="1" max="60" /></label>
        <label class="wide">Concurrents à surveiller (un par ligne)<textarea name="concurrents" rows="4"></textarea></label>
        <label class="wide">Consignes commerciales (injectées dans chaque veille)<textarea name="consignes" rows="6"></textarea></label>
        <label class="wide">Fiche Rex-Rotary validée (offres, services, offre d'entrée) <span id="ficheEtat" class="muted"></span><textarea name="fiche_rex" rows="10" placeholder="Rédigée par la veille au premier lancement, puis corrigée et validée ici."></textarea></label>
        <div class="wide cmd-row">
          <button type="submit" class="btn btn--primary">Enregistrer les paramètres</button>
          <button type="button" id="ficheValider" class="btn">✔︎ Valider la fiche Rex telle qu'affichée</button>
        </div>
      </form>
    </div>`;
    $("#parForm", el).addEventListener("submit", (e) => { e.preventDefault(); enregistrerParametres(el, false); });
    $("#ficheValider", el).addEventListener("click", () => enregistrerParametres(el, true));
  }
  async function showParametres(el) {
    const { data: p, error } = await sb().from("commando_parametres").select("*").eq("id", true).single();
    if (error || !p) { $("#parMsg", el).innerHTML = `<div class="cmd-err">Paramètres introuvables.</div>`; return; }
    const f = $("#parForm", el);
    $$('input[name="tranche"]', f).forEach(cb => cb.checked = (p.tranches_incluses || []).includes(cb.value));
    f.inclure_effectif_inconnu.checked = !!p.inclure_effectif_inconnu;
    f.b_moins.value = (p.bornes_anciennete || {}).moins_3 ?? 3;
    f.b_plus.value = (p.bornes_anciennete || {}).plus_5 ?? 5;
    ["delai_rappel_refus_semaines", "delai_rappel_injoignable_semaines", "objectif_rdv_semaine", "seuil_echantillon", "limite_generations_semaine", "modele", "site_rex", "secteur_libre_visible_par", "consignes"].forEach(k => { f[k].value = p[k] ?? ""; });
    f.concurrents.value = (p.concurrents || []).join("\n");
    Object.keys(FAMILLES).forEach(k => { f["famille_" + k].value = (p.familles || {})[k] || "neutre"; });
    const jx = p.jeux || {};
    f.jeu_premier_rdv.checked = jx.premier_rdv !== false; f.jeu_pronostic.checked = jx.pronostic !== false; f.jeu_ligue.checked = jx.ligue !== false;
    f.jeu_fiches_premier_rdv.value = jx.fiches_premier_rdv ?? 5; f.jeu_fiches_rdv.value = jx.fiches_rdv ?? 1; f.jeu_fiches_fidele.value = jx.fiches_fidele ?? 10;
    f.jeu_max_fiches_semaine.value = jx.max_fiches_semaine ?? 15; f.jeu_semaines_fidele.value = jx.semaines_fidele ?? 4; f.jeu_delai_pronostic_min.value = jx.delai_pronostic_min ?? 20;
    f.fiche_rex.value = p.fiche_rex || p.fiche_rex_brouillon || "";
    $("#ficheEtat", el).textContent = p.fiche_rex_validee_le ? `(validée le ${C().fmtDateTime(p.fiche_rex_validee_le)})` : (p.fiche_rex_brouillon ? "(brouillon de la veille, non validé)" : "(non renseignée)");
  }
  async function enregistrerParametres(el, validerFiche) {
    const f = $("#parForm", el);
    const patch = {
      tranches_incluses: $$('input[name="tranche"]:checked', f).map(cb => cb.value),
      inclure_effectif_inconnu: f.inclure_effectif_inconnu.checked,
      bornes_anciennete: { moins_3: Number(f.b_moins.value) || 3, plus_5: Number(f.b_plus.value) || 5 },
      delai_rappel_refus_semaines: Number(f.delai_rappel_refus_semaines.value) || 8,
      delai_rappel_injoignable_semaines: Number(f.delai_rappel_injoignable_semaines.value) || 2,
      objectif_rdv_semaine: Number(f.objectif_rdv_semaine.value) || 5,
      seuil_echantillon: Number(f.seuil_echantillon.value) || 30,
      limite_generations_semaine: Number(f.limite_generations_semaine.value) || 5,
      modele: f.modele.value.trim() || "claude-sonnet-5-5",
      site_rex: f.site_rex.value.trim(),
      secteur_libre_visible_par: f.secteur_libre_visible_par.value,
      concurrents: f.concurrents.value.split(/\n/).map(s => s.trim()).filter(Boolean),
      familles: Object.fromEntries(Object.keys(FAMILLES).map(k => [k, f["famille_" + k].value])),
      jeux: {
        premier_rdv: f.jeu_premier_rdv.checked, pronostic: f.jeu_pronostic.checked, ligue: f.jeu_ligue.checked,
        fiches_premier_rdv: Number(f.jeu_fiches_premier_rdv.value) || 5, fiches_rdv: Number(f.jeu_fiches_rdv.value) || 0,
        fiches_fidele: Number(f.jeu_fiches_fidele.value) || 0, max_fiches_semaine: Number(f.jeu_max_fiches_semaine.value) || 15,
        semaines_fidele: Number(f.jeu_semaines_fidele.value) || 4, delai_pronostic_min: Number(f.jeu_delai_pronostic_min.value) || 20,
      },
      consignes: f.consignes.value,
      updated_by: C().me().id
    };
    if (patch.bornes_anciennete.moins_3 >= patch.bornes_anciennete.plus_5) { C().toast("Les bornes d'ancienneté doivent être croissantes"); return; }
    if (!patch.tranches_incluses.length) { C().toast("Choisissez au moins une tranche"); return; }
    if (validerFiche) {
      if (!f.fiche_rex.value.trim()) { C().toast("La fiche est vide"); return; }
      patch.fiche_rex = f.fiche_rex.value.trim();
      patch.fiche_rex_validee_le = new Date().toISOString();
    }
    const { error } = await sb().from("commando_parametres").update(patch).eq("id", true);
    if (error) { $("#parMsg", el).innerHTML = `<div class="cmd-err">${esc(error.message)}</div>`; return; }
    $("#parMsg", el).innerHTML = "";
    C().toast(validerFiche ? "Fiche Rex validée et paramètres enregistrés" : "Paramètres enregistrés");
    showParametres(el);
  }

  /* ---------- Enregistrement des onglets (responsable) ---------- */
  const R = ["responsable"];
  C().registerTab({ id: "base", label: "📚 Base", roles: R, render: renderBase, onShow: showBase });
  C().registerTab({ id: "secteurs", label: "🗺️ Secteurs", roles: R, render: renderSecteurs, onShow: showSecteurs });
  C().registerTab({ id: "membres", label: "👥 Membres", roles: R, render: renderMembres, onShow: showMembres });
  C().registerTab({ id: "imports", label: "⬇️ Imports", roles: R, render: renderImports, onShow: showImports });
  C().registerTab({ id: "parametres", label: "⚙️ Paramètres", roles: R, render: renderParametres, onShow: showParametres });
})();
