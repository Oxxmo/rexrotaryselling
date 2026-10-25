// ============================================================
//  Rex Commando — tests de la validation de la veille IA
//    deno test --allow-read supabase/functions/_shared/validation_test.ts
// ============================================================
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  extraireJson, validerSortie, collecterUrls, verifierSources, alertes, estimerCout, normaliserUrl, remplirPrompt, alleger,
} from "./validation.ts";

const ici = new URL(".", import.meta.url).pathname;
const exemple = JSON.parse(await Deno.readTextFile(ici + "../../../docs/commando/thematiques_exemple.json"));

function cloner<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
function cinq() {
  const o = cloner(exemple);
  const t = o.thematiques[0];
  o.thematiques = [1, 2, 3, 4, 5].map(i => ({ ...cloner(t), id: t.id + "-" + i }));
  return o;
}

Deno.test("critère 3 : le fichier d'exemple passe la validation (1 thématique)", () => {
  const r = validerSortie(exemple, 1);
  assert(r.ok, JSON.stringify(!r.ok && r.erreurs));
});

Deno.test("une veille complète doit contenir 5 thématiques", () => {
  const r4 = validerSortie(exemple, 5);
  assertFalse(r4.ok);
  assert(!r4.ok && r4.erreurs.some(e => e.includes("5 attendue")));
  const r5 = validerSortie(cinq(), 5);
  assert(r5.ok);
});

Deno.test("couleur inconnue rejetée", () => {
  const o = cinq(); o.thematiques[2].regles[0].couleur = "bleu";
  const r = validerSortie(o, 5);
  assertFalse(r.ok);
});

Deno.test("une règle qui utilise un champ inconnu est rejetée", () => {
  const o = cinq(); o.thematiques[1].regles[0].si = { chiffre_affaires_min: 100000 };
  const r = validerSortie(o, 5);
  assertFalse(r.ok);
  assert(!r.ok && r.erreurs.some(e => /chiffre_affaires_min|Unrecognized|non reconnu/i.test(e)), JSON.stringify(!r.ok && r.erreurs));
});

Deno.test("tranche inconnue et ancienneté inconnue rejetées", () => {
  const o = cinq(); o.thematiques[0].regles[0].si = { tranches: ["99"] };
  assertFalse(validerSortie(o, 5).ok);
  const p = cinq(); p.thematiques[0].regles[0].si = { anciennete: ["vieux"] };
  assertFalse(validerSortie(p, 5).ok);
});

Deno.test("identifiants en double rejetés, trame manquante rejetée", () => {
  const o = cinq(); o.thematiques[1].id = o.thematiques[0].id;
  assertFalse(validerSortie(o, 5).ok);
  const p = cinq(); delete p.thematiques[0].trames.rouge;
  assertFalse(validerSortie(p, 5).ok);
});

Deno.test("extraireJson tolère le texte autour et les blocs ```json", () => {
  const txt = "Voici la veille :\n```json\n" + JSON.stringify(exemple) + "\n```\nBonne semaine.";
  const o = extraireJson(txt) as any;
  assertEquals(o.semaine, "2026-W44");
  assertEquals(extraireJson("pas de json ici"), null);
  assertEquals((extraireJson('Avant {"a":1} après') as any).a, 1);
});

Deno.test("critère 6 : une URL inventée est marquée non vérifiée, une URL réelle vérifiée", () => {
  const contenu = [
    { type: "server_tool_use", id: "x", name: "web_search", input: { query: "facturation électronique" } },
    { type: "web_search_tool_result", tool_use_id: "x", content: [
      { type: "web_search_result", url: "https://www.previssima.fr/actualite/facturation-electronique-ce-qui-change-pour-les-entreprises-des-le-1er-septembre-2026.html?utm_source=x", title: "…", encrypted_content: "abc", page_age: "September 1, 2026" },
      { type: "web_search_result", url: "https://www.economie.gouv.fr/facturation-electronique", title: "…", encrypted_content: "def" },
    ] },
    { type: "text", text: "…", citations: [{ type: "web_search_result_location", url: "https://entreprendre.service-public.fr/vosdroits/F23345", title: "t", cited_text: "c", encrypted_index: "e" }] },
  ];
  const urls = collecterUrls(contenu);
  assertEquals(urls.size, 3);
  const th = cloner(exemple.thematiques[0]);
  th.sources.push({ url: "https://www.impots.gouv.fr/page-inventee-par-le-modele", titre: "Inventée", date: "2026-10-20" });
  th.concurrence.sources = [{ url: "https://entreprendre.service-public.fr/vosdroits/F23345/", titre: "SP", date: "2026-10-18" }];
  const v = verifierSources(th, urls);
  assertEquals(v.sources[0].verifiee, true, "URL présente (normalisée : utm et www ignorés)");
  assertEquals(v.sources[1].verifiee, false, "URL inventée");
  assertEquals(v.concurrence.sources[0].verifiee, true, "barre finale ignorée");
});

Deno.test("normalisation d'URL", () => {
  assertEquals(normaliserUrl("HTTPS://WWW.Exemple.fr/a/b/?utm_campaign=x#c"), "exemple.fr/a/b");
  assertEquals(normaliserUrl("http://exemple.fr/a"), normaliserUrl("https://exemple.fr/a/"));
});

Deno.test("alerte quand aucune source n'a moins de 14 jours", () => {
  const th = cloner(exemple.thematiques[0]);
  th.sources[0].verifiee = true;
  const vieux = alertes(th, new Date("2026-10-26T08:00:00Z"));       // source du 2026-09-01 : 55 jours
  assert(vieux.some(a => a.startsWith("Aucune source datée")));
  th.sources[0].date = "2026-10-20";
  const recent = alertes(th, new Date("2026-10-26T08:00:00Z"));
  assertFalse(recent.some(a => a.startsWith("Aucune source datée")));
  th.sources[0].verifiee = false;
  assert(alertes(th, new Date("2026-10-26T08:00:00Z")).some(a => a.includes("non vérifiée")));
});

Deno.test("estimation du coût (Sonnet 5.5 : 2 $/M entrée, 10 $/M sortie, 0,01 $ par recherche)", () => {
  const c = estimerCout("claude-sonnet-5-5", { input_tokens: 50000, output_tokens: 20000, web_search_requests: 12 });
  assertEquals(Math.round(c * 100) / 100, 0.42);
});

Deno.test("remplissage des variables du prompt", () => {
  const s = remplirPrompt("A {{ x }} B {{y}} C", { x: "1" });
  assertEquals(s, "A 1 B (non renseigné) C");
});

Deno.test("alléger retire les contenus chiffrés", () => {
  const a = alleger([{ type: "web_search_result", url: "u", encrypted_content: "zzz" }]) as any[];
  assertEquals(a[0].encrypted_content, undefined);
  assertEquals(a[0].url, "u");
});

// ---------- Étape « recherche » ----------
import { validerPropositions } from "./validation.ts";

Deno.test("validerPropositions : 5 propositions documentées acceptées, extra ignoré", () => {
  const props = Array.from({ length: 6 }, (_, i) => ({
    id: "p" + i, titre: ["Cybermois réseau", "Copieurs sécurisés", "Fibre standard", "GED devis", "Serveurs sauvegarde", "Formation bureautique"][i], faits: [{ fait: "un fait", url: "https://ex.fr/" + i, date: "2026-10-20" }],
  }));
  const v = validerPropositions({ propositions: props }, 5);
  assert(v.ok);
  if (v.ok) assertEquals(v.data.length, 5);
});

Deno.test("validerPropositions : refuse une proposition sans fait sourcé et les doublons d'id", () => {
  const v = validerPropositions({ propositions: [
    { id: "a", titre: "A", faits: [] },
    { id: "a", titre: "B", faits: [{ fait: "x", url: "https://ex.fr" }] },
    { id: "c", titre: "C", faits: [{ fait: "x", url: "https://ex.fr" }] },
  ] }, 5);
  assertFalse(v.ok);
  if (!v.ok) assertEquals(v.erreurs.length, 2);
});

Deno.test("validerPropositions : régénération = 1 proposition suffit ; 2 sur 5 insuffisant", () => {
  const ok = validerPropositions({ propositions: [{ id: "a", titre: "A", faits: [{ fait: "x", url: "https://ex.fr" }] }] }, 1);
  assert(ok.ok);
  const ko = validerPropositions({ propositions: [
    { id: "a", titre: "A", faits: [{ fait: "x", url: "https://ex.fr" }] },
    { id: "b", titre: "B", faits: [{ fait: "x", url: "https://ex.fr" }] },
  ] }, 5);
  assertFalse(ko.ok);
});

// ---------- Mémoire des thématiques et familles ----------
import { tropProche } from "./validation.ts";

Deno.test("tropProche : même sujet sous un autre titre détecté, sujets différents acceptés", () => {
  assert(tropProche("Facture électronique : être prêt à recevoir les factures fournisseurs", "Facture électronique : recevoir les factures des fournisseurs"));
  assertFalse(tropProche("Fin du cuivre dans la Vienne : anticiper le standard téléphonique", "Cybermois : un réseau de TPE mieux protégé"));
});

Deno.test("validerPropositions : famille exclue et titre déjà vu refusés", () => {
  const props = [
    { id: "a", titre: "Téléphonie : préparer la fin du cuivre", famille: "telephonie", faits: [{ fait: "x", url: "https://ex.fr" }] },
    { id: "b", titre: "Cybermois : un réseau de TPE et PME mieux protégé", famille: "cyber", faits: [{ fait: "x", url: "https://ex.fr" }] },
    { id: "c", titre: "GED : classer les devis", famille: "ged", faits: [{ fait: "x", url: "https://ex.fr" }] },
  ];
  const v = validerPropositions({ propositions: props }, 3, 3, { exclues: ["telephonie"], anciens: ["Cybermois : un réseau de TPE/PME mieux protégé en 30 minutes"] });
  assertFalse(v.ok);
  if (!v.ok) assertEquals(v.erreurs.length, 2);
  const ok = validerPropositions({ propositions: props }, 3, 3, {});
  assert(ok.ok);
});
