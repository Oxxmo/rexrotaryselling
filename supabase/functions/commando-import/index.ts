// ============================================================
//  Rex Commando — Edge Function « commando-import »
//  ------------------------------------------------------------
//  Met à jour la base d'entreprises du commando à partir de l'API
//  Recherche d'entreprises (api.gouv.fr, gratuite, sans clé).
//
//  Déclencheurs :
//    * pg_cron (dimanche soir) : en-tête « x-commando-secret » égal au
//      secret Vault « commando_cron_secret » (ou au secret de fonction
//      COMMANDO_CRON_SECRET, facultatif) ;
//    * la console (responsable) : JWT Supabase, rôle vérifié en base.
//
//  Corps (JSON, tous facultatifs) :
//    { "codes_postaux": ["86000"],   // périmètre réduit (test, reprise)
//      "dry_run": true,              // compteurs sans écriture
//      "synchrone": true }           // attendre le rapport (sinon 202)
//
//  Idempotent : relancé deux fois, il ne crée aucun doublon (clé SIRET).
//  Les établissements non revus sont archivés, jamais supprimés.
//
//  Limites de l'API respectées : 25 résultats par page, 7 requêtes/s
//  par IP (on reste à ~4/s), HTTP 429 avec Retry-After.
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API_URL = "https://recherche-entreprises.api.gouv.fr/search";
const USER_AGENT = "RexSeller-Commando/1.0 (Rex-Rotary Poitiers ; commando d'appels hebdomadaire)";
const PER_PAGE = 25;
const MAX_PAGES = 400;            // garde-fou : l'API plafonne à 10 000 résultats par requête
const MIN_INTERVAL_MS = 260;      // ≈ 3,8 requêtes/s
const LOT_UPSERT = 500;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-commando-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Comparaison en temps constant (secret du cron).
function memeSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Date du jour à Paris (AAAA-MM-JJ) et semaine ISO « cible » : l'import du
// dimanche prépare la semaine qui commence le lendemain.
function dateParis(): Date {
  const s = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
  return new Date(s + "T12:00:00Z");
}
function semaineIso(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const jour = t.getUTCDay() || 7;                 // lundi = 1 … dimanche = 7
  t.setUTCDate(t.getUTCDate() + 4 - jour);         // jeudi de la semaine ISO
  const debutAnnee = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const semaine = Math.ceil(((t.getTime() - debutAnnee.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(semaine).padStart(2, "0")}`;
}
function semaineCible(): string {
  const d = dateParis();
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return semaineIso(d);
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Client HTTP de l'API, avec cadence et reprises ----------
class ApiClient {
  requetes = 0;
  private dernier = 0;
  async get(params: Record<string, string>): Promise<any> {
    const url = API_URL + "?" + new URLSearchParams(params).toString();
    for (let essai = 1; essai <= 6; essai++) {
      const attente = this.dernier + MIN_INTERVAL_MS - Date.now();
      if (attente > 0) await dormir(attente);
      this.dernier = Date.now();
      this.requetes++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
      } catch (e) {
        if (essai === 6) throw new Error("Réseau : " + (e as Error).message);
        await dormir(1000 * essai);
        continue;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get("Retry-After")) || 2;
        await res.text();
        await dormir(Math.min(ra, 30) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await res.text();
        if (essai === 6) throw new Error(`API indisponible (HTTP ${res.status})`);
        await dormir(1500 * essai);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`API HTTP ${res.status} : ${txt.slice(0, 300)}`);
      }
      return await res.json();
    }
    throw new Error("API : trop de tentatives");
  }
}

// ---------- Compteurs ----------
type Exclusions = Record<string, number>;
type CompteurSecteur = {
  vues: number; importees: number; ajoutees: number; reactivees: number; mises_a_jour: number;
  archivees: number; clients: number; effectif_non_renseigne: number; exclues: Exclusions;
};
const nouveauCompteur = (): CompteurSecteur => ({
  vues: 0, importees: 0, ajoutees: 0, reactivees: 0, mises_a_jour: 0, archivees: 0, clients: 0,
  effectif_non_renseigne: 0, exclues: {},
});
function exclure(c: CompteurSecteur, raison: string) { c.exclues[raison] = (c.exclues[raison] || 0) + 1; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET = Deno.env.get("COMMANDO_CRON_SECRET") || "";
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- Qui appelle ? ---
  let declencheur: "cron" | "manuel";
  let lancePar: string | null = null;
  const secret = req.headers.get("x-commando-secret") || "";
  let secretOk = Boolean(secret && CRON_SECRET && memeSecret(secret, CRON_SECRET));
  if (secret && !secretOk) {
    // Secret partagé lu dans Vault (source unique, pas de secret de fonction à poser).
    const { data } = await admin.rpc("commando_cron_secret_ok", { _secret: secret });
    secretOk = data === true;
  }
  if (secretOk) {
    declencheur = "cron";
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Non authentifié" }, 401);
    const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !userData?.user) return json({ error: "Session invalide" }, 401);
    const { data: membre } = await admin.from("commando_membres").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (!membre || membre.role !== "responsable") return json({ error: "Réservé au responsable du commando." }, 403);
    declencheur = "manuel";
    lancePar = userData.user.id;
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* corps vide */ }
  const dryRun = body?.dry_run === true;

  // --- Périmètre et paramètres ---
  const { data: params, error: pErr } = await admin.from("commando_parametres").select("*").eq("id", true).single();
  if (pErr || !params) return json({ error: "Paramètres introuvables" }, 500);
  const { data: cps } = await admin.from("commando_codes_postaux").select("code_postal, secteur_code");
  const secteurParCp = new Map<string, string>((cps || []).map((c: any) => [c.code_postal, c.secteur_code]));
  let codes = Array.from(secteurParCp.keys()).sort();
  if (Array.isArray(body?.codes_postaux) && body.codes_postaux.length) {
    const demandes = body.codes_postaux.map((c: unknown) => String(c).trim());
    const inconnus = demandes.filter((c: string) => !secteurParCp.has(c));
    if (inconnus.length) return json({ error: "Codes postaux hors de la liste du commando : " + inconnus.join(", ") }, 400);
    codes = demandes;
  }
  if (!codes.length) return json({ error: "Aucun code postal paramétré." }, 400);

  const { data: clientsRows } = await admin.from("commando_clients_siren").select("siren");
  const clients = new Set<string>((clientsRows || []).map((r: any) => r.siren));
  const { count: nbExistantes } = await admin.from("commando_entreprises").select("siret", { count: "exact", head: true });
  const initial = !dryRun && (nbExistantes || 0) === 0;
  const tranchesIncluses = new Set<string>(params.tranches_incluses || ["02", "03", "11", "12"]);
  const inclureInconnu = params.inclure_effectif_inconnu === true;
  const semaine = semaineCible();
  const synchrone = body?.synchrone === true || dryRun || codes.length <= 3;

  // --- Ligne de rapport ---
  const { data: imp, error: iErr } = await admin.from("commando_imports").insert({
    declencheur, dry_run: dryRun, initial, codes_postaux: codes, semaine_cible: semaine, lance_par: lancePar,
  }).select("id, lance_le").single();
  if (iErr || !imp) return json({ error: "Création du rapport impossible : " + (iErr?.message || "") }, 500);

  // --- Le travail proprement dit ---
  const run = async () => {
    const debut = Date.now();
    const api = new ApiClient();
    const parSecteur: Record<string, CompteurSecteur> = {};
    const compteur = (sect: string) => (parSecteur[sect] ||= nouveauCompteur());
    const anomalies: any[] = [];
    let unitesLegales = 0;
    let erreur: string | null = null;

    // Tranches demandées à l'API : celles de l'unité légale (seul filtre
    // disponible) ; « NN » ajoute les unités sans effectif renseigné.
    const tranchesQuery = Array.from(tranchesIncluses).concat(inclureInconnu ? ["NN"] : []).join(",");

    try {
      for (const cp of codes) {
        const sect = secteurParCp.get(cp)!;
        const c = compteur(sect);
        const lignes = new Map<string, any>();   // siret → ligne (dédoublonnage)
        let page = 1, totalPages = 1;
        do {
          const rep = await api.get({
            code_postal: cp, etat_administratif: "A", tranche_effectif_salarie: tranchesQuery,
            minimal: "true", include: "siege,dirigeants,matching_etablissements",
            limite_matching_etablissements: "100", per_page: String(PER_PAGE), page: String(page),
          });
          totalPages = Number(rep.total_pages) || 1;
          const results: any[] = Array.isArray(rep.results) ? rep.results : [];
          if (!results.length) break;
          unitesLegales += results.length;

          for (const ul of results) {
            const etabs: any[] = Array.isArray(ul.matching_etablissements) ? ul.matching_etablissements : [];
            for (const et of etabs) {
              const cpEtab = String(et.code_postal || "");
              if (!secteurParCp.has(cpEtab)) {
                anomalies.push({ type: "code_postal_inconnu", siret: et.siret, code_postal: cpEtab, raison_sociale: ul.nom_complet });
                continue;
              }
              const cc = compteur(secteurParCp.get(cpEtab)!);
              cc.vues++;
              if (et.etat_administratif !== "A") { exclure(cc, "ferme"); continue; }
              if (et.statut_diffusion_etablissement === "P") { exclure(cc, "diffusion_partielle"); continue; }

              // Effectif retenu : établissement, sinon unité légale mono-établissement.
              let tranche: string | null = null, source: string | null = null, annee: number | null = null;
              const te = et.tranche_effectif_salarie;
              const tu = ul.tranche_effectif_salarie;
              const ouverts = Number(ul.nombre_etablissements_ouverts ?? 1);
              if (te && te !== "NN") { tranche = te; source = "etablissement"; annee = Number(et.annee_tranche_effectif_salarie) || null; }
              else if (ouverts <= 1 && tu && tu !== "NN") { tranche = tu; source = "unite_legale"; annee = Number(ul.annee_tranche_effectif_salarie) || null; }

              if (!tranche) {
                cc.effectif_non_renseigne++;
                if (!inclureInconnu) { exclure(cc, "effectif_non_renseigne"); continue; }
              } else if (!tranchesIncluses.has(tranche)) {
                exclure(cc, "tranche_hors_perimetre"); continue;
              }

              const estClient = clients.has(String(ul.siren));
              if (estClient) cc.clients++;
              const dirigeants = (Array.isArray(ul.dirigeants) ? ul.dirigeants : [])
                .filter((d: any) => d && d.type_dirigeant === "personne physique" && (d.nom || d.prenoms))
                .map((d: any) => ({ nom: d.nom || null, prenom: d.prenoms || null, qualite: d.qualite || null }));
              const enseigne = (Array.isArray(et.liste_enseignes) && et.liste_enseignes[0]) || et.nom_commercial || null;

              lignes.set(String(et.siret), {
                siret: String(et.siret), siren: String(ul.siren),
                raison_sociale: ul.nom_raison_sociale || ul.nom_complet || "",
                enseigne, nature_juridique: ul.nature_juridique || null,
                naf_code: et.activite_principale || ul.activite_principale || null, naf_libelle: null,
                tranche_effectif: tranche, annee_effectif: annee, tranche_source: source,
                tranche_effectif_etab: te || null, tranche_effectif_ul: tu || null,
                annee_effectif_ul: Number(ul.annee_tranche_effectif_salarie) || null,
                nb_etablissements_ouverts: Number.isFinite(ouverts) ? ouverts : null,
                date_creation_ul: ul.date_creation || null, date_creation_etab: et.date_creation || null,
                adresse: et.adresse || null, code_postal: cpEtab, commune: et.libelle_commune || null,
                dirigeants, est_siege: et.est_siege === true, est_client: estClient,
              });
            }
          }
          page++;
        } while (page <= totalPages && page <= MAX_PAGES);

        c.importees += lignes.size;
        if (!dryRun && lignes.size) {
          const toutes = Array.from(lignes.values());
          for (let i = 0; i < toutes.length; i += LOT_UPSERT) {
            const { data, error } = await admin.rpc("commando_import_upsert", {
              _rows: toutes.slice(i, i + LOT_UPSERT), _semaine: semaine, _initial: initial,
            });
            if (error) throw new Error("Enregistrement (" + cp + ") : " + error.message);
            // Les lignes d'un code postal appartiennent à son secteur.
            c.ajoutees += Number(data?.ajoutees || 0);
            c.reactivees += Number(data?.reactivees || 0);
            c.mises_a_jour += Number(data?.mises_a_jour || 0);
          }
        }
      }

      // Archivage des établissements non revus (uniquement sur le périmètre traité).
      if (!dryRun) {
        const { data, error } = await admin.rpc("commando_import_archiver", { _codes: codes, _depuis: imp.lance_le });
        if (error) throw new Error("Archivage : " + error.message);
        const ps = (data && data.par_secteur) || {};
        for (const [sect, n] of Object.entries(ps)) compteur(sect).archivees += Number(n);
      }
    } catch (e) {
      erreur = (e as Error).message || String(e);
    }

    const total = nouveauCompteur();
    for (const c of Object.values(parSecteur)) {
      total.vues += c.vues; total.importees += c.importees; total.ajoutees += c.ajoutees;
      total.reactivees += c.reactivees; total.mises_a_jour += c.mises_a_jour; total.archivees += c.archivees;
      total.clients += c.clients; total.effectif_non_renseigne += c.effectif_non_renseigne;
      for (const [k, v] of Object.entries(c.exclues)) total.exclues[k] = (total.exclues[k] || 0) + v;
    }
    const compteurs = {
      total, par_secteur: parSecteur, unites_legales: unitesLegales,
      requetes: api.requetes, duree_ms: Date.now() - debut, semaine_cible: semaine,
    };
    await admin.from("commando_imports").update({
      statut: erreur ? "erreur" : "terminee", termine_le: new Date().toISOString(),
      compteurs, anomalies: anomalies.slice(0, 500), erreur,
    }).eq("id", imp.id);
    return { import_id: imp.id, statut: erreur ? "erreur" : "terminee", erreur, compteurs, anomalies: anomalies.slice(0, 100) };
  };

  if (synchrone) {
    const rapport = await run();
    return json(rapport, rapport.erreur ? 500 : 200);
  }
  // Import complet : on répond tout de suite, le travail continue en tâche de fond ;
  // la console suit la ligne commando_imports.
  // @ts-ignore EdgeRuntime est fourni par l'environnement Supabase.
  EdgeRuntime.waitUntil(run());
  return json({ import_id: imp.id, statut: "en_cours" }, 202);
});
