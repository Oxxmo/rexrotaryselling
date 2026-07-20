/* ============================================================
   Rex Seller — logique applicative (vanilla JS, sans dépendance)
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "rexseller.rdvs.v1";
  const LS_CUR = "rexseller.current.v1";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* ----------------------- État & stockage ----------------------- */
  let store = loadStore();
  let currentId = localStorage.getItem(LS_CUR);
  if (!store.length) { const r = newRdv(); store.push(r); currentId = r.id; persist(); }
  if (!store.find(r => r.id === currentId)) currentId = store[0].id;

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; }
  }
  function persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
    localStorage.setItem(LS_CUR, currentId);
  }
  function newRdv() {
    return { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), data: {}, affaire: { active: false, data: {} } };
  }
  function current() { return store.find(r => r.id === currentId); }

  let saveTimer = null;
  function touch() {
    const r = current(); if (!r) return;
    r.updatedAt = Date.now();
    setSaveStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist(); setSaveStatus("saved"); }, 350);
  }
  function setSaveStatus(state) {
    const el = $("#saveStatus");
    if (state === "saving") { el.textContent = "Enregistrement…"; el.classList.add("saving"); }
    else { el.textContent = "Enregistré ✓"; el.classList.remove("saving"); }
  }

  const val = (id) => current().data[id];
  const setVal = (id, v) => { current().data[id] = v; touch(); };

  /* ----------------------- Rendu du livret ----------------------- */
  function renderNav() {
    const nav = $("#sectionNav");
    nav.innerHTML = BOOKLET.map(sec => {
      const filled = sectionFilled(sec);
      return `<button class="nav-chip ${filled ? "filled" : ""}" data-goto="${sec.id}">
        <span class="dot"></span>${sec.icon} ${esc(sec.title)}</button>`;
    }).join("");
    $$(".nav-chip", nav).forEach(chip => chip.addEventListener("click", () => {
      const id = chip.dataset.goto;
      const card = $(`#sec-${id}`);
      openSection(card, true);
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
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
          ${f.withDate ? `<div class="yesno-extra"><input type="text" placeholder="${esc(f.dateLabel || "Date")}" data-extra="date"></div>` : ""}
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
  function refreshRdvSelect() {
    const sel = $("#rdvSelect");
    sel.innerHTML = store
      .slice().sort((a, b) => b.updatedAt - a.updatedAt)
      .map(r => {
        const soc = r.data.societe || "Sans nom";
        const d = r.data.date_rdv ? " · " + r.data.date_rdv : "";
        return `<option value="${r.id}" ${r.id === currentId ? "selected" : ""}>${esc(soc)}${esc(d)}</option>`;
      }).join("");
  }
  function switchTo(id) {
    currentId = id; persist();
    refreshRdvSelect(); renderBooklet(); updateAllMeta(); renderNavState();
    window.scrollTo({ top: 0 });
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
        <div><b>Commercial :</b> ${esc(r.data.commercial_dedie || "—")}</div>
      </div>`;
    let html = `<h1>Synthèse de rendez-vous — Rex Seller</h1>
      <div class="sub">Livret de découverte Rex-Rotary</div>${meta}`;

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
    let h = `<h2>💼 Affaire</h2>`;
    AFFAIRE_CRITERES.forEach(c => {
      h += `<div class="qa"><span class="q">${esc(c.label)} :</span> <span class="a">${esc(a[c.id] || "—")}</span></div>`;
    });
    const mat = MATURITE.find(m => m.value == a.maturite);
    h += `<div class="qa"><span class="q">Date prévisionnelle de vente :</span> ${esc(a.date_vente || "—")}</div>`;
    h += `<div class="qa"><span class="q">CA potentiel :</span> ${esc(a.ca_potentiel || "—")} K€</div>`;
    h += `<div class="qa"><span class="q">% Maturité :</span> ${mat ? esc(mat.label) : "—"}</div>`;
    const types = TYPES_AFFAIRE.filter(t => a["type_" + t.id]).map(t => `${t.label} (${a["type_" + t.id]} K€)`);
    h += `<div class="qa"><span class="q">Type d'affaire :</span> ${types.length ? esc(types.join(" · ")) : "—"}</div>`;
    const suivi = SUIVI_AFFAIRE.filter(s => a["suivi_" + s.id]).map(s => s.label);
    h += `<div class="qa"><span class="q">Suivi :</span> ${suivi.length ? esc(suivi.join(" · ")) : "—"}</div>`;
    h += `<div class="qa"><span class="q">Résultat :</span> ${esc(a.resultat || "—")}</div>`;
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
    push("Statut", "statut");
    push("Secteur", "secteur");
    push("Effectif", "nb_salaries");
    if (isFilled(d.ent_decision)) L.push(`Circuit décisionnel : ${d.ent_decision}`);
    L.push("");

    L.push("— Environnement actuel —");
    push("Gestionnaire IT", "inf_gestionnaire");
    push("Fournisseur impression", "imp_fournisseur");
    push("Opérateur télécom", "tel_operateur");
    push("Note parc informatique", "inf_note");
    push("Note prestataire télécom", "tel_note");
    L.push("");

    const pbs = ["val_pb1", "val_pb2", "val_pb3"].filter(id => isFilled(d[id])).map(id => d[id]);
    if (pbs.length) { L.push("— Problématiques / priorités —"); pbs.forEach((p, i) => L.push(`${i + 1}. ${p}`)); L.push(""); }

    const projF = BOOKLET.flatMap(s => s.fields).find(f => f.id === "val_projets");
    if (isFilled(d.val_projets)) {
      const t = tableToText(projF, d.val_projets);
      if (t) { L.push("— Projets à présenter —"); L.push(t); L.push(""); }
    }

    const critF = ["val_critere1", "val_critere2", "val_critere3"].filter(id => isFilled(d[id])).map(id => d[id]);
    if (critF.length) { L.push("— Critères de choix —"); critF.forEach((c, i) => L.push(`${i + 1}. ${c}`)); L.push(""); }

    const nextRdv = d.val_prochain_rdv || d.dem_prochain_rdv;
    if (nextRdv) L.push(`Prochain RDV : ${nextRdv}`);

    L.push("");
    L.push(r.affaire.active ? ">>> AFFAIRE À LEVER (voir fiche affaire détaillée)" : ">>> Pas d'affaire levée à ce stade.");
    return L.join("\n");
  }

  /* ----------------------- Formulaire Affaire ----------------------- */
  function renderAffaireForm() {
    const wrap = $("#affaireForm");
    const a = current().affaire.data;
    wrap.innerHTML = `
      <div class="affaire-block">
        <h4>Les 11 critères de l'affaire</h4>
        ${AFFAIRE_CRITERES.map(c => `
          <div class="field">
            <label class="field__label">${esc(c.label)}</label>
            <textarea data-aff="${c.id}"></textarea>
          </div>`).join("")}
      </div>

      <div class="affaire-block">
        <h4>Caractéristiques de l'affaire</h4>
        <div class="field"><label class="field__label">Date prévisionnelle de vente</label>
          <input type="date" data-aff="date_vente"></div>
        <div class="field"><label class="field__label">CA potentiel (K€)</label>
          <input type="number" inputmode="decimal" data-aff="ca_potentiel"></div>
        <div class="field"><label class="field__label">% Maturité</label>
          <select data-aff="maturite">
            <option value="">— choisir —</option>
            ${MATURITE.map(m => `<option value="${m.value}">${esc(m.label)}</option>`).join("")}
          </select>
          <div class="maturite-desc" id="matDesc"></div>
        </div>
        <div class="field"><label class="field__label">Résultat</label>
          <select data-aff="resultat">
            <option value="">— choisir —</option>
            ${RESULTAT_AFFAIRE.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="affaire-block">
        <h4>Type d'affaire (CA en K€)</h4>
        ${TYPES_AFFAIRE.map(t => `
          <div class="type-affaire-row">
            <label>${esc(t.label)}</label>
            <input type="number" inputmode="decimal" placeholder="K€" data-aff="type_${t.id}">
          </div>`).join("")}
      </div>

      <div class="affaire-block">
        <h4>Suivi de l'affaire</h4>
        <div class="checklist">
          ${SUIVI_AFFAIRE.map(s => `
            <label><input type="checkbox" data-aff-check="suivi_${s.id}"> <span>${esc(s.label)}</span></label>`).join("")}
        </div>
      </div>`;

    // Bind
    $$("[data-aff]", wrap).forEach(el => {
      const k = el.dataset.aff;
      if (a[k] != null) el.value = a[k];
      el.addEventListener("input", () => { a[k] = el.value; touch(); if (k === "maturite") paintMatDesc(); buildAffaireOutput(); });
    });
    $$("[data-aff-check]", wrap).forEach(cb => {
      const k = cb.dataset.affCheck;
      cb.checked = !!a[k];
      cb.addEventListener("change", () => { a[k] = cb.checked; touch(); buildAffaireOutput(); });
    });
    paintMatDesc();
  }

  function paintMatDesc() {
    const a = current().affaire.data;
    const m = MATURITE.find(x => x.value == a.maturite);
    $("#matDesc").textContent = m ? m.desc : "";
  }

  function buildAffaireOutput() {
    const a = current().affaire.data;
    const L = [];
    L.push("=== DÉTAIL (à coller dans le suivi CRM) ===");
    AFFAIRE_CRITERES.forEach(c => L.push(`${c.label} : ${a[c.id] || ""}`));
    L.push("");
    L.push("=== CHAMPS AFFAIRE ===");
    if (a.date_vente) L.push(`Date prévisionnelle de vente : ${a.date_vente}`);
    if (a.ca_potentiel) L.push(`CA potentiel : ${a.ca_potentiel} K€`);
    const m = MATURITE.find(x => x.value == a.maturite);
    if (m) L.push(`% Maturité : ${a.maturite} %  (${m.desc})`);
    const types = TYPES_AFFAIRE.filter(t => a["type_" + t.id]).map(t => `  - ${t.label} : ${a["type_" + t.id]} K€`);
    if (types.length) { L.push("Type d'affaire :"); types.forEach(t => L.push(t)); }
    const suivi = SUIVI_AFFAIRE.filter(s => a["suivi_" + s.id]).map(s => "  ☑ " + s.label);
    if (suivi.length) { L.push("Suivi de l'affaire :"); suivi.forEach(s => L.push(s)); }
    if (a.resultat) L.push(`Résultat : ${a.resultat}`);
    $("#affaireText").value = L.join("\n");
  }

  /* ----------------------- Modale ----------------------- */
  function openSynthese() {
    refreshFromData();
    $("#affaireToggle").checked = current().affaire.active;
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
    current().affaire.active = on; touch();
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
      const p = $("#menuPanel"); p.hidden = !p.hidden; if (!p.hidden) refreshRdvSelect();
    });
    $("#rdvSelect").addEventListener("change", e => switchTo(e.target.value));
    $("#btnNew").addEventListener("click", () => {
      const r = newRdv(); store.push(r); switchTo(r.id); toast("Nouveau RDV créé");
    });
    $("#btnDuplicate").addEventListener("click", () => {
      const src = current();
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(); copy.createdAt = copy.updatedAt = Date.now();
      copy.data.societe = (copy.data.societe || "") + " (copie)";
      store.push(copy); switchTo(copy.id); toast("RDV dupliqué");
    });
    $("#btnDelete").addEventListener("click", () => {
      if (store.length === 1) { toast("Impossible de supprimer le dernier RDV"); return; }
      if (!confirm("Supprimer définitivement ce rendez-vous ?")) return;
      store = store.filter(r => r.id !== currentId);
      currentId = store[0].id; persist();
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
      reader.onload = () => {
        try {
          const obj = JSON.parse(reader.result);
          obj.id = uid(); obj.updatedAt = Date.now();
          if (!obj.affaire) obj.affaire = { active: false, data: {} };
          store.push(obj); switchTo(obj.id); toast("RDV importé");
        } catch (err) { toast("Fichier invalide"); }
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
  renderNav();
  renderBooklet();
  refreshRdvSelect();
  updateAllMeta();
  wire();
  setSaveStatus("saved");

  // Service worker (mode hors-ligne)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
