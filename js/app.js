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
  function todayISO() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function newRdv() {
    // La date du RDV est pré-remplie à aujourd'hui (modifiable ensuite).
    return { id: uid(), author_id: myId(), createdAt: Date.now(), updatedAt: Date.now(), data: { date_rdv: todayISO() }, affaire: { active: false, data: {} } };
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
    const chips = BOOKLET.map((sec, i) => {
      const filled = sectionFilled(sec);
      return `<button class="nav-chip ${i === 0 ? "active" : ""} ${filled ? "filled" : ""}" data-goto="${sec.id}" title="${esc(sec.title)}">
        <span class="dot"></span>
        <span class="nav-chip__icon">${sec.icon}</span>
        <span class="nav-chip__label">${esc(sec.short || sec.title)}</span>
      </button>`;
    });
    // Chip « Présentation » juste après « Entreprise ».
    chips.splice(1, 0, `<button class="nav-chip" data-goto="presentation" title="Présentation Rex-Rotary">
        <span class="dot"></span>
        <span class="nav-chip__icon">📢</span>
        <span class="nav-chip__label">Présentation</span>
      </button>`);
    nav.innerHTML = chips.join("") +
      // Bouton Affaire, à droite des secteurs : actif seulement quand l'affaire est mûre.
      `<button id="btnAffaire" class="nav-affaire" disabled>💼 Affaire</button>`;

    $$(".nav-chip", nav).forEach(chip => chip.addEventListener("click", () => {
      const id = chip.dataset.goto;
      const card = $(`#sec-${id}`);
      openSection(card, true);
      setActiveChip(id);
      const top = card.getBoundingClientRect().top + window.scrollY - stickyHeight() - 6;
      window.scrollTo({ top, behavior: "smooth" });
    }));
    const bAff = $("#btnAffaire", nav);
    if (bAff) bAff.addEventListener("click", openAffaire);
    updateAffaireButton();
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

  // Présentation par défaut (native), affichée tant que l'utilisateur ne l'a
  // pas personnalisée. Chacun n'a plus qu'à adapter son prénom / secteur.
  const DEFAULT_PRESENTATION =
`Donc Alexandre, j'habite à St Aulaire, consultant du secteur centre sud Corrèze chez Rex Rotary. Entreprise fondée en 1974 avec plus de 600 collaborateurs ainsi que 60 agences sur toute la France. Notre agence se situe à Brive donc l'entreprise mise beaucoup sur la proximité, l'une des valeurs de l'entreprise.

Pour cela nous fonctionnons en trinômes, c'est-à-dire un commercial, un informaticien Jessy ainsi qu'un technicien Ange. Cela nous permet d'assurer 2 autres valeurs essentielles chez nous, la transmission de l'information et la réactivité.
Nous avons notre propre Hotline basé à Lyon, ce n'est pas de la sous-traitance et elle prend en charge 80% des demandes. Si faut se déplacer, le service de proximité prend alors tout son sens.
L'objectif est donc d'accompagner nos clients sur toutes les phases d'un projet : la conception, l'installation et la mise en place, et demain le SAV et d'éventuels dépannages.

Aujourd'hui Rex Rotary accompagne les entreprises comme la vôtre sur 6 métiers afin de vous rendre plus productifs :
- L'informatique : gérer un réseau informatique qu'il soit local ou distant
- La sauvegarde et la sécurité : protéger vos données selon les normes RGPD et vous garantir de récupérer vos données quel que soit l'incident.
- La dématérialisation : via des systèmes simples et fluides pour votre communication interne et/ou externe
- Les systèmes d'impression : tout format, tout volume
- La communication via l'affichage dynamique et les écrans interactifs
- Téléphonie et internet

L'idée de ce RDV c'est de voir comment vous êtes équipés et comment vous fonctionnez pour vous apporter une plus-value, qu'elle soit fonctionnelle, organisationnelle ou financière.
Soit je suis en mesure de le faire seul, soit nous passerons par un audit réalisé par mon informaticien.`;

  // Carte spéciale « Présentation Rex-Rotary » : contenu propre au compte
  // de l'utilisateur (pas au RDV), réutilisé sur tous ses rendez-vous.
  function presentationCardHtml() {
    return `
      <section class="section-card" id="sec-presentation">
        <button class="section-head" data-toggle>
          <span class="section-head__icon">📢</span>
          <span class="section-head__text">
            <span class="section-head__title">Présentation Rex-Rotary</span>
            <span class="section-head__meta">Votre présentation personnelle — enregistrée sur votre compte</span>
          </span>
          <span class="section-head__chev">▾</span>
        </button>
        <div class="section-body">
          <p class="section-intro">Rédigez votre présentation de Rex-Rotary telle que vous aimez la faire. Elle est propre à votre compte et réutilisée automatiquement sur tous vos rendez-vous. <span id="presentationStatus" class="pres-status"></span></p>
          <div class="field">
            <textarea id="presentationText" rows="10" placeholder="Ex. : Rex-Rotary accompagne les entreprises dans la gestion documentaire, l'impression, la téléphonie…"></textarea>
          </div>
        </div>
      </section>`;
  }

  function renderBooklet() {
    const root = $("#booklet");
    const cards = BOOKLET.map((sec, i) => `
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
      </section>`);
    // Insère la présentation juste après la première section (« Votre entreprise »).
    cards.splice(1, 0, presentationCardHtml());
    root.innerHTML = cards.join("");

    $$("[data-toggle]", root).forEach(btn =>
      btn.addEventListener("click", () => openSection(btn.closest(".section-card"))));

    BOOKLET.forEach(sec => sec.fields.forEach(f => bindField(f)));
    bindPresentation();
    updateAllMeta();
  }

  // La présentation n'appartient pas au RDV : elle est toujours modifiable
  // (réglage du compte) et enregistrée sur le profil de l'utilisateur.
  let presTimer = null;
  function bindPresentation() {
    const el = $("#presentationText");
    if (!el) return;
    // Présentation enregistrée par l'utilisateur, ou présentation par défaut.
    const saved = window.RexDB.getPresentation();
    el.value = isFilled(saved) ? saved : DEFAULT_PRESENTATION;
    const status = $("#presentationStatus");
    el.addEventListener("input", () => {
      if (status) status.textContent = "Enregistrement…";
      clearTimeout(presTimer);
      presTimer = setTimeout(() => {
        window.RexDB.savePresentation(el.value)
          .then(() => { if (status) status.textContent = "Enregistré ✓"; })
          .catch(() => { if (status) status.textContent = "Non enregistré ✕"; });
      }, 600);
    });
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
    updateAffaireButton();
  }

  /* ----------------------- Affaire : conditions & ouverture ----------------------- */
  // Critères requis (issus de la découverte) pour "lever" l'affaire :
  //  signataire, influenceur clé, besoin/solution, quand veut-il être équipé,
  //  type & date de prochaine relance.
  const AFFAIRE_REQUIS = ["cr_signataire", "cr_influenceur", "cr_besoin", "cr_quand", "cr_relance"];
  function affaireReady() {
    if (!current()) return false;
    const s = suggestCriteria();
    return AFFAIRE_REQUIS.every(k => isFilled(s[k]));
  }
  function affaireHasContent(r) {
    r = r || current();
    return !!r && AFFAIRE_CRITERES.some(c => isFilled(r.affaire.data[c.id]));
  }
  function updateAffaireButton() {
    const btn = $("#btnAffaire");
    if (!btn) return;
    const ready = affaireReady();
    btn.disabled = !ready;
    btn.classList.toggle("ready", ready);
    btn.title = ready
      ? "Ouvrir la fiche affaire (11 critères)"
      : "Disponible une fois renseignés : le signataire, l'influenceur clé, le besoin, la date d'équipement souhaitée et la prochaine relance.";
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
    // Suppression réservée aux responsables (RO/CA/RRO) : masquée pour les commerciaux.
    const del = $("#btnDelete");
    if (del) {
      const canDelete = window.RexDB.isManager();
      del.hidden = !canDelete;
      del.disabled = !canDelete;
    }
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

    // Affaire (incluse si des critères ont été renseignés)
    if (affaireHasContent(r)) html += buildAffairePrint();

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
    const HEADER_IDS = ["date_rdv", "societe", "contact", "fonction", "commercial"];
    const L = [];

    // En-tête
    L.push(`=== SYNTHÈSE RDV DÉCOUVERTE — ${d.societe || "?"} ===`);
    if (isFilled(d.date_rdv)) L.push(`Date du RDV : ${d.date_rdv}`);
    if (isFilled(d.contact)) L.push(`Contact : ${d.contact}${isFilled(d.fonction) ? " (" + d.fonction + ")" : ""}`);
    if (isFilled(d.commercial)) L.push(`Commercial : ${d.commercial}`);
    L.push("");

    // Toutes les sections du livret, champ par champ (uniquement ce qui est renseigné).
    BOOKLET.forEach(sec => {
      const lines = [];
      sec.fields.forEach(f => {
        if (HEADER_IDS.includes(f.id)) return;         // déjà repris en en-tête
        if (!isFilled(val(f.id))) return;
        const v = displayValue(f);
        if (v.indexOf("\n") !== -1) {
          lines.push(`${f.label} :`);
          v.split("\n").forEach(x => lines.push("  " + x));
        } else {
          lines.push(`${f.label} : ${v}`);
        }
      });
      if (lines.length) {
        L.push(`— ${sec.title.toUpperCase()} —`);
        lines.forEach(x => L.push(x));
        L.push("");
      }
    });

    L.push(affaireHasContent(r)
      ? ">>> AFFAIRE À LEVER (voir la fiche Affaire — 11 critères)"
      : ">>> Pas d'affaire levée à ce stade.");
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

  /* ----------------------- Modale Affaire ----------------------- */
  function openAffaire() {
    if (!affaireReady()) { toast("Complétez d'abord signataire, influenceur, besoin, date d'équipement et relance."); return; }
    const aff = current().affaire;
    aff.active = true;
    applyCriteriaSuggestions(false);   // pré-remplit les critères vides depuis le livret
    renderAffaireForm();
    buildAffaireOutput();
    $("#affaireModal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeAffaire() {
    $("#affaireModal").hidden = true;
    document.body.style.overflow = "";
  }

  /* ----------------------- Mail récap client ----------------------- */
  function clientEmailParts() {
    const d = current().data;
    const dateFr = s => { try { const p = String(s).split("-"); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; } catch (e) { return s; } };
    const soc = d.societe || "";
    const contact = d.contact || "";
    const commercial = d.commercial || "";

    // Thèmes abordés (haut niveau) selon les sections renseignées — sans détailler.
    const THEMES = [
      { id: "info_infra", label: "votre infrastructure informatique" },
      { id: "securite", label: "la sécurité et la sauvegarde de vos données" },
      { id: "demat", label: "la dématérialisation de vos documents" },
      { id: "impression", label: "votre parc d'impression" },
      { id: "communication", label: "votre communication" },
      { id: "telephonie", label: "votre téléphonie et vos accès Internet" }
    ];
    const themes = THEMES.filter(t => {
      const sec = BOOKLET.find(s => s.id === t.id);
      return sec && sec.fields.some(f => isFilled(d[f.id]));
    }).map(t => t.label);
    let themesTxt;
    if (!themes.length) themesTxt = "votre organisation actuelle et vos enjeux";
    else if (themes.length === 1) themesTxt = themes[0];
    else themesTxt = themes.slice(0, -1).join(", ") + " et " + themes[themes.length - 1];

    const prochain = d.val_prochain_rdv || d.dem_rdv_demo || "";

    const subject = `Suite à notre rendez-vous${soc ? " — " + soc : ""}`;
    const L = [];
    L.push(contact ? `Bonjour ${contact},` : "Bonjour,");
    L.push("");
    L.push(`Je tenais à vous remercier pour le temps que vous m'avez accordé${isFilled(d.date_rdv) ? " le " + dateFr(d.date_rdv) : ""} et pour la qualité de nos échanges.`);
    L.push("");
    L.push(`Notre entretien m'a permis de mieux cerner ${themesTxt}, ainsi que vos priorités et votre manière de fonctionner.`);
    L.push("");
    L.push("De mon côté, je prépare une proposition sur-mesure afin de répondre au plus près de vos objectifs et de vous apporter des solutions concrètes.");
    L.push("");
    if (prochain) {
      L.push(`Comme convenu, je vous propose de nous retrouver le ${dateFr(prochain)} afin de vous présenter mes préconisations.`);
    } else {
      L.push("Je reviendrai très prochainement vers vous afin de convenir d'un prochain rendez-vous et de vous présenter mes préconisations.");
    }
    L.push("");
    L.push("Restant à votre entière disposition d'ici là, je vous prie d'agréer, Madame, Monsieur, mes salutations les plus cordiales.");
    L.push("");
    if (commercial) L.push(commercial);
    L.push("Rex-Rotary");
    return { subject, body: L.join("\n") };
  }
  function buildClientEmail() {
    const { subject, body } = clientEmailParts();
    return `Objet : ${subject}\n\n${body}`;
  }
  function openMailClient() {
    const { subject, body } = clientEmailParts();
    const href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    window.location.href = href;
  }

  /* ----------------------- Modale ----------------------- */
  function openSynthese() {
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
    if (name === "mail") $("#mailText").value = buildClientEmail();
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
      if (!window.RexDB.isManager()) { toast("Seul un responsable peut supprimer un rendez-vous"); return; }
      const r = current(); if (!r) return;
      if (!confirm("Supprimer définitivement ce rendez-vous ?")) return;
      try { await window.RexDB.deleteRdv(r.id); } catch (e) { toast("Échec de la suppression"); return; }
      store = store.filter(x => x.id !== r.id);
      if (!store.some(ownedByMe)) {
        const nr = newRdv();
        try { await saveRdv(nr); } catch (e) { /* réseau : gardé en mémoire */ }
        store.push(nr);
      }
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
    $$("[data-affaire-close]").forEach(el => el.addEventListener("click", closeAffaire));
    $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    $("#includeEmpty").addEventListener("change", renderPdfPreview);
    $("#btnPrint").addEventListener("click", doPrint);
    const bMail = $("#btnMailOpen"); if (bMail) bMail.addEventListener("click", openMailClient);
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
    if (window.RexTickets && window.RexTickets.onBoot) window.RexTickets.onBoot();
  }

  // Rafraîchit le filtre « propriétaire » et la liste après une action admin.
  function refreshTeamUI() { refreshOwnerFilter(); refreshRdvSelect(); }

  window.RexApp = { boot, refreshTeamUI };

  // Service worker (mode hors-ligne pour l'app ; les données restent en ligne)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
