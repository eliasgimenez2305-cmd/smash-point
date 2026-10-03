/* Tests de la mezcla de cambios simultáneos sobre un torneo (merge.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTournament } from "./merge.js";

const cat = (id, extra = {}) => ({ id, name: id.toUpperCase(), pairs: [], groups: [], ...extra });
const base = { id: "t", name: "Torneo", courtsCount: 4, rev: 3, categories: [cat("4ta"), cat("5ta")] };

test("cada uno cambió una categoría distinta: se guardan las dos", () => {
  const mine = { ...base, categories: [cat("4ta", { pairs: [{ id: "p1" }] }), cat("5ta")] };
  const remote = { ...base, rev: 4, categories: [cat("4ta"), cat("5ta", { pairs: [{ id: "p2" }] })] };
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.categories.map((c) => c.pairs.map((p) => p.id)), [["p1"], ["p2"]]);
  assert.equal(merged.rev, 4, "se vuelve a guardar sobre la versión actual");
});

test("los dos cambiaron la misma categoría distinto: queda la guardada y se avisa", () => {
  const mine = { ...base, categories: [cat("4ta", { pairs: [{ id: "mio" }] }), cat("5ta")] };
  const remote = { ...base, rev: 4, categories: [cat("4ta", { pairs: [{ id: "otro" }] }), cat("5ta")] };
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, ["4TA"]);
  assert.deepEqual(merged.categories[0].pairs, [{ id: "otro" }]);
});

test("los dos hicieron el mismo cambio: no hay choque", () => {
  const changed = [cat("4ta", { pairs: [{ id: "p1" }] }), cat("5ta")];
  const { conflicts } = mergeTournament(base, { ...base, categories: changed }, { ...base, rev: 4, categories: changed });
  assert.deepEqual(conflicts, []);
});

test("categoría nueva propia y categoría borrada por el otro", () => {
  const mine = { ...base, categories: [cat("4ta"), cat("5ta"), cat("6ta")] };
  const remote = { ...base, rev: 4, categories: [cat("4ta")] }; // el otro borró 5ta
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.categories.map((c) => c.id), ["4ta", "6ta"]);
});

test("datos generales: se toma el campo que cambió cada uno", () => {
  const mine = { ...base, courtsCount: 5 };
  const remote = { ...base, rev: 4, name: "Torneo nuevo" };
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.courtsCount, 5);
  assert.equal(merged.name, "Torneo nuevo");
});

test("datos generales que chocan: queda lo guardado y se avisa", () => {
  const { merged, conflicts } = mergeTournament(base, { ...base, courtsCount: 5 }, { ...base, rev: 4, courtsCount: 6 });
  assert.deepEqual(conflicts, ["datos del torneo"]);
  assert.equal(merged.courtsCount, 6);
});
