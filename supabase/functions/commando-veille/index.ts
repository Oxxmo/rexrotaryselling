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
//  Exécution en ÉTAPES COURTES. Les Edge Functions sont limitées à 150 s
//  (offre gratuite) ou 400 s par processus : une veille complète dépasse
//  ce délai. Elle est donc découpée :
//    1. « recherche »  : veille d'actualité et concurrentielle (recherche
//                        web), rendue sous forme de propositions documentées ;
//    2..6. « redaction » : une thématique complète à la fois (sans
//                        recherche web, à partir des notes de l'étape 1),
//                        enregistrée dès qu'elle est validée.
//  Chaque étape est un appel distinct de cette fonction. L'état est dans
//  commando_generations.etat ; le job pg_cron « commando_veille_relance »
//  (toutes les 20 s) déclenche l'étape suivante et relance une étape
//  interrompue (une fois).
//
//  Garde-fous :
//    * lancement réservé à un membre « responsable » (vérifié ici) ;
//      relances internes authentifiées par le secret Vault ;
//    * clé API dans le secret ANTHROPIC_API_KEY, jamais côté navigateur ;
//    * limite de générations par semaine (paramètre) ;
//    * JSON validé par schéma, une seule nouvelle tentative par étape ;
//    * chaque URL citée est comparée aux résultats de recherche réels ;
//    * tout est tracé (modèle, version du prompt, jetons, coût, durée).
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { PROMPT_VEILLE, PROMPT_VERSION, PROMPT_FICHE, FORMAT_THEMATIQUE } from "../_shared/prompt_veille.ts";
import {
  extraireJson, validerSortie, validerPropositions, collecterUrls, verifierSources, alertes, estimerCout, cumulerUsage,
  remplirPrompt, alleger, type Usage, type ThematiqueT, type PropositionT,
} from "../_shared/validation.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-commando-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BOOT = Date.now();            // âge du processus : un processus réutilisé n'a plus tout son budget
const AGE_MAX_MS = 15_000;          // au-delà, l'étape est différée (le cron la relancera sur un processus neuf)
const BUDGET_ETAPE_MS = 115_000;    // durée maximale d'une étape (marge sous la limite de 150 s)
const DELAI_RELANCE_S = 20;         // délai avant l'étape suivante : laisse l'ancien processus s'éteindre
const MAX_TOKENS_RECHERCHE = 12_000;
const MAX_TOKENS_REDACTION = 10_000;
const MAX_TOKENS_FICHE = 8_000;
const MAX_TOURS = 4;                // reprises après « pause_turn »

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function dateParisLongue(): string {
  return new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function hote(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}
function dansSecondes(s: number): string { return new Date(Date.now() + s * 1000).toISOString(); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }

  // --- Qui appelle ? Relance interne (secret Vault) ou responsable (JWT) ---
  let interne = false;
  let callerId: string | null = null;
  const secret = req.headers.get("x-commando-secret") || "";
  if (secret) {
    const { data } = await admin.rpc("commando_cron_secret_ok", { _secret: secret });
    if (data !== true) return json({ error: "Secret invalide" }, 401);
    interne = true;
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Non authentifié" }, 401);
    const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !userData?.user) return json({ error: "Session invalide" }, 401);
    callerId = userData.user.id;
    const { data: membre } = await admin.from("commando_membres").select("role").eq("user_id", callerId).maybeSingle();
    if (!membre || membre.role !== "responsable") return json({ error: "Réservé au responsable du commando." }, 403);
  }
  if (!API_KEY) return json({ error: "Clé API Anthropic absente des secrets (ANTHROPIC_API_KEY)." }, 500);

  const { data: params } = await admin.from("commando_parametres").select("*").eq("id", true).single();
  if (!params) return json({ error: "Paramètres introuvables" }, 500);
  const modele: string = params.modele || "claude-sonnet-5-5";
  const client = new Anthropic({ apiKey: API_KEY, maxRetries: 2 });

  // ============================================================
  //  Outils communs aux étapes
  // ============================================================

  /** Appel du modèle avec reprises « pause_turn », limité dans le temps. */
  async function appeler(system: string, messages: any[], tools: any[], maxTokens: number, budgetMs: number) {
    let usage: Usage = {};
    const urls = new Set<string>();
    let texte = "";
    let dernier: any = null;
    const debut = Date.now();
    for (let tour = 0; tour < MAX_TOURS; tour++) {
      const restant = budgetMs - (Date.now() - debut);
      if (restant < 10_000) throw Object.assign(new Error("Durée de l'étape dépassée"), { code: "temps" });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), restant);
      let msg: any;
      try {
        const stream = client.messages.stream({
          model: modele, max_tokens: maxTokens, system, messages, ...(tools.length ? { tools } : {}),
          output_config: { effort: "medium" },
        } as any, { signal: ctrl.signal });
        msg = await stream.finalMessage();
      } catch (e: any) {
        if (ctrl.signal.aborted) throw Object.assign(new Error("Durée de l'étape dépassée (appel interrompu)"), { code: "temps" });
        throw e;
      } finally { clearTimeout(timer); }
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
      if (msg.stop_reason === "max_tokens") throw new Error("Réponse tronquée (max_tokens).");
      break;
    }
    return { texte, urls, usage, message: dernier };
  }

  /** Variables du prompt système (contexte de la semaine). */
  async function contexte(semaine: any) {
    const [stats, repartition, recents] = await Promise.all([
      Promise.resolve(admin.rpc("commando_stats", { _depuis: null, _jusqua: null })).then(r => r.data).catch(() => null),
      Promise.resolve(admin.rpc("commando_repartition_base")).then(r => r.data).catch(() => null),
      admin.from("commando_thematiques").select("titre, offre_rex, statut, commando_semaines!inner(semaine)")
        .eq("statut", "retenue").neq("semaine_id", semaine.id).order("created_at", { ascending: false }).limit(40).then(r => r.data || []),
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
  function outilRecherche(maxUses: number) {
    return {
      type: "web_search_20260318", name: "web_search", max_uses: maxUses, allowed_callers: ["direct"],
      user_location: { type: "approximate", city: "Poitiers", region: "Nouvelle-Aquitaine", country: "FR", timezone: "Europe/Paris" },
    };
  }

  // ============================================================
  //  Étape 1 : recherche (veille d'actualité et concurrentielle)
  // ============================================================
  async function etapeRecherche(gen: any, semaine: any, etat: any, budgetMs: number) {
    const vars = await contexte(semaine);
    const system = remplirPrompt(PROMPT_VEILLE, vars);
    const attendu: number = etat.attendu || 5;
    const tentative = Number(etat.tentatives || 0);
    const maxUses = tentative === 0 ? 8 : 4;   // seconde tentative : moins de recherches, plus court
    let consigne: string;
    const format = `Réponds uniquement par un objet JSON (sans texte autour) de la forme :
{"propositions":[{"id":"identifiant-court","titre":"…","sujet":"résumé de l'actualité en 3 phrases","offre_rex":"offre de la fiche Rex concernée","pourquoi_maintenant":"…","faits":[{"fait":"fait daté ou chiffre","url":"URL exacte issue de tes recherches","titre":"titre de la page","date":"AAAA-MM-JJ"}],"concurrence":{"constat":"ce que font les concurrents listés","angle_rex":"angle qui différencie Rex-Rotary","sources":[{"url":"…","titre":"…","date":"AAAA-MM-JJ"}]},"pistes_regles":"en une phrase : quels NAF, tranches, anciennetés cibler et pourquoi"}]}
Chaque proposition doit contenir au moins 2 faits, chacun avec une URL réellement renvoyée par tes recherches. Pas d'URL inventée.`;
    if (gen.type === "regeneration") {
      consigne = `ÉTAPE 1 — RECHERCHE (${maxUses} recherches au plus). Ne rédige pas encore de trame. Trouve UNE nouvelle thématique d'actualité, différente de celles déjà proposées cette semaine : ${etat.autres_titres || "aucune"}. ${format}\nLe tableau « propositions » contient exactement 1 élément.`;
    } else {
      consigne = `ÉTAPE 1 — RECHERCHE (${maxUses} recherches au plus). Ne rédige pas encore les trames : fais d'abord la veille d'actualité et la veille concurrentielle, puis propose exactement ${attendu} thématiques distinctes, chacune rattachée à une offre présente dans la fiche Rex. ${format}`;
    }
    const messages: any[] = [{ role: "user", content: consigne }];
    const debut = Date.now();
    let usage: Usage = {};
    const urls = new Set<string>(etat.urls || []);
    let data: PropositionT[] | null = null;
    let erreurs: string[] = [];
    let brut: any = null;
    for (let essai = 1; essai <= 2; essai++) {
      const r = await appeler(system, messages, [outilRecherche(maxUses)], MAX_TOKENS_RECHERCHE, budgetMs - (Date.now() - debut));
      usage = cumulerUsage(usage, r.usage);
      r.urls.forEach(u => urls.add(u));
      brut = r.message;
      const obj = extraireJson(r.texte);
      const v = obj === null ? { ok: false as const, erreurs: ["Aucun objet JSON trouvé dans la réponse."] } : validerPropositions(obj, attendu, attendu === 1 ? 1 : 3);
      if (v.ok) { data = v.data; erreurs = []; break; }
      erreurs = v.erreurs;
      // Une seule correction, dans la même conversation, sans nouvelle recherche, si le temps le permet.
      if (essai === 1 && Date.now() - debut < budgetMs * 0.5) {
        messages.push({ role: "assistant", content: r.message.content });
        messages.push({ role: "user", content: "Ta réponse n'est pas conforme :\n- " + erreurs.join("\n- ") + "\nRenvoie uniquement l'objet JSON corrigé, sans nouvelle recherche." });
      } else break;
    }
    if (!data) throw Object.assign(new Error("Notes de veille invalides : " + erreurs.join(" | ")), { usage, brut });
    return { propositions: data, urls: Array.from(urls), usage, system, consigne, brut };
  }

  // ============================================================
  //  Étapes 2..N : rédaction d'une thématique complète
  // ============================================================
  async function etapeRedaction(gen: any, semaine: any, etat: any, budgetMs: number) {
    const vars = await contexte(semaine);
    const system = remplirPrompt(PROMPT_VEILLE, vars);
    const i: number = (etat.ecrites || []).length + (etat.echecs || []).length;
    const prop: PropositionT = etat.propositions[i];
    if (!prop) throw new Error("Aucune proposition à rédiger.");
    const deja = (etat.ecrites || []).map((e: any) => "« " + e.titre + " »").join(", ") || "aucune";
    const consigne = `ÉTAPE ${i + 2}/${etat.total} — RÉDACTION. Les recherches sont terminées (n'en fais pas d'autres). Voici les notes de veille de la thématique à rédiger, issues de l'étape 1 :
${JSON.stringify(prop)}

Thématiques déjà rédigées cette semaine (ne pas les reprendre) : ${deja}.

Rédige maintenant UNIQUEMENT la thématique « ${prop.titre} » (id « ${prop.id} »), complète : offre_rex, pourquoi_maintenant, sources (reprends les URL des faits ci-dessus, uniquement celles-là), concurrence, règles de couleur (champs autorisés seulement, cohérentes avec les données de la base), trames vert / orange / rouge, 4 objections avec réponse, hypotheses.
Réponds uniquement par un objet JSON (sans texte autour) qui suit EXACTEMENT ce squelette, avec "semaine" = "${semaine.semaine}" et un seul élément dans "thematiques" :
${FORMAT_THEMATIQUE}`;
    const messages: any[] = [{ role: "user", content: consigne }];
    const debut = Date.now();
    let usage: Usage = {};
    let data: any = null;
    let erreurs: string[] = [];
    let brut: any = null;
    for (let essai = 1; essai <= 2; essai++) {
      const r = await appeler(system, messages, [], MAX_TOKENS_REDACTION, budgetMs - (Date.now() - debut));
      usage = cumulerUsage(usage, r.usage);
      brut = r.message;
      const obj = extraireJson(r.texte);
      const v = obj === null ? { ok: false as const, erreurs: ["Aucun objet JSON trouvé dans la réponse."] } : validerSortie(obj, 1);
      if (v.ok) { data = v.data; erreurs = []; break; }
      erreurs = v.erreurs;
      if (essai === 1 && Date.now() - debut < budgetMs * 0.55) {
        messages.push({ role: "assistant", content: r.message.content });
        messages.push({ role: "user", content: "Ta réponse n'est pas conforme au format demandé :\n- " + erreurs.join("\n- ") + "\nRenvoie uniquement l'objet JSON corrigé (sans texte autour), avec exactement 1 thématique." });
      } else break;
    }
    if (!data) {
      // Thématique irrécupérable : écartée, la veille continue avec les suivantes
      // (sauf régénération : une seule thématique attendue).
      const raison = `Thématique « ${prop.titre} » non rédigée (format invalide après deux essais) : ` + erreurs.join(" | ");
      if (gen.type === "regeneration") throw Object.assign(new Error(raison), { usage, brut });
      return { echec: { titre: prop.titre, cle: prop.id, raison }, usage, brut };
    }

    // Vérification des sources (URL réellement vues en étape 1), alertes, enregistrement immédiat.
    const urls = new Set<string>(etat.urls || []);
    const t = verifierSources(data.thematiques[0] as ThematiqueT, urls);
    const ligne: any = {
      cle: t.id, titre: t.titre, offre_rex: t.offre_rex, pourquoi_maintenant: t.pourquoi_maintenant,
      sources: t.sources, concurrence: t.concurrence, regles: t.regles, trames: t.trames,
      objections: t.objections, hypotheses: t.hypotheses, alertes: alertes(t, new Date()),
    };
    if (gen.type === "regeneration") {
      const { error } = await admin.from("commando_thematiques").update({
        ...ligne, generation_id: gen.id, statut: "proposee", modifiee_par: null, modifiee_le: null,
      }).eq("id", etat.thematique_id);
      if (error) throw new Error("Enregistrement : " + error.message);
    } else {
      const { data: maxOrdre } = await admin.from("commando_thematiques").select("ordre").eq("semaine_id", gen.semaine_id).order("ordre", { ascending: false }).limit(1);
      const ordre = Number((maxOrdre && maxOrdre[0] && maxOrdre[0].ordre) || 0) + 1;
      const { error } = await admin.from("commando_thematiques").insert({
        ...ligne, semaine_id: gen.semaine_id, generation_id: gen.id, origine: "ia", statut: "proposee", ordre,
      });
      if (error) throw new Error("Enregistrement : " + error.message);
    }
    return { ecrite: { titre: t.titre, cle: t.id, sources_verifiees: t.sources.filter((s: any) => s.verifiee).length, sources_total: t.sources.length }, echec: null as any, usage, brut };
  }

  // ============================================================
  //  Fiche Rex (une seule étape)
  // ============================================================
  async function etapeFiche(_gen: any, _semaine: any, _etat: any, budgetMs: number) {
    const site: string = params.site_rex || "https://www.rexrotary.fr";
    const h = hote(site);
    const system = remplirPrompt(PROMPT_FICHE, { site_rex: site });
    const tools: any[] = [
      { type: "web_search_20260318", name: "web_search", max_uses: 6, allowed_callers: ["direct"], ...(h ? { allowed_domains: [h] } : {}) },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, ...(h ? { allowed_domains: [h] } : {}) },
    ];
    const consigne = `Rédige le brouillon de fiche Rex-Rotary à partir du site ${site} (commence par lire la page d'accueil ${site}).`;
    const r = await appeler(system, [{ role: "user", content: consigne }], tools, MAX_TOKENS_FICHE, budgetMs);
    const texte = r.texte.trim();
    if (!texte) throw new Error("Le modèle n'a renvoyé aucun texte.");
    const { error } = await admin.from("commando_parametres").update({ fiche_rex_brouillon: texte, updated_by: callerId }).eq("id", true);
    if (error) throw new Error("Enregistrement du brouillon : " + error.message);
    return { usage: r.usage, urls: Array.from(r.urls), system, consigne, brut: r.message, resume: { caracteres: texte.length } };
  }

  // ============================================================
  //  Exécution d'une étape (en tâche de fond) et enchaînement
  // ============================================================
  async function executerEtape(genId: string) {
    const { data: gen } = await admin.from("commando_generations").select("*").eq("id", genId).single();
    if (!gen || gen.statut !== "en_cours") return;
    const { data: semaine } = await admin.from("commando_semaines").select("*").eq("id", gen.semaine_id).single();
    const etat: any = gen.etat || {};
    const debut = Date.now();
    const budget = BUDGET_ETAPE_MS - (Date.now() - BOOT);
    const patchEtat = async (e: any) => {
      await admin.from("commando_generations").update({ etat: { ...etat, ...e } }).eq("id", genId);
      Object.assign(etat, e);
    };
    const finir = async (extraComplet: any, erreur: string | null, statut?: "terminee" | "erreur") => {
      const { reponse_brute, ...extra } = extraComplet || {};
      const u: Usage = etat.usage || {};
      await admin.from("commando_generations").update({
        statut: statut || (erreur ? "erreur" : "terminee"), terminee_le: new Date().toISOString(),
        duree_ms: Date.now() - new Date(gen.lancee_le).getTime(), erreur,
        urls_recherche: etat.urls || [],
        jetons_entree: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), jetons_sortie: u.output_tokens || 0,
        jetons_cache: u.cache_read_input_tokens || 0, nb_recherches: u.web_search_requests || 0,
        cout_estime: Object.keys(u).length ? estimerCout(modele, u) : null,
        etat: { ...etat, en_vol: false, phase: "fini", ...extra },
        ...(reponse_brute ? { reponse_brute } : {}),
      }).eq("id", genId);
    };

    try {
      if (etat.phase === "recherche") {
        const r = await etapeRecherche(gen, semaine, etat, budget);
        await admin.from("commando_generations").update({
          prompt_envoye: r.system + "\n\n=== Consigne utilisateur (étape 1) ===\n" + r.consigne,
        }).eq("id", genId);
        const total = 1 + r.propositions.length;
        await patchEtat({
          phase: "redaction", etape: 2, total, propositions: r.propositions, urls: r.urls,
          usage: cumulerUsage(etat.usage || {}, r.usage), tentatives: 0, en_vol: false,
          relance_apres: dansSecondes(DELAI_RELANCE_S), libelle: `Rédaction de la thématique 1/${r.propositions.length} : ${r.propositions[0].titre}`,
          duree_etapes_ms: [...(etat.duree_etapes_ms || []), Date.now() - debut], note: null,
        });
      } else if (etat.phase === "redaction") {
        const r = await etapeRedaction(gen, semaine, etat, budget);
        const ecrites = r.ecrite ? [...(etat.ecrites || []), r.ecrite] : [...(etat.ecrites || [])];
        const echecs = r.echec ? [...(etat.echecs || []), r.echec] : [...(etat.echecs || [])];
        const traitees = ecrites.length + echecs.length;
        const usage = cumulerUsage(etat.usage || {}, r.usage);
        const durees = [...(etat.duree_etapes_ms || []), Date.now() - debut];
        if (traitees >= (etat.propositions || []).length) {
          const bilan = echecs.length ? `${echecs.length} thématique(s) non rédigée(s) sur ${traitees} : ` + echecs.map((e: any) => e.raison).join(" ; ") : null;
          Object.assign(etat, { ecrites, echecs, usage, duree_etapes_ms: durees, libelle: "Terminée" });
          await finir({
            ecrites, echecs, usage, duree_etapes_ms: durees, libelle: "Terminée", propositions: null,
            reponse_brute: { stop_reason: r.brut?.stop_reason, content: alleger(r.brut?.content), resume: {
              thematiques: ecrites.length, non_redigees: echecs.length,
              sources_verifiees: ecrites.reduce((a: number, e: any) => a + e.sources_verifiees, 0),
              sources_total: ecrites.reduce((a: number, e: any) => a + e.sources_total, 0),
            } },
          }, bilan, ecrites.length ? "terminee" : "erreur");
        } else {
          const suivante = etat.propositions[traitees];
          await patchEtat({
            ecrites, echecs, usage, etape: traitees + 2, tentatives: 0, en_vol: false,
            relance_apres: dansSecondes(DELAI_RELANCE_S), duree_etapes_ms: durees, note: r.echec ? "une thématique écartée (format invalide)" : null,
            libelle: `Rédaction de la thématique ${traitees + 1}/${etat.propositions.length} : ${suivante.titre}`,
          });
        }
      } else if (etat.phase === "fiche") {
        const r = await etapeFiche(gen, semaine, etat, budget);
        await admin.from("commando_generations").update({ prompt_envoye: r.system + "\n\n=== Consigne utilisateur ===\n" + r.consigne }).eq("id", genId);
        Object.assign(etat, { usage: r.usage, urls: r.urls });
        await finir({ usage: r.usage, urls: r.urls, libelle: "Terminée", reponse_brute: { stop_reason: r.brut?.stop_reason, content: alleger(r.brut?.content), resume: r.resume } }, null);
      } else {
        await finir({}, "Étape inconnue : " + etat.phase);
      }
    } catch (e: any) {
      const message = e?.message || String(e);
      const usage = cumulerUsage(etat.usage || {}, e?.usage || {});
      const tentatives = Number(etat.tentatives || 0);
      if (e?.code === "temps" && tentatives < 1) {
        // Étape trop longue : une seule nouvelle tentative (recherche allégée).
        await patchEtat({ usage, tentatives: tentatives + 1, en_vol: false, relance_apres: dansSecondes(DELAI_RELANCE_S), note: message + " — nouvelle tentative" });
      } else {
        Object.assign(etat, { usage });
        await finir({ usage, libelle: "Erreur", reponse_brute: e?.brut ? { stop_reason: e.brut.stop_reason, content: alleger(e.brut.content) } : undefined },
          `Étape « ${etat.libelle || etat.phase} » : ` + message);
      }
    }
  }

  // ============================================================
  //  Relance interne (cron) : exécute l'étape en attente
  // ============================================================
  if (interne) {
    const genId = String(body?.generation_id || "");
    if (!genId) return json({ error: "generation_id manquant" }, 400);
    const { data: gen } = await admin.from("commando_generations").select("id, statut, etat").eq("id", genId).maybeSingle();
    if (!gen || gen.statut !== "en_cours") return json({ ignore: true });
    if (Date.now() - BOOT > AGE_MAX_MS) {
      // Processus réutilisé : budget incertain, on laisse le cron relancer sur un processus neuf.
      await admin.from("commando_generations").update({ etat: { ...(gen.etat || {}), en_vol: false, relance_apres: dansSecondes(DELAI_RELANCE_S) } }).eq("id", genId);
      return json({ differe: true }, 202);
    }
    // @ts-ignore EdgeRuntime est fourni par l'environnement Supabase.
    EdgeRuntime.waitUntil(executerEtape(genId));
    return json({ generation_id: genId, statut: "en_cours", etape: gen.etat?.etape }, 202);
  }

  // ============================================================
  //  Lancement par le responsable
  // ============================================================
  const type: string = ["veille", "regeneration", "fiche_rex"].includes(body?.type) ? body.type : "veille";
  const semaineId: string = String(body?.semaine_id || "");
  const thematiqueId: string | null = body?.thematique_id ? String(body.thematique_id) : null;

  const { data: semaine } = await admin.from("commando_semaines").select("*").eq("id", semaineId).maybeSingle();
  if (!semaine) return json({ error: "Semaine introuvable" }, 400);

  if (type !== "fiche_rex") {
    if (!params.fiche_rex || !params.fiche_rex_validee_le) return json({ error: "La fiche Rex-Rotary doit être validée avant de lancer la veille." }, 400);
    const { count } = await admin.from("commando_generations").select("id", { count: "exact", head: true })
      .eq("semaine_id", semaineId).in("type", ["veille", "regeneration"]);
    if ((count || 0) >= Number(params.limite_generations_semaine || 5)) {
      return json({ error: `Limite atteinte : ${count} générations déjà lancées cette semaine (paramètre : ${params.limite_generations_semaine}).` }, 429);
    }
  }
  const { data: enCours } = await admin.from("commando_generations").select("id").eq("semaine_id", semaineId).eq("statut", "en_cours").limit(1);
  if (enCours && enCours.length) return json({ error: "Une génération est déjà en cours pour cette semaine." }, 409);

  let etatInitial: any;
  if (type === "fiche_rex") {
    etatInitial = { phase: "fiche", etape: 1, total: 1, libelle: "Lecture du site et rédaction du brouillon" };
  } else if (type === "regeneration") {
    const { data: cible } = await admin.from("commando_thematiques").select("id, titre").eq("id", thematiqueId || "").maybeSingle();
    if (!cible) return json({ error: "Thématique à régénérer introuvable" }, 400);
    const { data: autres } = await admin.from("commando_thematiques").select("titre").eq("semaine_id", semaineId).neq("id", cible.id);
    etatInitial = {
      phase: "recherche", etape: 1, total: 2, attendu: 1, thematique_id: cible.id,
      autres_titres: (autres || []).map((t: any) => "« " + t.titre + " »").join(", ") || "aucune",
      libelle: "Recherche d'une nouvelle thématique",
    };
  } else {
    etatInitial = { phase: "recherche", etape: 1, total: 6, attendu: 5, libelle: "Veille d'actualité et concurrentielle (recherche web)" };
  }
  Object.assign(etatInitial, { en_vol: true, phase_debut: new Date().toISOString(), tentatives: 0, propositions: [], ecrites: [], urls: [], usage: {} });

  // Mode « aperçu du prompt » : prompt complet rempli et estimation, sans appeler le modèle.
  if (body?.apercu === true) {
    const vars = await contexte(semaine);
    const system = remplirPrompt(type === "fiche_rex" ? PROMPT_FICHE : PROMPT_VEILLE, { ...vars, site_rex: params.site_rex });
    return json({ prompt_version: PROMPT_VERSION, modele, system, caracteres: system.length, etapes: etatInitial.total,
      estimation: { hypothese: "12 recherches, 60 000 jetons en entrée, 20 000 en sortie", cout: estimerCout(modele, { input_tokens: 60000, output_tokens: 20000, web_search_requests: 12 }) } });
  }

  const { data: gen, error: gErr } = await admin.from("commando_generations").insert({
    semaine_id: semaineId, type, modele, prompt_version: PROMPT_VERSION, lancee_par: callerId, etat: etatInitial,
  }).select("id").single();
  if (gErr || !gen) return json({ error: "Création de la génération impossible : " + (gErr?.message || "") }, 500);

  if (Date.now() - BOOT > AGE_MAX_MS) {
    // Processus réutilisé : première étape confiée au cron (processus neuf).
    await admin.from("commando_generations").update({ etat: { ...etatInitial, en_vol: false, relance_apres: new Date().toISOString() } }).eq("id", gen.id);
  } else {
    // @ts-ignore EdgeRuntime est fourni par l'environnement Supabase.
    EdgeRuntime.waitUntil(executerEtape(gen.id));
  }
  return json({ generation_id: gen.id, statut: "en_cours", etapes: etatInitial.total }, 202);
});
