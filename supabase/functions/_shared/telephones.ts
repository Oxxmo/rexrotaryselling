// ============================================================
//  Rex Commando — rapprochement de téléphones (fonctions pures)
//  ------------------------------------------------------------
//  Utilisées par commando-telephones ; testées par
//  commando-telephones/index_test.ts (deno test).
// ============================================================
// ---------- Normalisation des noms ----------
const FORMES = new Set(["sarl", "sas", "sasu", "eurl", "sa", "sci", "snc", "selarl", "selas", "scp", "scm", "sca", "scop", "gie", "ei", "eirl",
  "ste", "societe", "soc", "ets", "etablissement", "etablissements", "cie", "compagnie", "groupe", "group", "entreprise", "et", "de", "du", "des", "la", "le", "les", "l", "d", "en", "a", "au", "aux", "the", "and", "&"]);
export function normaliser(s: string): string[] {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").split(" ").filter(m => m.length > 1 && !FORMES.has(m));
}
export function similarite(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let commun = 0; for (const m of A) if (B.has(m)) commun++;
  return commun / (A.size + B.size - commun);
}
/** Téléphone au format français lisible (05 49 00 00 00) quand c'est possible. */
export function formaterTel(t: string): string | null {
  let s = String(t || "").split(/[;,/]| ou /)[0].trim();
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+33")) s = "0" + s.slice(3);
  else if (s.startsWith("0033")) s = "0" + s.slice(4);
  if (!/^0[1-9]\d{8}$/.test(s)) return null;
  return s.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}
export function numeroVoie(adresse: string): string | null {
  const m = /^\s*(\d{1,4})\s?(bis|ter|[a-z])?\b/i.exec(String(adresse || ""));
  return m ? m[1] + (m[2] ? m[2].toLowerCase() : "") : null;
}

