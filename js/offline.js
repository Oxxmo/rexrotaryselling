/* ============================================================
   Rex Seller — Mode hors-ligne & synchronisation
   ------------------------------------------------------------
   - Sauvegarde locale immédiate (localStorage) de chaque RDV de
     l'utilisateur : rien n'est perdu même sans réseau ou en cas de
     fermeture de l'app.
   - File d'attente « à synchroniser » : les RDV modifiés hors ligne
     sont renvoyés automatiquement vers Supabase au retour du réseau.
   - Périmètre volontairement limité aux données PERSONNELLES de
     l'utilisateur (ses propres RDV + sa présentation). Les RDV des
     collaborateurs (vue responsable) restent consultés en ligne.
   ============================================================ */
(function () {
  "use strict";

  const PREFIX = "rex.cache.";
  let userId = null;
  const listeners = [];

  function key() { return PREFIX + (userId || "anon"); }
  function blank() { return { profile: null, rdvs: {}, dirty: {}, presentation: null, presentationDirty: false }; }
  function read() {
    try { return Object.assign(blank(), JSON.parse(localStorage.getItem(key())) || {}); }
    catch (e) { return blank(); }
  }
  function write(c) { try { localStorage.setItem(key(), JSON.stringify(c)); } catch (e) { /* quota / privé */ } }
  function emit() { const s = status(); listeners.forEach(fn => { try { fn(s); } catch (e) {} }); }
  function status() { return { pending: RexOffline.pendingCount(), online: navigator.onLine }; }

  const RexOffline = {
    init(uid) { userId = uid; },
    onChange(fn) { listeners.push(fn); },

    hasCache(uid) { try { return !!localStorage.getItem(PREFIX + uid); } catch (e) { return false; } },
    cachedProfile() { return read().profile; },
    cacheProfile(p) {
      const c = read(); c.profile = p;
      if (c.presentation == null && p) c.presentation = p.presentation || "";
      write(c);
    },

    /* ---- RDV ---- */
    putLocal(r) { const c = read(); c.rdvs[r.id] = r; c.dirty[r.id] = true; write(c); emit(); },
    removeLocal(id) { const c = read(); delete c.rdvs[id]; delete c.dirty[id]; write(c); emit(); },
    markSynced(id) { const c = read(); if (c.dirty[id]) { delete c.dirty[id]; write(c); emit(); } },
    ownCachedRdvs() { return Object.values(read().rdvs || {}); },
    dirtyIds() { return Object.keys(read().dirty || {}); },
    pendingCount() { const c = read(); return Object.keys(c.dirty || {}).length + (c.presentationDirty ? 1 : 0); },

    // Fusionne les RDV du serveur avec le cache local (les versions locales
    // non synchronisées « dirty » ou créées hors ligne sont prioritaires).
    reconcile(serverRdvs, myId) {
      const c = read();
      const byId = {};
      (serverRdvs || []).forEach(r => { byId[r.id] = r; });
      // Le cache local (RDV de l'utilisateur) prime s'il est dirty ou absent du serveur.
      Object.values(c.rdvs).forEach(localR => {
        if (localR.author_id !== myId) return;
        if (c.dirty[localR.id] || !byId[localR.id]) byId[localR.id] = localR;
      });
      // Met à jour le cache avec les versions serveur propres (non dirty).
      (serverRdvs || []).forEach(r => { if (r.author_id === myId && !c.dirty[r.id]) c.rdvs[r.id] = r; });
      write(c);
      return Object.values(byId);
    },

    /* ---- Présentation ---- */
    getCachedPresentation() { const c = read(); return c.presentation != null ? c.presentation : (c.profile ? (c.profile.presentation || "") : ""); },
    putLocalPresentation(text) { const c = read(); c.presentation = text; c.presentationDirty = true; write(c); emit(); },
    markPresentationSynced() { const c = read(); c.presentationDirty = false; write(c); emit(); },

    /* ---- Synchronisation ---- */
    async flush() {
      const db = window.RexDB;
      if (!db || !navigator.onLine) { emit(); return { ok: 0, fail: this.pendingCount(), remaining: this.pendingCount() }; }
      let ok = 0, fail = 0;
      for (const id of this.dirtyIds()) {
        const r = read().rdvs[id];
        if (!r) { this.markSynced(id); continue; }
        try { await db.upsertRdv(r); this.markSynced(id); ok++; }
        catch (e) { fail++; }
      }
      if (read().presentationDirty) {
        try { await db.savePresentation(this.getCachedPresentation()); this.markPresentationSynced(); ok++; }
        catch (e) { fail++; }
      }
      emit();
      return { ok, fail, remaining: this.pendingCount() };
    }
  };

  window.RexOffline = RexOffline;

  // Retour / perte du réseau : on met à jour l'indicateur et on resynchronise.
  window.addEventListener("online", () => { emit(); if (window.RexDB && window.RexDB.me && window.RexDB.me()) RexOffline.flush(); });
  window.addEventListener("offline", emit);
})();
