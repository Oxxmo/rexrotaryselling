// ============================================================
//  Rex Commando — Edge Function « commando-notifier »
//  ------------------------------------------------------------
//  Envoie les notifications Web Push du commando (même bibliothèque
//  que Flash Live PO : jsr:@negrel/webpush).
//
//  Actions (corps JSON) :
//    { "action": "envoyer", "id": 123 }  — appel de la base (pg_net),
//        en-tête x-commando-secret = secret Vault « commando_cron_secret » ;
//    { "action": "cle" }                  — membre connecté (JWT) : clé
//        publique VAPID pour abonner l'appareil ;
//    { "action": "test" }                 — membre connecté : notification
//        d'essai sur ses propres appareils.
//
//  Clés VAPID : créées au premier appel et gardées dans Vault
//  (« commando_vapid ») ; la clé privée ne quitte jamais le serveur.
//  Abonnement expiré (404 / 410) : désactivé.
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-commando-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CONTACT = "https://oxxmo.github.io/rexrotaryselling/";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function base64Url(octets: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(octets)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Abonnement = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    let body: any = {};
    try { body = await req.json(); } catch { /* vide */ }
    const action = String(body?.action || "");

    // --- Qui appelle ? La base (secret Vault) ou un membre connecté (JWT).
    let interne = false;
    let membreId: string | null = null;
    const secret = req.headers.get("x-commando-secret") || "";
    if (secret) {
      const { data } = await admin.rpc("commando_cron_secret_ok", { _secret: secret });
      if (data !== true) return json({ error: "Secret invalide" }, 401);
      interne = true;
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
      if (!jwt) return json({ error: "Non authentifié" }, 401);
      const { data: u, error } = await admin.auth.getUser(jwt);
      if (error || !u?.user) return json({ error: "Session invalide" }, 401);
      const { data: m } = await admin.from("commando_membres").select("role").eq("user_id", u.user.id).maybeSingle();
      if (!m) return json({ error: "Réservé aux membres du commando." }, 403);
      membreId = u.user.id;
    }

    // --- Clés VAPID (créées une fois, gardées dans Vault).
    let { data: brut } = await admin.rpc("commando_vapid_lire");
    if (!brut) {
      const neuves = await webpush.generateVapidKeys({ extractable: true });
      const exportees = await webpush.exportVapidKeys(neuves);
      await admin.rpc("commando_vapid_creer", { _valeur: JSON.stringify(exportees) });
      ({ data: brut } = await admin.rpc("commando_vapid_lire"));   // relu : un autre appel a pu créer les clés en même temps
    }
    if (!brut) return json({ error: "Clés de notification indisponibles" }, 500);
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(String(brut)), { extractable: false });
    const clePublique = base64Url(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));

    if (action === "cle") return json({ cle: clePublique });

    const serveur = await webpush.ApplicationServer.new({ contactInformation: CONTACT, vapidKeys });
    async function envoyer(abonnements: Abonnement[], contenu: unknown) {
      const texte = JSON.stringify(contenu);
      let envoyes = 0, desactives = 0;
      const erreurs: string[] = [];
      for (const a of abonnements) {
        try {
          const cible = serveur.subscribe({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } });
          await cible.pushTextMessage(texte, { ttl: 3600, urgency: webpush.Urgency.High });
          envoyes++;
          await admin.from("commando_push").update({ dernier_ok_le: new Date().toISOString(), derniere_erreur: null }).eq("id", a.id);
        } catch (err) {
          const statut = (err as { response?: { status?: number } })?.response?.status;
          if (statut === 404 || statut === 410) {
            await admin.from("commando_push").update({ actif: false, derniere_erreur: "abonnement expiré (" + statut + ")" }).eq("id", a.id);
            desactives++;
          } else {
            const msg = String((err as Error)?.message || err).slice(0, 300);
            erreurs.push(msg);
            await admin.from("commando_push").update({ derniere_erreur: msg }).eq("id", a.id);
          }
        }
      }
      return { envoyes, desactives, erreurs };
    }

    // --- Essai : sur les appareils de l'appelant.
    if (action === "test") {
      if (!membreId) return json({ error: "Réservé aux membres connectés" }, 403);
      const { data: siens } = await admin.from("commando_push").select("id, user_id, endpoint, p256dh, auth").eq("user_id", membreId).eq("actif", true);
      if (!siens || !siens.length) return json({ error: "Aucun appareil abonné : activez d'abord les notifications." }, 400);
      const r = await envoyer(siens as Abonnement[], { title: "🔔 Notifications activées", body: "Vous serez prévenu des RDV de l'équipe, du vote et des listes prêtes.", url: "./#commando/liste", tag: "test" });
      await admin.from("commando_notifications").insert({ type: "test", titre: "Essai", corps: "Notification d'essai", cible: { users: [membreId] }, etat: r.envoyes ? "envoyee" : "echec", tentatives: 1, envoye_le: new Date().toISOString(), resultat: r });
      return json(r, r.envoyes ? 200 : 502);
    }

    // --- Envoi d'un message de la file (appel de la base).
    if (action === "envoyer") {
      if (!interne) return json({ error: "Appel non autorisé" }, 401);
      const id = Number(body?.id);
      const { data: n } = await admin.from("commando_notifications").select("*").eq("id", id).maybeSingle();
      if (!n) return json({ error: "Notification introuvable" }, 404);
      if (n.etat !== "en_attente") return json({ ignore: "déjà traitée" });
      const { data: dest, error: dErr } = await admin.rpc("commando_notif_destinataires", { _id: id });
      if (dErr) return json({ error: dErr.message }, 500);
      const liste = (dest || []) as Abonnement[];
      if (!liste.length) {
        await admin.from("commando_notifications").update({ etat: "sans_destinataire", envoye_le: new Date().toISOString(), resultat: { envoyes: 0 } }).eq("id", id);
        return json({ envoyes: 0 });
      }
      const r = await envoyer(liste, { title: n.titre, body: n.corps, url: n.url || "./#commando", tag: n.type + "-" + n.id });
      await admin.from("commando_notifications").update({
        etat: r.envoyes || r.desactives === liste.length ? "envoyee" : "echec",
        envoye_le: new Date().toISOString(), resultat: r,
      }).eq("id", id);
      return json(r);
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
