/* ============================================================
   Rex Seller — logique applicative (vanilla JS, sans dépendance)
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const rnd = Math.random() * 16 | 0, v = c === "x" ? rnd : (rnd & 0x3 | 0x8); return v.toString(16);
      });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* ----------------------- État & stockage (Supabase) ----------------------- */
  // Les données sont fournies par la couche d'authentification (supa.js) via boot().
  let store = [];
  let currentId = null;
  let ownerFilter = "all";        // filtre « propriétaire » (utile aux responsables)

  function myId() { const me = window.RexDB.me(); return me ? me.id : null; }
  function newRdv() {
    return { id: uid(), author_id: myId(), createdAt: Date.now(), updatedAt: Date.now(), data: {}, affaire: { active: false, data: {} } };
  }
  function current() { return store.find(r => r.id === currentId); }
  function ownedByMe(r) { return !!r && r.author_id === myId(); }
  function isReadOnly() { return !ownedByMe(current()); }

  // Enregistrement d'un RDV en base (création ou mise à jour).
  async function saveRdv(r) {
    if (!r) return;
    try { await window.RexDB.upsertRdv(r); }
    catch (e) { setSaveStatus("error"); toast("Échec de l'enregistrement : " + (e.message || e)); throw e; }
  }

  let saveTimer = null;
  function touch() {
    const r = current(); if (!r || isReadOnly()) return;
    r.updatedAt = Date.now();
    setSaveStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveRdv(r).then(() => setSaveStatus("saved")).catch(() => {});
    }, 400);
  }
  function setSaveStatus(state) {
    const el = $("#saveStatus");
    if (!el) return;
    if (isReadOnly()) { el.textContent = "Lecture seule"; el.classList.remove("saving"); el.classList.add("readonly"); return; }
    el.classList.remove("readonly");
    if (state === "saving") { el.textContent = "Enregistrement…"; el.classList.add("saving"); }
    else if (state === "error") { el.textContent = "Non enregistré ✕"; el.classList.remove("saving"); }
    else { el.textContent = "Enregistré ✓"; el.classList.remove("saving"); }
  }

  const val = (id) => { const r = current(); return r ? r.data[id] : undefined; };
  const setVal = (id, v) => { if (isReadOnly()) return; const r = current(); if (!r) return; r.data[id] = v; touch(); };

  /* ----------------------- Rendu du livret ----------------------- */
  function renderNav() {
    const nav = $("#sectionNav");
    nav.innerHTML = BOOKLET.map((sec, i) => {
      const filled = sectionFilled(sec);
      return `<button class="nav-chip ${i === 0 ? "active" : ""} ${filled ? "filled" : ""}" data-goto="${sec.id}" title="${esc(sec.title)}">
        <span class="dot"></span>
        <span class="nav-chip__icon">${sec.icon}</span>
        <span class="nav-chip__label">${esc(sec.short || sec.title)}</span>
      </button>`;
    }).join("");
    $$(".nav-chip", nav).forEach(chip => chip.addEventListener("click", () => {
      const id = chip.dataset.goto;
      const card = $(`#sec-${id}`);
      openSection(card, true);
      setActiveChip(id);
      const top = card.getBoundingClientRect().top + window.scrollY - stickyHeight() - 6;
      window.scrollTo({ top, behavior: "smooth" });
    }));
  }

  function stickyHeight() { const t = $(".topbar"); return t ? t.offsetHeight : 0; }
  function setActiveChip(id) {
    $$(".nav-chip").forEach(c => c.classList.toggle("active", c.dataset.goto === id));
  }
  // Surligne la section la plus proche du haut pendant le défilement.
  function trackActiveOnScroll() {
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => {
        const y = stickyHeight() + 12;
        let cur = BOOKLET[0].id;
        for (const sec of BOOKLET) {
          const card = $(`#sec-${sec.id}`);
          if (card && card.getBoundingClientRect().top <= y) cur = sec.id;
        }
        setActiveChip(cur);
        ticking = false;
      });
    }, { passive: true });
  }

  function sectionFilled(sec) {
    return sec.fields.some(f => isFilled(val(f.id)));
  }
  function isFilled(v) {
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.some(isFilled);
    if (typeof v === "object") return Object.values(v).some(isFilled);
    return true;
  }

  function renderBooklet() {
    const root = $("#booklet");
    root.innerHTML = BOOKLET.map((sec, i) => `
      <section class="section-card ${i === 0 ? "open" : ""}" id="sec-${sec.id}">
        <button class="section-head" data-toggle>
          <span class="section-head__icon">${sec.icon}</span>
          <span class="section-head__text">
            <span class="section-head__title">${esc(sec.title)}</span>
            <span class="section-head__meta" data-meta="${sec.id}"></span>
          </span>
          <span class="section-head__chev">▾</span>
        </button>
        <div class="section-body">
          ${sec.intro ? `<p class="section-intro">${esc(sec.intro)}</p>` : ""}
          ${sec.fields.map(f => renderField(f)).join("")}
        </div>
      </section>`).join("");

    $$("[data-toggle]", root).forEach(btn =>
      btn.addEventListener("click", () => openSection(btn.closest(".section-card"))));

    BOOKLET.forEach(sec => sec.fields.forEach(f => bindField(f)));
    updateAllMeta();
  }

  function openSection(card, forceOpen) {
    if (forceOpen) card.classList.add("open");
    else card.classList.toggle("open");
  }

  function renderField(f) {
    const label = `<label class="field__label" for="fld-${f.id}">${esc(f.label)}</label>` +
      (f.hint ? `<span class="field__hint">${esc(f.hint)}</span>` : "");
    let control = "";
    switch (f.type) {
      case "textarea":
        control = `<textarea id="fld-${f.id}" data-field="${f.id}"></textarea>`; break;
      case "number":
        control = `<input type="number" id="fld-${f.id}" data-field="${f.id}" inputmode="numeric" />`; break;
      case "date":
        control = `<input type="date" id="fld-${f.id}" data-field="${f.id}" />`; break;
      case "rating":
        control = `<div class="rating" data-field="${f.id}">${Array.from({ length: 10 }, (_, i) =>
          `<button type="button" data-r="${i + 1}">${i + 1}</button>`).join("")}</div>`; break;
      case "yesno":
        control = `<div class="yesno" data-field="${f.id}">
            <button type="button" data-v="Oui">Oui</button>
            <button type="button" data-v="Non">Non</button>
          </div>
          ${f.withDate ? `<div class="yesno-extra"><label class="mini-label">${esc(f.dateLabel || "Date")}</label><input type="date" data-extra="date"></div>` : ""}
          ${f.withPrecision ? `<div class="yesno-extra"><input type="text" placeholder="Précision" data-extra="precision"></div>` : ""}`; break;
      case "checklist":
        control = `<div class="checklist" data-field="${f.id}">${f.options.map((o, i) =>
          `<label><input type="checkbox" data-i="${i}"> <span>${esc(o)}</span></label>`).join("")}</div>`; break;
      case "table":
        control = renderTable(f); break;
      default:
        control = `<input type="text" id="fld-${f.id}" data-field="${f.id}" />`;
    }
    return `<div class="field">${label}${control}</div>`;
  }

  function renderTable(f) {
    const cols = f.cols;
    const header = f.columns
      ? `<tr><th>${esc(f.rowHeader || "")}</th>${f.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr>`
      : `<tr><th></th>${Array.from({ length: cols }, (_, c) => `<th>${esc((f.colLabel || "Col") + " " + (c + 1))}</th>`).join("")}</tr>`;
    const body = f.rows.map((rlabel, r) =>
      `<tr><td><span class="rowlabel">${esc(rlabel)}</span></td>${Array.from({ length: cols }, (_, c) =>
        `<td><input type="text" data-cell="${r}-${c}"></td>`).join("")}</tr>`).join("");
    return `<div class="tbl-scroll"><table class="grid" data-field="${f.id}"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
  }

  /* ----------------------- Liaison des champs ----------------------- */
  function bindField(f) {
    const stored = val(f.id);
    switch (f.type) {
      case "textarea": case "number": case "date": case "text": case undefined: {
        const el = $(`#fld-${f.id}`);
        if (!el) break;
        if (stored != null) el.value = stored;
        el.addEventListener("input", () => { setVal(f.id, el.value); onChange(f); });
        break;
      }
      case "rating": {
        const wrap = $(`.rating[data-field="${f.id}"]`);
        const paint = () => $$("button", wrap).forEach(b => b.classList.toggle("sel", String(stored) === b.dataset.r || (current().data[f.id] != null && b.dataset.r === String(current().data[f.id]))));
        $$("button", wrap).forEach(b => {
          if (String(stored) === b.dataset.r) b.classList.add("sel");
          b.addEventListener("click", () => {
            const v = current().data[f.id] === Number(b.dataset.r) ? null : Number(b.dataset.r);
            setVal(f.id, v);
            $$("button", wrap).forEach(x => x.classList.toggle("sel", v != null && x.dataset.r === String(v)));
            onChange(f);
          });
        });
        break;
      }
      case "yesno": {
        const wrap = $(`.yesno[data-field="${f.id}"]`);
        const obj = (stored && typeof stored === "object") ? stored : {};
        const paint = () => {
          const yes = $(`button[data-v="Oui"]`, wrap), no = $(`button[data-v="Non"]`, wrap);
          yes.classList.toggle("sel-yes", obj.v === "Oui");
          no.classList.toggle("sel-no", obj.v === "Non");
        };
        $$("button", wrap).forEach(b => b.addEventListener("click", () => {
          obj.v = obj.v === b.dataset.v ? null : b.dataset.v;
          setVal(f.id, obj); paint(); onChange(f);
        }));
        const extra = wrap.parentElement.querySelectorAll("[data-extra]");
        extra.forEach(inp => {
          const k = inp.dataset.extra;
          if (obj[k]) inp.value = obj[k];
          inp.addEventListener("input", () => { obj[k] = inp.value; setVal(f.id, obj); onChange(f); });
        });
        paint();
        break;
      }
      case "checklist": {
        const wrap = $(`.checklist[data-field="${f.id}"]`);
        const arr = Array.isArray(stored) ? stored : [];
        $$("input", wrap).forEach(cb => {
          const i = Number(cb.dataset.i);
          cb.checked = arr.includes(i);
          cb.addEventListener("change", () => {
            const cur = Array.isArray(current().data[f.id]) ? current().data[f.id] : [];
            const next = cb.checked ? [...new Set([...cur, i])] : cur.filter(x => x !== i);
            setVal(f.id, next); onChange(f);
          });
        });
        break;
      }
      case "table": {
        const tbl = $(`table[data-field="${f.id}"]`);
        const obj = (stored && typeof stored === "object") ? stored : {};
        $$("input[data-cell]", tbl).forEach(inp => {
          const key = inp.dataset.cell;
          if (obj[key]) inp.value = obj[key];
          inp.addEventListener("input", () => { obj[key] = inp.value; setVal(f.id, obj); onChange(f); });
        });
        break;
      }
    }
  }

  function onChange(f) {
    updateMeta(f);
    updateProgress();
    updateNavChip(f);
  }

  /* ----------------------- Méta & progression ----------------------- */
  function updateAllMeta() { BOOKLET.forEach(sec => updateSectionMeta(sec)); updateProgress(); }
  function updateMeta(f) { const sec = BOOKLET.find(s => s.fields.includes(f)); if (sec) updateSectionMeta(sec); }
  function updateSectionMeta(sec) {
    const total = sec.fields.length;
    const done = sec.fields.filter(f => isFilled(val(f.id))).length;
    const el = $(`[data-meta="${sec.id}"]`);
    if (el) el.textContent = `${done}/${total} renseignés`;
  }
  function updateNavChip() { renderNavState(); }
  function renderNavState() {
    BOOKLET.forEach(sec => {
      const chip = $(`.nav-chip[data-goto="${sec.id}"]`);
      if (chip) chip.classList.toggle("filled", sectionFilled(sec));
    });
  }
  function updateProgress() {
    const all = BOOKLET.flatMap(s => s.fields);
    const done = all.filter(f => isFilled(val(f.id))).length;
    const pct = Math.round((done / all.length) * 100);
    $("#progressFill").style.width = pct + "%";
    $("#progressLabel").textContent = pct + " %";
    renderNavState();
  }

  /* ----------------------- Gestion des RDV ----------------------- */
  function visibleRdvs() {
    let list = store.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (ownerFilter === "mine") list = list.filter(ownedByMe);
    else if (ownerFilter !== "all") list = list.filter(r => r.author_id === ownerFilter);
    return list;
  }
  function refreshRdvSelect() {
    const sel = $("#rdvSelect");
    sel.innerHTML = visibleRdvs().map(r => {
      const soc = r.data.societe || "Sans nom";
      const d = r.data.date_rdv ? " · " + r.data.date_rdv : "";
      const who = ownedByMe(r) ? "" : " — " + window.RexDB.authorName(r.author_id);
      return `<option value="${r.id}" ${r.id === currentId ? "selected" : ""}>${esc(soc)}${esc(d)}${esc(who)}</option>`;
    }).join("");
  }
  // Filtre « propriétaire » : visible seulement pour les responsables (RRO/CA/RO).
  function refreshOwnerFilter() {
    const wrap = $("#ownerFilterRow");
    const sel = $("#ownerFilter");
    if (!wrap || !sel) return;
    if (!window.RexDB.isManager()) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const owners = [...new Set(store.map(r => r.author_id))]
      .filter(id => id !== myId())
      .map(id => ({ id, name: window.RexDB.authorName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML =
      `<option value="all">Toute l'équipe</option>` +
      `<option value="mine">Mes rendez-vous</option>` +
      owners.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
    sel.value = ownerFilter;
  }
  function switchTo(id) {
    currentId = id;
    refreshRdvSelect(); renderBooklet(); updateAllMeta(); renderNavState();
    applyReadOnly();
    window.scrollTo({ top: 0 });
  }
  // Verrouille la saisie quand le RDV affiché appartient à un collaborateur.
  function applyReadOnly() {
    const ro = isReadOnly();
    const main = $("#booklet");
    if (main) main.classList.toggle("readonly", ro);
    $$("#booklet input, #booklet textarea, #booklet select").forEach(el => { el.disabled = ro; });
    $$("#booklet button").forEach(el => { if (!el.closest(".section-head")) el.disabled = ro; });
    const del = $("#btnDelete"); if (del) del.disabled = ro;
    setSaveStatus("saved");
  }

  /* ----------------------- Synthèse : helpers ----------------------- */
  function displayValue(f) {
    const v = val(f.id);
    if (!isFilled(v)) return "";
    switch (f.type) {
      case "rating": return `${v}/10`;
      case "yesno": {
        let s = v.v || "";
        if (v.date) s += (s ? " — " : "") + v.date;
        if (v.precision) s += (s ? " — " : "") + v.precision;
        return s;
      }
      case "checklist": return (v || []).map(i => "• " + f.options[i]).join("\n");
      case "table": return tableToText(f, v);
      default: return String(v);
    }
  }
  function tableToText(f, obj) {
    const lines = [];
    f.rows.forEach((rlabel, r) => {
      const cells = [];
      for (let c = 0; c < f.cols; c++) { const cv = obj[`${r}-${c}`]; if (cv && cv.trim()) cells.push(cv.trim()); }
      if (cells.length) lines.push(`${rlabel} : ${cells.join(" | ")}`);
    });
    return lines.join("\n");
  }
  function tableToHtml(f, obj) {
    if (!isFilled(obj)) return "";
    const head = f.columns
      ? `<tr><th>${esc(f.rowHeader || "")}</th>${f.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr>`
      : `<tr><th></th>${Array.from({ length: f.cols }, (_, c) => `<th>${esc((f.colLabel || "") + " " + (c + 1))}</th>`).join("")}</tr>`;
    const rows = f.rows.map((rlabel, r) => {
      const tds = Array.from({ length: f.cols }, (_, c) => `<td>${esc(obj[`${r}-${c}`] || "")}</td>`).join("");
      return `<tr><td><b>${esc(rlabel)}</b></td>${tds}</tr>`;
    }).join("");
    return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  /* ----------------------- Aperçu / impression PDF ----------------------- */
  function buildPrintDoc(includeEmpty) {
    const r = current();
    const soc = r.data.societe || "—";
    const date = r.data.date_rdv || "—";
    const meta = `
      <div class="meta">
        <div><b>Société :</b> ${esc(soc)}</div>
        <div><b>Date du RDV :</b> ${esc(date)}</div>
        <div><b>Contact :</b> ${esc(r.data.contact || "—")} ${r.data.fonction ? "(" + esc(r.data.fonction) + ")" : ""}</div>
        <div><b>Commercial :</b> ${esc(r.data.commercial || "—")}</div>
      </div>`;
    let html = `<img class="logo" src="assets/logo-red.png" alt="Rex-Rotary" />
      <h1>Synthèse de rendez-vous</h1>
      <div class="sub">Livret de découverte · Rex Seller</div>${meta}`;

    BOOKLET.forEach(sec => {
      const parts = [];
      sec.fields.forEach(f => {
        const filled = isFilled(val(f.id));
        if (!filled && !includeEmpty) return;
        if (f.type === "table") {
          const t = filled ? tableToHtml(f, val(f.id)) : "";
          parts.push(`<div class="qa"><div class="q">${esc(f.label)}</div>${t || '<div class="a">—</div>'}</div>`);
        } else {
          const a = filled ? esc(displayValue(f)) : "—";
          parts.push(`<div class="qa"><span class="q">${esc(f.label)} :</span> <span class="a">${a}</span></div>`);
        }
      });
      if (parts.length) html += `<h2>${sec.icon} ${esc(sec.title)}</h2>${parts.join("")}`;
    });

    // Affaire
    if (r.affaire.active) html += buildAffairePrint();

    html += `<div class="foot">Document généré par Rex Seller — ${new Date().toLocaleString("fr-FR")}</div>`;
    return `<div class="print-doc">${html}</div>`;
  }

  function buildAffairePrint() {
    const a = current().affaire.data;
    let h = `<h2>💼 Affaire — les 11 critères</h2>`;
    AFFAIRE_CRITERES.forEach(c => {
      h += `<div class="qa"><span class="q">${esc(c.label)} :</span> <span class="a">${esc(a[c.id] || "—")}</span></div>`;
    });
    return h;
  }

  function renderPdfPreview() {
    $("#pdfPreview").innerHTML = buildPrintDoc($("#includeEmpty").checked)
      .replace('class="print-doc"', 'class="pdf-preview-doc"');
  }

  function doPrint() {
    $("#printArea").innerHTML = buildPrintDoc($("#includeEmpty").checked);
    window.print();
  }

  /* ----------------------- Résumé CRM ----------------------- */
  function buildCrmSummary() {
    const r = current(), d = r.data;
    const L = [];
    const push = (label, fid) => { if (isFilled(d[fid])) L.push(`${label} : ${flat(d[fid], fid)}`); };
    const flat = (v, fid) => {
      const f = BOOKLET.flatMap(s => s.fields).find(x => x.id === fid);
      return f ? displayValue(f).replace(/\n/g, " / ") : String(v);
    };

    L.push(`=== SYNTHÈSE RDV DÉCOUVERTE — ${d.societe || "?"} ===`);
    if (d.date_rdv) L.push(`Date : ${d.date_rdv}`);
    push("Contact", "contact");
    push("Fonction", "fonction");
    push("Secteur / valeurs ajoutées", "secteur");
    push("Localisation / sites", "localisation");
    push("Effectif", "salaries");
    if (isFilled(d.decisions)) L.push(`Prise de décision : ${flat(d.decisions, "decisions")}`);
    L.push("");

    L.push("— Environnement actuel —");
    push("Gestionnaire IT / maintenance", "inf_gestionnaire");
    push("Note parc informatique", "inf_note");
    push("Note prestataire télécom", "tel_note");
    push("Antivirus / Pack Office", "inf_av_office");
    push("RGPD", "sec_rgpd");
    L.push("");

    if (isFilled(d.val_reformulation)) {
      L.push("— Problématiques / besoin / objectif budgétaire —");
      L.push(flat(d.val_reformulation, "val_reformulation"));
      L.push("");
    }
    if (isFilled(d.val_quand)) L.push(`Équipement souhaité (QUAND) : ${d.val_quand}`);
    if (isFilled(d.val_processus)) L.push(`Processus de décision : ${flat(d.val_processus, "val_processus")}`);

    const projF = BOOKLET.flatMap(s => s.fields).find(f => f.id === "val_projets");
    if (isFilled(d.val_projets)) {
      const t = tableToText(projF, d.val_projets);
      if (t) { L.push(""); L.push("— Projets à présenter —"); L.push(t); }
    }

    L.push("");
    if (isFilled(d.dem_rdv_demo)) L.push(`RDV de démo : ${d.dem_rdv_demo}`);
    if (isFilled(d.val_prochain_rdv)) L.push(`Prochain RDV : ${d.val_prochain_rdv}`);

    L.push("");
    L.push(r.affaire.active ? ">>> AFFAIRE À LEVER (voir fiche affaire détaillée)" : ">>> Pas d'affaire levée à ce stade.");
    return L.join("\n");
  }

  /* --------- Recoupement : pré-remplir les 11 critères depuis le livret --------- */
  function suggestCriteria() {
    const d = current().data;
    const g = id => {
      const v = d[id];
      if (v == null) return "";
      if (typeof v === "object") return "";
      return String(v).trim();
    };
    const yn = id => {
      const v = d[id];
      if (!v || typeof v !== "object") return "";
      let s = v.v || "";
      if (v.date) s += s ? ` (le ${v.date})` : `le ${v.date}`;
      return s;
    };
    const s = {};
    const set = (k, parts) => { const t = parts.filter(Boolean).join(" / "); if (t) s[k] = t; };

    // Signataire ← circuit de décision
    set("cr_signataire", [g("decisions")]);
    // Influenceur clé ← interlocuteur rencontré (contact + fonction)
    set("cr_influenceur", [[g("contact"), g("fonction")].filter(Boolean).join(" — ")]);
    // Besoin / solution proposée ← reformulation + projets à présenter
    const projF = BOOKLET.flatMap(x => x.fields).find(f => f.id === "val_projets");
    const projTxt = isFilled(d.val_projets) ? tableToText(projF, d.val_projets).replace(/\n/g, " ; ") : "";
    set("cr_besoin", [g("val_reformulation"), projTxt]);
    // Motivation d'achat ← ce qui manque pour arriver à 10 (IT) + insatisfaction télécom
    set("cr_motivation", [g("inf_ecart10"), g("tel_pourquoi")]);
    // Quand ← QUAND voulez-vous être équipés
    set("cr_quand", [g("val_quand")]);
    // Type & date de relance ← prochain RDV / RDV de démo
    set("cr_relance", [g("val_prochain_rdv") && ("Prochain RDV : " + g("val_prochain_rdv")), g("dem_rdv_demo") && ("Démo : " + g("dem_rdv_demo"))]);
    // Étude réalisée ← audit prévu
    const audit = yn("val_audit") || yn("sec_rdv_audit");
    if (audit) set("cr_etude", ["Audit " + audit]);
    // Accélérateur ← engagement moral
    set("cr_accelerateur", [g("val_engagement")]);
    return s;
  }

  // Renseigne les critères vides (ou tous si overwrite) à partir du livret.
  function applyCriteriaSuggestions(overwrite) {
    const a = current().affaire.data;
    const sug = suggestCriteria();
    let n = 0;
    AFFAIRE_CRITERES.forEach(c => {
      if (sug[c.id] && (overwrite || !isFilled(a[c.id]))) { a[c.id] = sug[c.id]; n++; }
    });
    if (n) touch();
    return n;
  }

  /* ----------------------- Formulaire Affaire ----------------------- */
  function renderAffaireForm() {
    const wrap = $("#affaireForm");
    const a = current().affaire.data;
    wrap.innerHTML = `
      <div class="affaire-block">
        <div class="affaire-block__head">
          <h4>Les 11 critères de l'affaire</h4>
          <button type="button" id="btnPrefill" class="btn btn--ghost btn--sm">💡 Recouper depuis le livret</button>
        </div>
        <p class="prefill-hint">Les critères sont pré-remplis automatiquement à partir du livret de découverte — vérifiez et ajustez.</p>
        ${AFFAIRE_CRITERES.map(c => `
          <div class="field">
            <label class="field__label">${esc(c.label)}</label>
            <textarea data-aff="${c.id}"></textarea>
          </div>`).join("")}
      </div>`;

    $$("[data-aff]", wrap).forEach(el => {
      const k = el.dataset.aff;
      if (a[k] != null) el.value = a[k];
      el.addEventListener("input", () => { a[k] = el.value; touch(); buildAffaireOutput(); });
    });
    const btnPrefill = $("#btnPrefill", wrap);
    if (btnPrefill) btnPrefill.addEventListener("click", () => {
      const n = applyCriteriaSuggestions(false);
      renderAffaireForm(); buildAffaireOutput();
      toast(n ? `${n} critère(s) recoupé(s) depuis le livret` : "Rien de nouveau à recouper");
    });
    // RDV d'un collaborateur : consultation seule
    if (isReadOnly()) $$("#affaireForm textarea, #affaireForm button").forEach(el => { el.disabled = true; });
  }

  function buildAffaireOutput() {
    const a = current().affaire.data;
    const L = ["=== DÉTAIL AFFAIRE (à coller dans le suivi CRM) ==="];
    AFFAIRE_CRITERES.forEach(c => L.push(`${c.label} : ${a[c.id] || ""}`));
    $("#affaireText").value = L.join("\n");
  }

  /* ----------------------- Modale ----------------------- */
  function openSynthese() {
    refreshFromData();
    $("#affaireToggle").checked = current().affaire.active;
    $("#affaireToggle").disabled = isReadOnly();
    toggleAffaire();
    $("#syntheseModal").hidden = false;
    document.body.style.overflow = "hidden";
    switchTab("pdf");
  }
  function closeSynthese() {
    $("#syntheseModal").hidden = true;
    document.body.style.overflow = "";
  }
  function switchTab(name) {
    $$(".tab").forEach(t => t.classList.toggle("tab--active", t.dataset.tab === name));
    $$(".tabpane").forEach(p => p.classList.toggle("tabpane--active", p.dataset.pane === name));
    if (name === "pdf") renderPdfPreview();
    if (name === "crm") $("#crmText").value = buildCrmSummary();
    if (name === "affaire") buildAffaireOutput();
  }
  function refreshFromData() { /* place-holder for future recompute */ }

  function toggleAffaire() {
    const on = $("#affaireToggle").checked;
    const aff = current().affaire;
    aff.active = on;
    // Pré-remplissage automatique des critères restés vides, à chaque activation
    // (reflète toujours les dernières réponses du livret).
    if (on) applyCriteriaSuggestions(false);
    touch();
    $("#affaireForm").hidden = !on;
    $("#affaireOutputWrap").hidden = !on;
    if (on) { renderAffaireForm(); buildAffaireOutput(); }
  }

  /* ----------------------- Utilitaires UI ----------------------- */
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 1800);
  }
  async function copyText(id) {
    const el = $("#" + id);
    try { await navigator.clipboard.writeText(el.value); toast("Copié ✓"); }
    catch (e) { el.removeAttribute("readonly"); el.select(); document.execCommand("copy"); el.setAttribute("readonly", ""); toast("Copié ✓"); }
  }

  /* ----------------------- Événements globaux ----------------------- */
  function wire() {
    $("#btnMenu").addEventListener("click", () => {
      const p = $("#menuPanel"); p.hidden = !p.hidden;
      if (!p.hidden) { refreshOwnerFilter(); refreshRdvSelect(); }
    });
    $("#rdvSelect").addEventListener("change", e => switchTo(e.target.value));
    const ofilt = $("#ownerFilter");
    if (ofilt) ofilt.addEventListener("change", e => {
      ownerFilter = e.target.value;
      const list = visibleRdvs();
      if (!list.find(r => r.id === currentId) && list[0]) switchTo(list[0].id);
      else refreshRdvSelect();
    });
    $("#btnNew").addEventListener("click", async () => {
      const r = newRdv();
      try { await saveRdv(r); } catch (e) { return; }
      store.push(r); ownerFilter = "all"; refreshOwnerFilter();
      switchTo(r.id); toast("Nouveau RDV créé");
    });
    $("#btnDuplicate").addEventListener("click", async () => {
      const src = current(); if (!src) return;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(); copy.author_id = myId(); copy.createdAt = copy.updatedAt = Date.now();
      copy.data.societe = (copy.data.societe || "") + " (copie)";
      try { await saveRdv(copy); } catch (e) { return; }
      store.push(copy); switchTo(copy.id); toast("RDV dupliqué");
    });
    $("#btnDelete").addEventListener("click", async () => {
      const r = current();
      if (!ownedByMe(r)) { toast("Vous ne pouvez supprimer que vos propres RDV"); return; }
      if (store.filter(ownedByMe).length <= 1) { toast("Impossible de supprimer votre dernier RDV"); return; }
      if (!confirm("Supprimer définitivement ce rendez-vous ?")) return;
      try { await window.RexDB.deleteRdv(r.id); } catch (e) { toast("Échec de la suppression"); return; }
      store = store.filter(x => x.id !== r.id);
      currentId = (visibleRdvs()[0] || store[0]).id;
      switchTo(currentId); toast("RDV supprimé");
    });
    $("#btnExport").addEventListener("click", () => {
      const r = current();
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `rex-seller_${(r.data.societe || "rdv").replace(/[^\w-]+/g, "_")}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    });
    $("#btnImport").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const obj = JSON.parse(reader.result);
          obj.id = uid(); obj.author_id = myId();
          obj.createdAt = obj.createdAt || Date.now(); obj.updatedAt = Date.now();
          if (!obj.data) obj.data = {};
          if (!obj.affaire) obj.affaire = { active: false, data: {} };
          await saveRdv(obj);
          store.push(obj); switchTo(obj.id); toast("RDV importé");
        } catch (err) { toast("Fichier invalide ou non enregistré"); }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    $("#btnSynthese").addEventListener("click", openSynthese);
    $$("[data-close]").forEach(el => el.addEventListener("click", closeSynthese));
    $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    $("#includeEmpty").addEventListener("change", renderPdfPreview);
    $("#btnPrint").addEventListener("click", doPrint);
    $("#affaireToggle").addEventListener("change", () => { toggleAffaire(); });
    $$("[data-copy]").forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
  }

  /* ----------------------- Démarrage ----------------------- */
  // Appelé par supa.js une fois l'utilisateur connecté et les données chargées.
  let wired = false;
  async function boot({ profile, rdvs }) {
    store = Array.isArray(rdvs) ? rdvs : [];
    // Garantir au moins un RDV modifiable appartenant à l'utilisateur.
    if (!store.some(ownedByMe)) {
      const r = newRdv();
      try { await saveRdv(r); } catch (e) { /* réseau indisponible : on garde en mémoire */ }
      store.unshift(r);
    }
    const mine = store.filter(ownedByMe).sort((a, b) => b.updatedAt - a.updatedAt);
    currentId = (mine[0] || store[0]).id;
    ownerFilter = "all";

    document.body.classList.remove("booting");
    renderNav();
    renderBooklet();
    refreshOwnerFilter();
    refreshRdvSelect();
    updateAllMeta();
    applyReadOnly();
    if (!wired) { trackActiveOnScroll(); wire(); wired = true; }
    setSaveStatus("saved");
    if (window.RexAdmin && window.RexAdmin.onBoot) window.RexAdmin.onBoot();
  }

  // Rafraîchit le filtre « propriétaire » et la liste après une action admin.
  function refreshTeamUI() { refreshOwnerFilter(); refreshRdvSelect(); }

  window.RexApp = { boot, refreshTeamUI };

  // Service worker (mode hors-ligne pour l'app ; les données restent en ligne)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
