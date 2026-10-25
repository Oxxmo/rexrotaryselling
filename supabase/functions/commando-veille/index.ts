// ============================================================
//  Rex Commando — Edge Function « commando-veille »
//  ------------------------------------------------------------
//  Veille IA hebdomadaire : appelle l'API Messages d'Anthropic avec
//  l'outil de recherche web côté serveur, valide la sortie et enregistre
//  les propositions de thématiques.
//
//  Types de génération (corps JSON : { semaine_id, type, thematique_id? }) :
//    * "veille"       : 5 propositions pour la semaine ;
//    * "regeneration" : remplace une seule proposition (thematique_id) ;
//    * "fiche_rex"    : brouillon de fiche Rex-Rotary depuis le site public.
//
//  Garde-fous :
//    * seul un membre « responsable » peut appeler (vérifié ici, pas
//      seulement dans l'interface) ;
//    * clé API dans le secret ANTHROPIC_API_KEY, jamais côté navigateur ;
//    * limite de générations par semaine (paramètre) ;
//    * JSON validé par schéma, une seule nouvelle tentative ;
//    * chaque URL citée est comparée aux résultats de recherche réels ;
//    * tout est tracé (modèle, version du prompt, jetons, coût, durée).
//
//  La génération est asynchrone : réponse 202 immédiate, travail en
//  tâche de fond, état suivi dans commando_generations.
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { PROMPT_VEILLE, PROMPT_VERSION, CONSIGNE_REGENERATION, PROMPT_FICHE } from "../_shared/prompt_veille.ts";
import {
  extraireJson, validerSortie, collecterUrls, verifierSources, alertes, estimerCout, cumulerUsage, remplirPrompt, alleger,
  type Usage, type ThematiqueT,
} from "../_shared/validation.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_TOKENS = 32000;
const MAX_RECHERCHES = 15;
const MAX_TOURS = 4;   // reprises après « pause_turn »

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function dateParisLongue(): string {
  return new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function hote(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- Autorisation : responsable du commando, vérifié en base ---
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!jwt) return json({ error: "Non authentifié" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !userData?.user) return json({ error: "Session invalide" }, 401);
  const callerId = userData.user.id;
  const { data: membre } = await admin.from("commando_membres").select("role").eq("user_id", callerId).maybeSingle();
  if (!membre || membre.role !== "responsable") return json({ error: "Réservé au responsable du commando." }, 403);
  if (!API_KEY) return json({ error: "Clé API Anthropic absente des secrets (ANTHROPIC_API_KEY)." }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }
  const type: string = ["veille", "regeneration", "fiche_rex"].includes(body?.type) ? body.type : "veille";
  const semaineId: string = String(body?.semaine_id || "");
  const thematiqueId: string | null = body?.thematique_id ? String(body.thematique_id) : null;

  const { data: params } = await admin.from("commando_parametres").select("*").eq("id", true).single();
  if (!params) return json({ error: "Paramètres introuvables" }, 500);
  const modele: string = params.modele || "claude-sonnet-5-5";

  const { data: semaine } = await admin.from("commando_semaines").select("*").eq("id", semaineId).maybeSingle();
  if (!semaine) return json({ error: "Semaine introuvable" }, 400);

  if (type !== "fiche_rex") {
    if (!params.fiche_rex || !params.fiche_rex_validee_le) return json({ error: "La fiche Rex-Rotary doit être validée avant de lancer la veille." }, 400);
    const { count } = await admin.from("commando_generations").select("id", { count: "exact", head: true })
      .eq("semaine_id", semaineId).in("type", ["veille", "regeneration"]);
    if ((count || 0) >= Number(params.limite_generations_semaine || 5)) {
      return json({ error: `Limite atteinte : ${count} générations déjà lancées cette semaine (paramètre : ${params.limite_generations_semaine}).` }, 429);
    }
    const { data: enCours } = await admin.from("commando_generations").select("id").eq("semaine_id", semaineId).eq("statut", "en_cours").limit(1);
    if (enCours && enCours.length) return json({ error: "Une génération est déjà en cours pour cette semaine." }, 409);
  }
  let thematiqueCible: any = null;
  if (type === "regeneration") {
    const { data } = await admin.from("commando_thematiques").select("*").eq("id", thematiqueId || "").maybeSingle();
    if (!data) return json({ error: "Thématique à régénérer introuvable" }, 400);
    thematiqueCible = data;
  }

  const { data: gen, error: gErr } = await admin.from("commando_generations").insert({
    semaine_id: semaineId, type, modele, prompt_version: PROMPT_VERSION, lancee_par: callerId,
  }).select("id").single();
  if (gErr || !gen) return json({ error: "Création de la génération impossible : " + (gErr?.message || "") }, 500);
  const genId: string = gen.id;

  const client = new Anthropic({ apiKey: API_KEY, maxRetries: 2 });

  // ---------- Appel du modèle (avec reprises « pause_turn ») ----------
  async function appeler(system: string, messages: any[], tools: any[]) {
    let usage: Usage = {};
    const urls = new Set<string>();
    let texte = "";
    let dernier: any = null;
    for (let tour = 0; tour < MAX_TOURS; tour++) {
      const stream = client.messages.stream({
        model: modele, max_tokens: MAX_TOKENS, system, messages, tools,
        output_config: { effort: "medium" },
      } as any);
      const msg: any = await stream.finalMessage();
      dernier = msg;
      const u = msg.usage || {};
      usage = cumulerUsage(usage, {
        input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens,
        web_search_requests: u.server_tool_use?.web_search_requests,
      });
      collecterUrls(msg.content, urls);
      texte += (msg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (msg.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: msg.content }); continue; }
      if (msg.stop_reason === "refusal") throw new Error("Le modèle a refusé la demande (stop_reason refusal).");
      if (msg.stop_reason === "max_tokens") throw new Error("Réponse tronquée (max_tokens) : réduisez la demande ou augmentez la limite.");
      break;
    }
    return { texte, urls, usage, message: dernier, messages };
  }

  // ---------- Contexte de la veille (variables du prompt) ----------
  async function contexte() {
    const [stats, repartition, recents] = await Promise.all([
      Promise.resolve(admin.rpc("commando_stats", { _depuis: null, _jusqua: null })).then(r => r.data).catch(() => null),
      Promise.resolve(admin.rpc("commando_repartition_base")).then(r => r.data).catch(() => null),
      admin.from("commando_thematiques").select("titre, offre_rex, statut, commando_semaines!inner(semaine)")
        .eq("statut", "retenue").neq("semaine_id", semaineId).order("created_at", { ascending: false }).limit(40).then(r => r.data || []),
    ]);
    const themes = (recents as any[]).map(t => `- ${t.commando_semaines?.semaine || "?"} : ${t.titre} (offre : ${t.offre_rex || "—"})`);
    return {
      date_du_jour: dateParisLongue(),
      semaine: semaine.semaine,
      fiche_rex: params.fiche_rex,
      concurrents: (params.concurrents || []).length ? (params.concurrents as string[]).join(", ") : "aucun concurrent renseigné",
      consignes: params.consignes,
      themes_recents: themes.length ? themes.join("\n") : "aucune (première semaine)",
      performance: performanceTexte(stats, Number(params.seuil_echantillon || 30)),
      repartition_base: repartition ? JSON.stringify(repartition) : "base vide",
    };
  }
  function performanceTexte(stats: any, seuil: number): string {
    if (!stats || !stats.total || !Number(stats.total.appels)) return "aucun appel enregistré pour le moment";
    const bloc = (b: any) => `${b.appels} appels, ${b.rdv} RDV (${Math.round((b.taux || 0) * 100)} %), ${b.honores} honorés${b.echantillon_insuffisant ? " [échantillon < " + seuil + " : conclusion fragile]" : ""}`;
    const lignes: string[] = [`Total : ${bloc(stats.total)}`];
    for (const c of stats.par_couleur || []) lignes.push(`Couleur ${c.couleur || "non classée"} : ${bloc(c)}`);
    for (const t of (stats.par_thematique || []).slice(0, 12)) lignes.push(`Thématique « ${t.titre} » (${t.semaine}) : ${bloc(t)}`);
    for (const r of (stats.par_regle || []).slice(0, 20)) lignes.push(`Règle ${r.regle_index + 1} de « ${r.titre} » (${r.couleur_regle}, ${r.raison}) : ${bloc(r)}`);
    return lignes.join("\n");
  }

  // ---------- Génération des thématiques ----------
  async function genererVeille(): Promise<Record<string, unknown>> {
    const vars = await contexte();
    const system = remplirPrompt(PROMPT_VEILLE, vars);
    const attendu = type === "regeneration" ? 1 : 5;
    let consigne: string;
    if (type === "regeneration") {
      const { data: autres } = await admin.from("commando_thematiques").select("titre").eq("semaine_id", semaineId).neq("id", thematiqueCible.id);
      consigne = remplirPrompt(CONSIGNE_REGENERATION, {
        titre: thematiqueCible.titre, cle: thematiqueCible.cle || thematiqueCible.id,
        autres: (autres || []).map((t: any) => "« " + t.titre + " »").join(", ") || "aucune",
      });
    } else {
      consigne = `Lance la veille pour la semaine ${semaine.semaine} (nous sommes le ${vars.date_du_jour}). Réponds uniquement par l'objet JSON demandé, avec exactement 5 thématiques.`;
    }
    const tools = [{
      type: "web_search_20260318", name: "web_search", max_uses: MAX_RECHERCHES, allowed_callers: ["direct"],
      user_location: { type: "approximate", city: "Poitiers", region: "Nouvelle-Aquitaine", country: "FR", timezone: "Europe/Paris" },
    }];
    const messages: any[] = [{ role: "user", content: consigne }];
    let usage: Usage = {};
    const urls = new Set<string>();
    let brut: any = null;
    let data: any = null;
    let erreurs: string[] = [];

    for (let tentative = 1; tentative <= 2; tentative++) {
      const r = await appeler(system, messages, tools);
      usage = cumulerUsage(usage, r.usage);
      r.urls.forEach(u => urls.add(u));
      brut = r.message;
      const obj = extraireJson(r.texte);
      const v = obj === null ? { ok: false as const, erreurs: ["Aucun objet JSON trouvé dans la réponse."] } : validerSortie(obj, attendu);
      if (v.ok) { data = v.data; erreurs = []; break; }
      erreurs = v.erreurs;
      if (tentative === 1) {
        // Une seule nouvelle tentative, dans la même conversation, sans nouvelle recherche.
        messages.push({ role: "assistant", content: r.message.content });
        messages.push({ role: "user", content: "Ta réponse n'est pas conforme au format demandé :\n- " + erreurs.join("\n- ") +
          "\nRenvoie uniquement l'objet JSON corrigé (sans texte autour, sans nouvelle recherche), avec exactement " + attendu + " thématique(s)." });
      }
    }
    const cout = estimerCout(modele, usage);
    if (!data) {
      throw Object.assign(new Error("Sortie invalide après deux tentatives : " + erreurs.join(" | ")), { usage, cout, urls: Array.from(urls), brut, system, consigne });
    }

    // Vérification des sources et alertes, puis enregistrement.
    const maintenant = new Date();
    const { data: maxOrdre } = await admin.from("commando_thematiques").select("ordre").eq("semaine_id", semaineId).order("ordre", { ascending: false }).limit(1);
    let ordre = Number((maxOrdre && maxOrdre[0] && maxOrdre[0].ordre) || 0);
    const lignes = (data.thematiques as ThematiqueT[]).map((t) => {
      const v = verifierSources(t, urls);
      ordre += 1;
      return {
        semaine_id: semaineId, generation_id: genId, origine: "ia", statut: "proposee", ordre,
        cle: v.id, titre: v.titre, offre_rex: v.offre_rex, pourquoi_maintenant: v.pourquoi_maintenant,
        sources: v.sources, concurrence: v.concurrence, regles: v.regles, trames: v.trames,
        objections: v.objections, hypotheses: v.hypotheses, alertes: alertes(v, maintenant),
      };
    });
    if (type === "regeneration") {
      const l = lignes[0];
      const { error } = await admin.from("commando_thematiques").update({
        generation_id: genId, statut: "proposee", cle: l.cle, titre: l.titre, offre_rex: l.offre_rex,
        pourquoi_maintenant: l.pourquoi_maintenant, sources: l.sources, concurrence: l.concurrence, regles: l.regles,
        trames: l.trames, objections: l.objections, hypotheses: l.hypotheses, alertes: l.alertes, modifiee_par: null, modifiee_le: null,
      }).eq("id", thematiqueCible.id);
      if (error) throw new Error("Enregistrement : " + error.message);
    } else {
      const { error } = await admin.from("commando_thematiques").insert(lignes);
      if (error) throw new Error("Enregistrement : " + error.message);
    }
    return {
      usage, cout, urls: Array.from(urls), brut, system, consigne,
      resume: { thematiques: lignes.length, sources_verifiees: lignes.reduce((a, l) => a + l.sources.filter((s: any) => s.verifiee).length, 0), sources_total: lignes.reduce((a, l) => a + l.sources.length, 0) },
    };
  }

  // ---------- Brouillon de fiche Rex ----------
  async function genererFiche(): Promise<Record<string, unknown>> {
    const site: string = params.site_rex || "https://www.rexrotary.fr";
    const h = hote(site);
    const system = remplirPrompt(PROMPT_FICHE, { site_rex: site });
    const tools: any[] = [
      { type: "web_search_20260318", name: "web_search", max_uses: 8, allowed_callers: ["direct"], ...(h ? { allowed_domains: [h] } : {}) },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, ...(h ? { allowed_domains: [h] } : {}) },
    ];
    const consigne = `Rédige le brouillon de fiche Rex-Rotary à partir du site ${site} (commence par lire la page d'accueil ${site}).`;
    const r = await appeler(system, [{ role: "user", content: consigne }], tools);
    const texte = r.texte.trim();
    if (!texte) throw new Error("Le modèle n'a renvoyé aucun texte.");
    const { error } = await admin.from("commando_parametres").update({ fiche_rex_brouillon: texte, updated_by: callerId }).eq("id", true);
    if (error) throw new Error("Enregistrement du brouillon : " + error.message);
    return { usage: r.usage, cout: estimerCout(modele, r.usage), urls: Array.from(r.urls), brut: r.message, system, consigne, resume: { caracteres: texte.length } };
  }

  // ---------- Exécution en tâche de fond ----------
  const run = async () => {
    const debut = Date.now();
    let res: any = null; let erreur: string | null = null; let extra: any = {};
    try {
      res = type === "fiche_rex" ? await genererFiche() : await genererVeille();
    } catch (e: any) {
      erreur = e?.message || String(e);
      extra = { usage: e?.usage, cout: e?.cout, urls: e?.urls, brut: e?.brut, system: e?.system, consigne: e?.consigne };
    }
    const r = res || extra;
    const u: Usage = r.usage || {};
    await admin.from("commando_generations").update({
      statut: erreur ? "erreur" : "terminee", terminee_le: new Date().toISOString(), duree_ms: Date.now() - debut, erreur,
      prompt_envoye: r.system ? r.system + "\n\n=== Consigne utilisateur ===\n" + (r.consigne || "") : null,
      reponse_brute: r.brut ? { stop_reason: r.brut.stop_reason, content: alleger(r.brut.content), resume: r.resume || null } : null,
      urls_recherche: r.urls || [],
      jetons_entree: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), jetons_sortie: u.output_tokens || 0,
      jetons_cache: u.cache_read_input_tokens || 0, nb_recherches: u.web_search_requests || 0,
      cout_estime: r.cout != null ? r.cout : (Object.keys(u).length ? estimerCout(modele, u) : null),
    }).eq("id", genId);
  };

  // Mode « aperçu du prompt » : renvoie le prompt complet rempli et une
  // estimation, sans appeler le modèle (point d'arrêt du brief).
  if (body?.apercu === true) {
    await admin.from("commando_generations").delete().eq("id", genId);
    const vars = await contexte();
    const system = remplirPrompt(type === "fiche_rex" ? PROMPT_FICHE : PROMPT_VEILLE, { ...vars, site_rex: params.site_rex });
    return json({ prompt_version: PROMPT_VERSION, modele, system, caracteres: system.length,
      estimation: { hypothese: "12 recherches, 50 000 jetons en entrée, 20 000 en sortie", cout: estimerCout(modele, { input_tokens: 50000, output_tokens: 20000, web_search_requests: 12 }) } });
  }

  // @ts-ignore EdgeRuntime est fourni par l'environnement Supabase.
  EdgeRuntime.waitUntil(run());
  return json({ generation_id: genId, statut: "en_cours" }, 202);
});
