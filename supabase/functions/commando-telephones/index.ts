// ============================================================
//  Rex Commando — Edge Function « commando-telephones »
//  ------------------------------------------------------------
//  La base Sirene ne contient aucun numéro de téléphone. Cette fonction
//  les cherche GRATUITEMENT dans OpenStreetMap, en deux temps :
//
//   1. « rafraichir » : UNE requête Overpass pour toute la Vienne (tous les
//      lieux portant un téléphone « phone » ou « contact:phone »), stockée
//      dans commando_osm_lieux. Les serveurs publics Overpass sont souvent
//      saturés : on essaie trois serveurs en relais, et on ne refait cet
//      appel qu'une fois par semaine (pg_cron) ou à la demande. Les deux
//      tiers des lieux n'ont pas de code postal dans OSM : il est déduit de
//      leurs coordonnées par la Base Adresse Nationale (gratuite, « geocoder »).
//   2. « rapprocher » : rapprochement de nos entreprises avec ces lieux, par
//      nom (raison sociale ou enseigne, formes juridiques retirées) et numéro
//      de voie, sans aucun appel externe. Seules les fiches SANS téléphone
//      saisi par un commercial sont remplies.
//
//  Données © les contributeurs OpenStreetMap (ODbL) : la source est
//  enregistrée (commando_contacts.source = 'osm').
//
//  Corps JSON :
//    { "rafraichir": true }                 // met à jour le cache (responsable / cron)
//    { "geocoder": true }                   // complète les codes postaux manquants (inclus dans rafraichir)
//    { "rapprocher": true }                 // tous les codes postaux (responsable / cron)
//    { "codes_postaux": ["86000", …] }      // quelques codes (responsable)
//    { "siret": "…" }                       // une seule fiche (tout membre), renvoie « contact »
//  Les actions se combinent ({ rafraichir, rapprocher }).
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { normaliser, similarite, formaterTel, numeroVoie } from "../_shared/telephones.ts";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// Emprise de la Vienne (86), un peu large : sud, ouest, nord, est.
const BBOX = "46.0,-0.2,47.2,1.25";
// En-tête ASCII uniquement : un caractère accentué fait refuser la requête (HTTP 406).
const USER_AGENT = "RexSeller-Commando/1.0 (Rex-Rotary Poitiers; github.com/Oxxmo/rexrotaryselling)";
const BAN = "https://api-adresse.data.gouv.fr/reverse/csv/";
const BUDGET_MS = 120_000;        // limite d'exécution Supabase : 150 s ; on rend la main avant
const PAGE = 1000;                // plafond de lignes par réponse PostgREST
const ESSAI_MS = 40_000;          // par serveur
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-commando-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. Overpass : tous les lieux de la Vienne avec téléphone ----------
type Lieu = { id: string; nom: string; telephone: string; site_web: string | null; numero: string | null; code_postal: string | null; commune: string | null; lat: number | null; lon: number | null; cp_source: string | null };
async function lieuxVienne(echeance: number): Promise<Lieu[]> {
  const q = `[out:json][timeout:60][bbox:${BBOX}];(nwr["phone"];nwr["contact:phone"];);out center;`;
  let derniere = "";
  for (let essai = 0; essai < ENDPOINTS.length * 2; essai++) {
    const reste = echeance - Date.now();
    if (reste < 8000) break;
    const base = ENDPOINTS[essai % ENDPOINTS.length];
    const hote = new URL(base).hostname;
    try {
      // Pas d'en-tête Accept explicite : overpass-api.de répond 406 à « application/json ».
      const res = await fetch(base + "?data=" + encodeURIComponent(q), {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(Math.min(ESSAI_MS, reste - 3000)),
      });
      console.log(`[telephones] Overpass ${hote} → HTTP ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        return (data.elements || []).map((e: any) => {
          const t = e.tags || {};
          const c = e.center || e;              // nœud : lat/lon ; chemin ou relation : center
          const cp = t["addr:postcode"] ? String(t["addr:postcode"]).trim() : null;
          return {
            id: `${e.type}/${e.id}`,
            nom: String(t.name || t.brand || t.operator || "").trim(),
            telephone: String(t.phone || t["contact:phone"] || "").trim(),
            site_web: t.website || t["contact:website"] || null,
            numero: t["addr:housenumber"] ? String(t["addr:housenumber"]).toLowerCase() : null,
            code_postal: cp,
            commune: t["addr:city"] || null,
            lat: typeof c.lat === "number" ? c.lat : null,
            lon: typeof c.lon === "number" ? c.lon : null,
            cp_source: cp ? "osm" : null,
          } as Lieu;
        }).filter((l: Lieu) => l.nom && l.telephone);
      }
      await res.text();
      derniere = `HTTP ${res.status} sur ${hote}`;
      if (res.status === 400) throw new Error("Requête Overpass refusée : " + derniere);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Requête Overpass")) throw e;
      derniere = `${(e as Error).name === "TimeoutError" ? "délai dépassé" : (e as Error).message} sur ${hote}`;
      console.log(`[telephones] Overpass ${derniere}`);
    }
    await dormir(1000);
  }
  throw new Error("Serveurs OpenStreetMap (Overpass) saturés pour le moment, réessayez plus tard : " + derniere);
}

// ---------- 1 bis. Base Adresse Nationale : code postal depuis les coordonnées ----------
//  Géocodage inverse en masse (CSV), gratuit et sans clé : api-adresse.data.gouv.fr.
function lireCsv(texte: string): string[][] {
  const lignes: string[][] = []; let champ = "", ligne: string[] = [], guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const ch = texte[i];
    if (guillemets) {
      if (ch === '"') { if (texte[i + 1] === '"') { champ += '"'; i++; } else guillemets = false; }
      else champ += ch;
    } else if (ch === '"') guillemets = true;
    else if (ch === ",") { ligne.push(champ); champ = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && texte[i + 1] === "\n") i++; ligne.push(champ); lignes.push(ligne); ligne = []; champ = ""; }
    else champ += ch;
  }
  if (champ.length || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  return lignes.filter(l => l.length > 1 || (l.length === 1 && l[0] !== ""));
}
async function geocoderInverse(points: { id: string; lat: number; lon: number }[], echeance: number): Promise<Map<string, { code_postal: string; commune: string | null }>> {
  const resultat = new Map<string, { code_postal: string; commune: string | null }>();
  for (let i = 0; i < points.length; i += 1000) {
    const reste = echeance - Date.now();
    if (reste < 8000) break;
    const lot = points.slice(i, i + 1000);
    const csv = "id,latitude,longitude\n" + lot.map(p => `${p.id},${p.lat},${p.lon}`).join("\n") + "\n";
    const fd = new FormData();
    fd.append("data", new Blob([csv], { type: "text/csv" }), "points.csv");
    fd.append("result_columns", "result_postcode");
    fd.append("result_columns", "result_city");
    try {
      const res = await fetch(BAN, { method: "POST", body: fd, headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(Math.min(40_000, reste - 3000)) });
      console.log(`[telephones] BAN lot ${i / 1000 + 1} → HTTP ${res.status}`);
      if (!res.ok) { await res.text(); continue; }
      const lignes = lireCsv(await res.text());
      const entete = lignes.shift() || [];
      const iId = entete.indexOf("id"), iCp = entete.indexOf("result_postcode"), iVille = entete.indexOf("result_city");
      if (iId < 0 || iCp < 0) continue;
      for (const l of lignes) {
        const cp = (l[iCp] || "").trim();
        if (/^\d{5}$/.test(cp)) resultat.set(l[iId], { code_postal: cp, commune: iVille >= 0 ? (l[iVille] || null) : null });
      }
    } catch (e) { console.log(`[telephones] BAN : ${(e as Error).message}`); }
  }
  return resultat;
}

// ---------- 2. Rapprochement ----------
type Poi = Lieu & { tokens: string[] };
type Ent = { siret: string; raison_sociale: string; enseigne: string | null; adresse: string | null; code_postal: string };
function meilleurPoi(e: Ent, pois: Poi[]): { poi: Poi; score: number; exact: boolean } | null {
  const noms = [e.raison_sociale, e.enseigne].filter(Boolean).map(n => normaliser(String(n)));
  const num = numeroVoie(e.adresse || "");
  let best: { poi: Poi; score: number; exact: boolean } | null = null;
  for (const p of pois) {
    if (!p.tokens.length) continue;
    for (const n of noms) {
      if (!n.length) continue;
      const exact = n.join(" ") === p.tokens.join(" ");
      let score = exact ? 1 : similarite(n, p.tokens);
      if (!exact && num && p.numero && num === p.numero && score >= 0.34) score = Math.max(score, 0.7);
      if (!exact && n.length >= 2 && p.tokens.length >= 2 && (n.join(" ").includes(p.tokens.join(" ")) || p.tokens.join(" ").includes(n.join(" ")))) score = Math.max(score, 0.65);
      if (!best || score > best.score) best = { poi: p, score, exact };
    }
  }
  return best && (best.exact || best.score >= 0.6) ? best : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const debut = Date.now();
  const echeance = debut + BUDGET_MS;

  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }

  // --- Autorisation ---
  let role: "cron" | "responsable" | "commercial";
  const secret = req.headers.get("x-commando-secret") || "";
  if (secret) {
    const { data } = await admin.rpc("commando_cron_secret_ok", { _secret: secret });
    if (data !== true) return json({ error: "Secret invalide" }, 401);
    role = "cron";
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Non authentifié" }, 401);
    const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !userData?.user) return json({ error: "Session invalide" }, 401);
    const { data: membre } = await admin.from("commando_membres").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (!membre) return json({ error: "Réservé aux membres du commando." }, 403);
    role = membre.role === "responsable" ? "responsable" : "commercial";
  }
  const sortie: any = { attribution: "Données © les contributeurs OpenStreetMap (ODbL)" };

  // --- 1. Rafraîchir le cache des lieux ---
  if (body?.rafraichir === true) {
    if (role === "commercial") return json({ error: "Réservé au responsable." }, 403);
    let lieux: Lieu[];
    try { lieux = await lieuxVienne(echeance); }
    catch (e) { return json({ error: (e as Error).message }, 503); }
    const maj = new Date().toISOString();
    // Les codes postaux déjà déduits par la BAN sont conservés (pas de nouvel appel).
    const connus = new Map<string, { code_postal: string; commune: string | null }>();
    for (let depuis = 0; ; depuis += PAGE) {
      const { data } = await admin.from("commando_osm_lieux").select("id, code_postal, commune").eq("cp_source", "ban").range(depuis, depuis + PAGE - 1);
      (data || []).forEach((r: any) => connus.set(r.id, { code_postal: r.code_postal, commune: r.commune }));
      if (!data || data.length < PAGE) break;
    }
    for (const l of lieux) {
      const k = !l.code_postal && connus.get(l.id);
      if (k) { l.code_postal = k.code_postal; l.commune = l.commune || k.commune; l.cp_source = "ban"; }
    }
    for (let i = 0; i < lieux.length; i += 500) {
      const { error } = await admin.from("commando_osm_lieux").upsert(lieux.slice(i, i + 500).map(l => ({ ...l, maj_le: maj })), { onConflict: "id" });
      if (error) return json({ error: "Enregistrement des lieux : " + error.message }, 500);
    }
    // Les lieux disparus d'OpenStreetMap sont retirés du cache.
    await admin.from("commando_osm_lieux").delete().lt("maj_le", maj);
    sortie.rafraichi = { lieux: lieux.length, avec_code_postal: lieux.filter(l => l.code_postal).length, maj_le: maj };
  }

  // --- 1 bis. Codes postaux manquants déduits des coordonnées (BAN) ---
  if (body?.rafraichir === true || body?.geocoder === true) {
    if (role === "commercial") return json({ error: "Réservé au responsable." }, 403);
    const points: { id: string; lat: number; lon: number }[] = [];
    for (let depuis = 0; ; depuis += PAGE) {
      const { data } = await admin.from("commando_osm_lieux").select("id, lat, lon").is("code_postal", null).not("lat", "is", null).range(depuis, depuis + PAGE - 1);
      (data || []).forEach((r: any) => points.push({ id: r.id, lat: r.lat, lon: r.lon }));
      if (!data || data.length < PAGE) break;
    }
    const trouves = await geocoderInverse(points, echeance);
    let n = 0;
    for (const [id, v] of trouves) {
      const { error } = await admin.from("commando_osm_lieux").update({ code_postal: v.code_postal, commune: v.commune, cp_source: "ban" }).eq("id", id);
      if (!error) n++;
    }
    sortie.geocode = { sans_code_postal: points.length, completes: n };
  }

  // --- 2. Périmètre du rapprochement ---
  let codes: string[] = [];
  const siretCible: string | null = body?.siret ? String(body.siret) : null;
  if (siretCible) {
    const { data: e } = await admin.from("commando_entreprises").select("code_postal").eq("siret", siretCible).maybeSingle();
    if (!e) return json({ error: "Entreprise introuvable" }, 404);
    codes = [e.code_postal];
  } else if (body?.rapprocher === true) {
    if (role === "commercial") return json({ error: "Réservé au responsable." }, 403);
    const { data } = await admin.from("commando_codes_postaux").select("code_postal").order("code_postal");
    codes = (data || []).map((c: any) => String(c.code_postal));
  } else if (Array.isArray(body?.codes_postaux)) {
    if (role === "commercial") return json({ error: "Réservé au responsable." }, 403);
    codes = body.codes_postaux.map((c: unknown) => String(c).trim()).filter(Boolean);
  }
  if (!codes.length) {
    if (!sortie.rafraichi && !sortie.geocode) return json({ error: "Rien à faire : indiquez rafraichir, rapprocher, codes_postaux ou siret" }, 400);
    sortie.duree_ms = Date.now() - debut;
    return json(sortie);
  }

  // État du cache
  const { data: etat } = await admin.from("commando_osm_lieux").select("maj_le").order("maj_le", { ascending: false }).limit(1);
  if (!etat || !etat.length) return json({ error: "Aucun lieu OpenStreetMap en cache : lancez d'abord la mise à jour (rafraichir)." }, 409);
  sortie.cache_maj_le = etat[0].maj_le;

  const rapport: Record<string, any> = {};
  const nonTraites: string[] = [];
  let total = 0, totalPois = 0;
  for (const [i, cp] of codes.entries()) {
    if (Date.now() > echeance - 10_000) { nonTraites.push(...codes.slice(i)); break; }
    try {
      const { data: lieux, error: lErr } = await admin.from("commando_osm_lieux").select("id, nom, telephone, site_web, numero, code_postal, commune").eq("code_postal", cp);
      if (lErr) throw new Error("Lecture des lieux : " + lErr.message);
      const pois: Poi[] = (lieux || []).map((l: any) => ({ ...l, tokens: normaliser(l.nom) }));
      totalPois += pois.length;
      const ents: Ent[] = [];
      for (let depuis = 0; ; depuis += PAGE) {
        let q = admin.from("commando_entreprises").select("siret, raison_sociale, enseigne, adresse, code_postal").eq("code_postal", cp).is("archived_at", null).order("siret").range(depuis, depuis + PAGE - 1);
        if (siretCible) q = q.eq("siret", siretCible);
        const { data, error } = await q;
        if (error) throw new Error("Lecture des entreprises : " + error.message);
        ents.push(...((data || []) as Ent[]));
        if (!data || data.length < PAGE) break;
      }
      const sirets = ents.map((e) => e.siret);
      const dejaTel = new Set<string>();
      for (let j = 0; j < sirets.length; j += 500) {
        const { data: contacts } = await admin.from("commando_contacts").select("siret, telephone").in("siret", sirets.slice(j, j + 500));
        (contacts || []).filter((c: any) => c.telephone).forEach((c: any) => dejaTel.add(c.siret));
      }
      const utilises = new Set<string>();
      const lignes: any[] = [];
      let candidates = 0;
      for (const e of ents) {
        if (dejaTel.has(e.siret)) continue;
        candidates++;
        const m = meilleurPoi(e, pois.filter(p => !utilises.has(p.id)));
        if (!m) continue;
        const tel = formaterTel(m.poi.telephone);
        if (!tel) continue;
        utilises.add(m.poi.id);
        lignes.push({ siret: e.siret, telephone: tel, site_web: m.poi.site_web, source: "osm", source_detail: `OpenStreetMap ${m.poi.id} « ${m.poi.nom} » (score ${m.score.toFixed(2)})` });
      }
      if (lignes.length) {
        const { error } = await admin.from("commando_contacts").upsert(lignes, { onConflict: "siret" });
        if (error) throw new Error("Enregistrement : " + error.message);
      }
      total += lignes.length;
      rapport[cp] = { lieux_osm: pois.length, sans_telephone: candidates, trouves: lignes.length, exemples: lignes.slice(0, 3).map(l => ({ siret: l.siret, telephone: l.telephone, detail: l.source_detail })) };
    } catch (e) {
      rapport[cp] = { erreur: (e as Error).message };
    }
  }
  Object.assign(sortie, { trouves: total, lieux_osm: totalPois, duree_ms: Date.now() - debut, par_code_postal: rapport, non_traites: nonTraites });
  if (siretCible) {
    const { data: c } = await admin.from("commando_contacts").select("telephone, site_web, source, source_detail").eq("siret", siretCible).maybeSingle();
    sortie.contact = c || null;
  }
  return json(sortie);
});
