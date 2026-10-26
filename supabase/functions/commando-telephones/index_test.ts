// deno test --allow-read supabase/functions/commando-telephones/index_test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { normaliser, similarite, formaterTel } from "../_shared/telephones.ts";

Deno.test("normaliser : formes juridiques et accents retirés", () => {
  assertEquals(normaliser("SARL Boulangerie DUPONT & Fils"), ["boulangerie", "dupont", "fils"]);
  assertEquals(normaliser("Établissements Léger S.A.S."), ["leger"]);
});
Deno.test("similarite : même enseigne malgré la forme juridique", () => {
  assert(similarite(normaliser("GARAGE MARTIN SAS"), normaliser("Garage Martin")) === 1);
  assert(similarite(normaliser("PHARMACIE DU CENTRE"), normaliser("Pharmacie de la Gare")) < 0.6);
});
Deno.test("formaterTel : formats OSM courants", () => {
  assertEquals(formaterTel("+33 5 49 00 11 22"), "05 49 00 11 22");
  assertEquals(formaterTel("0549001122;0611223344"), "05 49 00 11 22");
  assertEquals(formaterTel("05.49.00.11.22"), "05 49 00 11 22");
  assertEquals(formaterTel("3631"), null);
  assertFalse(formaterTel("+44 20 1234 5678"));
});
