// ============================================================
//  Rex Commando — Edge Function « commando-telephones »
//  ------------------------------------------------------------
//  La base Sirene ne contient aucun numéro de téléphone. Cette fonction
//  les cherche GRATUITEMENT dans OpenStreetMap (API Overpass) : pour un
//  code postal, tous les lieux portant un téléphone (« phone » ou
//  « contact:phone »), puis rapprochement avec nos entreprises par nom
//  (raison sociale ou enseigne, formes juridiques retirées) et numéro de
//  voie. Seules les fiches SANS téléphone saisi par un commercial sont
//  remplies. Données © les contributeurs OpenStreetMap (ODbL) : la source
//  est enregistrée (commando_contacts.source = 'osm').
//
//  Corps JSON :
//    { "codes_postaux": ["86000", …] }   // par lots (au plus 10 par appel)
//    { "siret": "…" }                     // une seule fiche (depuis la fiche)
//
//  Appel : responsable (lots) ou membre (une fiche), par JWT ; ou secret
//  partagé pg_cron. Overpass : 1 requête par seconde au plus.
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { normaliser, similarite, formaterTel, numeroVoie } from "../_shared/telephones.ts";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "RexSeller-Commando/1.0 (Rex-Rotary Poitiers ; rapprochement de téléphones d'entreprises)";
const MAX_CP = 10;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-commando-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Overpass ----------
type Poi = { nom: string; tel: string; site: string | null; numero: string | null; id: string; tokens: string[] };
async function poisDuCodePostal(cp: string): Promise<Poi[]> {
  const q = `[out:json][timeout:60];(nwr["addr:postcode"="${cp}"]["phone"];nwr["addr:postcode"="${cp}"]["contact:phone"];);out tags;`;
  for (let essai = 1; essai <= 3; essai++) {
    const res = await fetch(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT }, body: "data=" + encodeURIComponent(q) });
    if (res.status === 429 || res.status === 504 || res.status === 502) { await res.text(); await dormir(3000 * essai); continue; }
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();
    return (data.elements || []).map((e: any) => {
      const t = e.tags || {};
      const nom = t.name || t["brand"] || t["operator"] || "";
      const tel = t.phone || t["contact:phone"] || "";
      return { id: `${e.type}/${e.id}`, nom, tel, site: t.website || t["contact:website"] || null, numero: t["addr:housenumber"] ? String(t["addr:housenumber"]).toLowerCase() : null, tokens: normaliser(nom) };
    }).filter((p: Poi) => p.nom && p.tel);
  }
  throw new Error("Overpass indisponible (trop de tentatives)");
}

// ---------- Rapprochement ----------
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

  // --- Périmètre ---
  let codes: string[] = [];
  let siretCible: string | null = body?.siret ? String(body.siret) : null;
  if (siretCible) {
    const { data: e } = await admin.from("commando_entreprises").select("code_postal").eq("siret", siretCible).maybeSingle();
    if (!e) return json({ error: "Entreprise introuvable" }, 404);
    codes = [e.code_postal];
  } else {
    if (role === "commercial") return json({ error: "Réservé au responsable (recherche par lots)." }, 403);
    codes = Array.isArray(body?.codes_postaux) ? body.codes_postaux.map((c: unknown) => String(c).trim()).filter(Boolean) : [];
    if (!codes.length) return json({ error: "codes_postaux manquants" }, 400);
    if (codes.length > MAX_CP) return json({ error: `Au plus ${MAX_CP} codes postaux par appel` }, 400);
  }

  const rapport: Record<string, any> = {};
  let total = 0, totalPois = 0;
  const debut = Date.now();
  for (const cp of codes) {
    try {
      const pois = await poisDuCodePostal(cp);
      totalPois += pois.length;
      let q = admin.from("commando_entreprises").select("siret, raison_sociale, enseigne, adresse, code_postal").eq("code_postal", cp).is("archived_at", null);
      if (siretCible) q = q.eq("siret", siretCible);
      const { data: ents } = await q;
      const sirets = (ents || []).map((e: any) => e.siret);
      const { data: contacts } = sirets.length ? await admin.from("commando_contacts").select("siret, telephone, source").in("siret", sirets) : { data: [] as any[] };
      const dejaTel = new Set((contacts || []).filter((c: any) => c.telephone).map((c: any) => c.siret));
      const utilises = new Set<string>();
      const lignes: any[] = [];
      let candidates = 0;
      for (const e of (ents || []) as Ent[]) {
        if (dejaTel.has(e.siret)) continue;
        candidates++;
        const m = meilleurPoi(e, pois.filter(p => !utilises.has(p.id)));
        if (!m) continue;
        const tel = formaterTel(m.poi.tel);
        if (!tel) continue;
        utilises.add(m.poi.id);
        lignes.push({ siret: e.siret, telephone: tel, site_web: m.poi.site, source: "osm", source_detail: `OpenStreetMap ${m.poi.id} « ${m.poi.nom} » (score ${m.score.toFixed(2)})` });
      }
      if (lignes.length) {
        const { error } = await admin.from("commando_contacts").upsert(lignes, { onConflict: "siret" });
        if (error) throw new Error("Enregistrement : " + error.message);
      }
      total += lignes.length;
      rapport[cp] = { pois_osm: pois.length, sans_telephone: candidates, trouves: lignes.length, exemples: lignes.slice(0, 3).map(l => ({ siret: l.siret, telephone: l.telephone, detail: l.source_detail })) };
    } catch (e) {
      rapport[cp] = { erreur: (e as Error).message };
    }
    if (codes.length > 1) await dormir(1100);   // courtoisie Overpass : 1 requête par seconde
  }
  const sortie: any = { trouves: total, pois_osm: totalPois, duree_ms: Date.now() - debut, par_code_postal: rapport, attribution: "Données © les contributeurs OpenStreetMap (ODbL)" };
  if (siretCible) {
    const { data: c } = await admin.from("commando_contacts").select("telephone, site_web, source, source_detail").eq("siret", siretCible).maybeSingle();
    sortie.contact = c || null;
  }
  return json(sortie);
});
