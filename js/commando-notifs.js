/* ============================================================
   Rex Commando — notifications sur le téléphone (Web Push)
   ------------------------------------------------------------
   Même principe que Flash Live PO : l'appareil s'abonne avec la
   clé publique du serveur (Edge Function « commando-notifier »),
   la base enregistre l'abonnement (commando_push_abonner) et
   envoie les messages : RDV de l'équipe, vote ouvert, rappel de
   vote, listes prêtes, début du commando, veille terminée.

   Affichage : un encart dans « Ma liste » et dans le cockpit de
   la semaine — « Activer » tant que l'appareil n'est pas abonné,
   puis une ligne discrète « Tester · Désactiver ».
   Sur iPhone, Safari n'autorise les notifications qu'une fois
   l'app ajoutée à l'écran d'accueil (iOS 16.4 et plus).
   ============================================================ */
(function () {
  "use strict";
  const C = () => window.RexCommando;
  const MASQUE = "rexCommandoNotifsPlusTard";
  const boites = new Set();
  let dernierEtat = null;
  let resynchro = false;

  function supporte() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  function estIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function estInstallee() {
    try { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch (e) { return false; }
  }
  function appareil() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
      : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Appareil";
    const nav = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return os + (nav ? " · " + nav : "") + (estInstallee() ? " · app" : "");
  }
  function octets(b64url) {
    const b64 = (b64url + "=".repeat((4 - b64url.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    const brut = atob(b64);
    const out = new Uint8Array(brut.length);
    for (let i = 0; i < brut.length; i++) out[i] = brut.charCodeAt(i);
    return out;
  }
  function plusTard() {
    try { return Number(localStorage.getItem(MASQUE) || 0) > Date.now(); } catch (e) { return false; }
  }
  function masquer(jours) {
    try { localStorage.setItem(MASQUE, String(Date.now() + jours * 86400000)); } catch (e) { /* stockage indisponible */ }
  }
  async function enregistrement() {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register("sw.js");
    return reg;
  }
  async function abonnementActuel() {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function enregistrer(sub) {
    const j = sub.toJSON();
    return C().rpc("commando_push_abonner", { _endpoint: j.endpoint, _p256dh: j.keys.p256dh, _auth: j.keys.auth, _ua: appareil() });
  }

  // ios : iPhone pas encore installé · non : navigateur sans notifications
  // bloque : refusées dans les réglages · inactif : à activer · actif : abonné
  async function etat() {
    if (!supporte()) return estIOS() && !estInstallee() ? "ios" : "non";
    if (Notification.permission === "denied") return "bloque";
    const sub = await abonnementActuel();
    return sub && Notification.permission === "granted" ? "actif" : "inactif";
  }

  function html(e) {
    const esc = C().esc;
    if (e === "actif") {
      return `<div class="cmd-notifs cmd-notifs--ok">
          <span>🔔 Notifications activées sur cet appareil</span>
          <span class="cmd-notifs__act"><button class="btn btn--ghost btn--sm" data-notif="tester">Tester</button><button class="btn btn--ghost btn--sm" data-notif="couper">Désactiver</button></span>
        </div>`;
    }
    if (plusTard()) return "";
    if (e === "inactif") {
      return `<div class="cmd-notifs">
          <div class="cmd-notifs__titre">🔔 Soyez prévenu en direct</div>
          <div class="cmd-notifs__liste">🎉 les RDV de l'équipe · 🗳️ l'ouverture du vote · 📋 vos listes prêtes · ⏰ le début du commando</div>
          <div class="cmd-notifs__act"><button class="btn btn--primary btn--sm" data-notif="activer">Activer les notifications</button><button class="btn btn--ghost btn--sm" data-notif="tard">Plus tard</button></div>
        </div>`;
    }
    if (e === "ios") {
      return `<div class="cmd-notifs">
          <div class="cmd-notifs__titre">🔔 Notifications sur iPhone</div>
          <ol class="cmd-notifs__etapes">
            <li>Dans Safari, touchez <b>Partager</b> <span aria-hidden="true">⬆️</span> puis <b>Sur l'écran d'accueil</b>.</li>
            <li>Ouvrez Rex Seller <b>depuis l'icône</b> et revenez ici.</li>
            <li>Touchez <b>Activer les notifications</b>.</li>
          </ol>
          <div class="cmd-notifs__act"><button class="btn btn--ghost btn--sm" data-notif="tard">Plus tard</button></div>
        </div>`;
    }
    if (e === "bloque") {
      return `<div class="cmd-notifs cmd-notifs--off">
          <span>🔕 Notifications bloquées : autorisez-les pour ${esc(location.host)} dans les réglages du téléphone ou du navigateur.</span>
          <span class="cmd-notifs__act"><button class="btn btn--ghost btn--sm" data-notif="tard">OK</button></span>
        </div>`;
    }
    return "";
  }

  function dessiner(box, e) {
    box.innerHTML = html(e);
    box.querySelectorAll("[data-notif]").forEach(b => b.addEventListener("click", () => agir(b.dataset.notif, b)));
  }
  async function rafraichir() {
    let e;
    try { e = await etat(); } catch (err) { e = "non"; }
    dernierEtat = e;
    boites.forEach(b => { if (b.isConnected) dessiner(b, e); else boites.delete(b); });
    if (e === "actif" && !resynchro) {
      // Une fois par ouverture : la base garde l'abonnement à jour (il peut changer).
      resynchro = true;
      abonnementActuel().then(sub => sub && enregistrer(sub)).catch(() => { /* réessayé à la prochaine ouverture */ });
    }
  }

  async function agir(action, btn) {
    const libelle = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      if (action === "activer") {
        // La demande d'autorisation doit venir directement du toucher (iPhone).
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          throw new Error(perm === "denied"
            ? "Notifications refusées : autorisez-les dans les réglages du téléphone."
            : "Autorisation non donnée.");
        }
        const { cle } = await C().fn("commando-notifier", { action: "cle" });
        const reg = await enregistrement();
        const ancien = await reg.pushManager.getSubscription();
        if (ancien) await ancien.unsubscribe().catch(() => {});
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: octets(cle) });
        await enregistrer(sub);
        resynchro = true;
        C().toast("🔔 Notifications activées");
        C().fn("commando-notifier", { action: "test" }).catch(() => { /* l'essai est facultatif */ });
      } else if (action === "tester") {
        const r = await C().fn("commando-notifier", { action: "test" });
        C().toast(r && r.envoyes ? "Notification envoyée : regardez votre écran." : "Envoi impossible, réessayez.");
      } else if (action === "couper") {
        const sub = await abonnementActuel();
        if (sub) {
          await C().rpc("commando_push_desabonner", { _endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe().catch(() => {});
        }
        C().toast("🔕 Notifications désactivées sur cet appareil");
      } else if (action === "tard") {
        masquer(7);
      }
    } catch (err) {
      C().toast(C().erreur(err));
    } finally {
      btn.disabled = false; btn.textContent = libelle;
      await rafraichir();
    }
  }

  // Point d'entrée : un conteneur dans Ma liste ou le cockpit.
  function rendre(box) {
    if (!box || !C()) return;
    boites.add(box);
    if (dernierEtat) dessiner(box, dernierEtat);
    rafraichir();
  }

  // Clic sur une notification alors que l'app est déjà ouverte :
  // le service worker demande d'aller sur l'onglet visé.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data || {};
      if (d.type !== "commando-ouvrir" || !C() || !C().role()) return;
      const m = /#commando(?:\/([\w-]+))?/.exec(d.url || "");
      if (m) C().open(m[1] || null);
    });
  }
  // Retour dans l'app (après les réglages du téléphone) : on relit l'état.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && boites.size) rafraichir(); });

  window.RexCommandoNotifs = { rendre, etat };
})();
