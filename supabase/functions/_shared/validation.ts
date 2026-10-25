// ============================================================
//  Rex Commando — validation de la sortie de la veille IA
//  ------------------------------------------------------------
//  Fonctions pures, sans accès réseau ni base, testées par
//  validation_test.ts (deno test). Utilisées par commando-veille.
//
//   * extraireJson      : isole l'objet JSON dans le texte du modèle
//   * validerSortie     : schéma strict (Zod) ; une règle avec un champ
//                         inconnu est rejetée
//   * collecterUrls     : URL réellement renvoyées par la recherche web
//   * verifierSources   : marque chaque source « vérifiée » si son URL
//                         figure parmi les résultats de recherche
//   * alertes           : thématique sans source de moins de 14 jours…
//   * estimerCout       : coût en dollars d'une génération
// ============================================================
import { z } from "npm:zod@3";

export const COULEURS = ["vert", "orange", "rouge"] as const;
export const TRANCHES_OK = ["00", "01", "02", "03", "11", "12", "21", "22", "31", "32", "41", "42", "51", "52", "53"] as const;
export const ANCIENNETE_OK = ["moins_3", "3_5", "plus_5"] as const;
const NAF_PREFIXE = /^[0-9]{2}(\.?[0-9]{1,2}[A-Z]?)?$/;

const Source = z.object({
  url: z.string().min(1),
  titre: z.string().default(""),
  date: z.string().nullable().optional(),
}).passthrough();

// `.strict()` : tout champ inconnu dans « si » fait échouer la validation.
const Si = z.object({
  naf_prefixes: z.array(z.string().regex(NAF_PREFIXE, "préfixe NAF invalide")).optional(),
  naf_exclus: z.array(z.string().regex(NAF_PREFIXE, "préfixe NAF invalide")).optional(),
  tranches: z.array(z.enum(TRANCHES_OK)).optional(),
  anciennete: z.array(z.enum(ANCIENNETE_OK)).optional(),
}).strict();

const Regle = z.object({
  couleur: z.enum(COULEURS),
  si: Si,
  raison: z.string().default(""),
});

const Trame = z.object({
  accroche: z.string().default(""),
  questions_decouverte: z.array(z.string()).default([]),
  argument: z.string().default(""),
  conclusion: z.string().default(""),
});

const Objection = z.object({ objection: z.string(), reponse: z.string() });

export const Thematique = z.object({
  id: z.string().min(1),
  titre: z.string().min(1),
  offre_rex: z.string().default(""),
  pourquoi_maintenant: z.string().default(""),
  sources: z.array(Source).default([]),
  concurrence: z.object({
    constat: z.string().default(""),
    angle_rex: z.string().default(""),
    sources: z.array(Source).default([]),
  }).default({ constat: "", angle_rex: "", sources: [] }),
  regles: z.array(Regle).min(1, "au moins une règle"),
  trames: z.object({ vert: Trame, orange: Trame, rouge: Trame }),
  objections: z.array(Objection).default([]),
  hypotheses: z.array(z.string()).default([]),
});
export type ThematiqueT = z.infer<typeof Thematique>;

export const SortieVeille = z.object({
  semaine: z.string().regex(/^\d{4}-W\d{2}$/, "semaine au format AAAA-Www"),
  genere_le: z.string().optional(),
  thematiques: z.array(Thematique),
}).passthrough(); // tolère « _commentaire » et autres champs annexes

export type SortieVeilleT = z.infer<typeof SortieVeille>;

// ---------- Étape « recherche » : notes de veille avant rédaction ----------
// La veille est découpée en étapes courtes (limite de durée des Edge
// Functions) : l'étape 1 produit des propositions documentées, les étapes
// suivantes rédigent une thématique complète à la fois.
const Fait = z.object({
  fait: z.string().min(1),
  url: z.string().min(1),
  titre: z.string().default(""),
  date: z.string().nullable().optional(),
}).passthrough();

export const Proposition = z.object({
  id: z.string().min(1),
  titre: z.string().min(1),
  sujet: z.string().default(""),
  offre_rex: z.string().default(""),
  pourquoi_maintenant: z.string().default(""),
  faits: z.array(Fait).default([]),
  concurrence: z.object({
    constat: z.string().default(""),
    angle_rex: z.string().default(""),
    sources: z.array(Source).default([]),
  }).default({ constat: "", angle_rex: "", sources: [] }),
  pistes_regles: z.string().default(""),
}).passthrough();
export type PropositionT = z.infer<typeof Proposition>;

export const SortieRecherche = z.object({
  propositions: z.array(Proposition),
}).passthrough();

/** Validation des notes de veille. `attendu` = nombre de propositions demandé ; `minimum` = nombre accepté. */
export function validerPropositions(obj: unknown, attendu: number, minimum: number = Math.min(3, attendu)):
  { ok: true; data: PropositionT[] } | { ok: false; erreurs: string[] } {
  if (obj === null || typeof obj !== "object") return { ok: false, erreurs: ["La réponse n'est pas un objet JSON."] };
  const res = SortieRecherche.safeParse(obj);
  if (!res.success) {
    return { ok: false, erreurs: res.error.issues.slice(0, 12).map(i => (i.path.length ? i.path.join(".") + " : " : "") + i.message) };
  }
  const erreurs: string[] = [];
  const props = res.data.propositions.slice(0, attendu);
  if (props.length < minimum) erreurs.push(`${props.length} proposition(s) reçue(s), au moins ${minimum} attendue(s) (${attendu} demandées).`);
  const ids = new Set<string>();
  props.forEach((p, i) => {
    if (ids.has(p.id)) erreurs.push(`Proposition ${i + 1} : identifiant « ${p.id} » en double.`);
    ids.add(p.id);
    if (!p.faits.length) erreurs.push(`Proposition ${i + 1} (« ${p.titre} ») : aucun fait sourcé.`);
  });
  return erreurs.length ? { ok: false, erreurs } : { ok: true, data: props };
}

/** Isole l'objet JSON dans la réponse (texte, éventuellement entouré de ``` ou de phrases). */
export function extraireJson(texte: string): unknown | null {
  if (!texte) return null;
  let t = texte.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const debut = t.indexOf("{"), fin = t.lastIndexOf("}");
  if (debut < 0 || fin <= debut) return null;
  try { return JSON.parse(t.slice(debut, fin + 1)); } catch { return null; }
}

/** Validation complète. `attendu` = nombre de thématiques exigé (5 pour une veille, 1 pour une régénération, null = libre). */
export function validerSortie(obj: unknown, attendu: number | null = 5):
  { ok: true; data: SortieVeilleT } | { ok: false; erreurs: string[] } {
  if (obj === null || typeof obj !== "object") return { ok: false, erreurs: ["La réponse n'est pas un objet JSON."] };
  const res = SortieVeille.safeParse(obj);
  if (!res.success) {
    const erreurs = res.error.issues.slice(0, 12).map(i => (i.path.length ? i.path.join(".") + " : " : "") + i.message);
    return { ok: false, erreurs };
  }
  const erreurs: string[] = [];
  if (attendu != null && res.data.thematiques.length !== attendu) {
    erreurs.push(`${res.data.thematiques.length} thématique(s) reçue(s), ${attendu} attendue(s).`);
  }
  const ids = new Set<string>();
  res.data.thematiques.forEach((t, i) => {
    if (ids.has(t.id)) erreurs.push(`Thématique ${i + 1} : identifiant « ${t.id} » en double.`);
    ids.add(t.id);
    t.regles.forEach((r, j) => {
      if (Object.keys(r.si).length === 0 && j < t.regles.length - 1) {
        erreurs.push(`Thématique ${i + 1}, règle ${j + 1} : règle sans condition placée avant d'autres règles (elle les rendrait inutiles).`);
      }
    });
  });
  return erreurs.length ? { ok: false, erreurs } : { ok: true, data: res.data };
}

/** Normalisation d'URL pour la comparaison (schéma, casse de l'hôte, www, barre finale, paramètres de suivi, ancre). */
export function normaliserUrl(u: string): string {
  try {
    const url = new URL(String(u).trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(k)) url.searchParams.delete(k);
    }
    let s = url.hostname + url.pathname.replace(/\/+$/, "") + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
    return s.toLowerCase();
  } catch { return String(u).trim().toLowerCase(); }
}

/** Parcourt récursivement les blocs de contenu de l'API et renvoie toutes les URL de résultats de recherche et de citations. */
export function collecterUrls(contenu: unknown, acc: Set<string> = new Set()): Set<string> {
  const visiter = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(visiter); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if ((o.type === "web_search_result" || o.type === "web_search_result_location" || o.type === "web_fetch_result") && typeof o.url === "string") acc.add(o.url);
    for (const v of Object.values(o)) if (v && typeof v === "object") visiter(v);
  };
  visiter(contenu);
  return acc;
}

type SourceT = { url: string; titre?: string; date?: string | null; verifiee?: boolean } & Record<string, unknown>;

/** Marque chaque source (thématique et concurrence) selon sa présence parmi les URL réellement renvoyées par la recherche. */
export function verifierSources<T extends { sources: SourceT[]; concurrence: { sources: SourceT[] } }>(th: T, urlsReelles: Set<string>): T {
  const norm = new Set(Array.from(urlsReelles).map(normaliserUrl));
  const marquer = (s: SourceT): SourceT => ({ ...s, verifiee: norm.has(normaliserUrl(s.url)) });
  return {
    ...th,
    sources: th.sources.map(marquer),
    concurrence: { ...th.concurrence, sources: (th.concurrence.sources || []).map(marquer) },
  };
}

/** Alertes à afficher dans la console (séparées des faits). */
export function alertes(th: { sources: SourceT[]; concurrence?: { sources?: SourceT[] } }, maintenant: Date = new Date(), joursMax = 14): string[] {
  const out: string[] = [];
  const limite = maintenant.getTime() - joursMax * 86400000;
  const recente = th.sources.some(s => {
    const d = s.date ? Date.parse(String(s.date)) : NaN;
    return Number.isFinite(d) && d >= limite && d <= maintenant.getTime() + 86400000;
  });
  if (!recente) out.push(`Aucune source datée de moins de ${joursMax} jours`);
  const nonVerif = th.sources.filter(s => s.verifiee !== true).length;
  if (nonVerif) out.push(`${nonVerif} source(s) non vérifiée(s) : URL absente des résultats de recherche`);
  if (!th.sources.length) out.push("Aucune source");
  return out;
}

/** Tarifs (dollars par million de jetons) et prix d'une recherche web. */
export const PRIX: Record<string, { entree: number; sortie: number; cache: number }> = {
  "claude-sonnet-5-5": { entree: 2, sortie: 10, cache: 0.2 },
  "claude-sonnet-5": { entree: 2, sortie: 10, cache: 0.2 },
  "claude-opus-5-5": { entree: 4, sortie: 20, cache: 0.2 },
  "claude-haiku-5-5": { entree: 0.1, sortie: 0.5, cache: 0.01 },
};
export const PRIX_RECHERCHE = 0.01; // 10 $ pour 1 000 recherches

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; web_search_requests?: number };

export function estimerCout(modele: string, u: Usage): number {
  const p = PRIX[modele] || PRIX["claude-sonnet-5-5"];
  const entree = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const cout = entree / 1e6 * p.entree + (u.cache_read_input_tokens || 0) / 1e6 * p.cache
    + (u.output_tokens || 0) / 1e6 * p.sortie + (u.web_search_requests || 0) * PRIX_RECHERCHE;
  return Math.round(cout * 10000) / 10000;
}

/** Additionne les compteurs d'usage de plusieurs appels. */
export function cumulerUsage(a: Usage, b: Usage): Usage {
  const k: (keyof Usage)[] = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "web_search_requests"];
  const out: Usage = {};
  for (const key of k) out[key] = (a[key] || 0) + (b[key] || 0);
  return out;
}

/** Remplace les {{variables}} d'un prompt ; une variable absente devient « (non renseigné) ». */
export function remplirPrompt(prompt: string, vars: Record<string, string | null | undefined>): string {
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    return v == null || v === "" ? "(non renseigné)" : String(v);
  });
}

/** Retire les contenus chiffrés (volumineux, inutiles à conserver) avant archivage de la réponse brute. */
export function alleger(contenu: unknown): unknown {
  if (Array.isArray(contenu)) return contenu.map(alleger);
  if (!contenu || typeof contenu !== "object") return contenu;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(contenu as Record<string, unknown>)) {
    if (k === "encrypted_content" || k === "encrypted_index") continue;
    out[k] = alleger(v);
  }
  return out;
}
