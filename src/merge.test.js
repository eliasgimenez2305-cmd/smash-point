/* Tests de la mezcla de cambios simultáneos sobre un torneo (merge.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTournament, isStaleRemote, matchChanges, applyMatchChanges } from "./merge.js";

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

test("recarga automática: una versión más vieja que la guardada no se aplica", () => {
  assert.equal(isStaleRemote({ rev: 8 }, { rev: 7 }), true, "la lectura salió antes del último guardado");
  assert.equal(isStaleRemote({ rev: 8 }, { rev: 8 }), false);
  assert.equal(isStaleRemote({ rev: 8 }, { rev: 9 }), false, "otra persona guardó después: se aplica");
  assert.equal(isStaleRemote(undefined, { rev: 3 }), false, "torneo nuevo para este navegador");
  assert.equal(isStaleRemote({ rev: 2 }, {}), true, "sin versión cuenta como la 0");
});

/* Resultados de a partido (matchChanges / applyMatchChanges) */
const torneo = () => ({
  id: "t", rev: 7, name: "Torneo",
  categories: [{
    id: "6ta", name: "6TA", pairs: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }],
    groups: [{ id: "g", name: "Grupo A", format: "roundrobin", matches: [{ id: "m1", pairA: "p1", pairB: "p2", sets: [] }, { id: "m2", pairA: "p3", pairB: "p4", sets: [] }] }],
    bracket: [[{ id: "b1", pairA: "p1", pairB: "p3", sets: [] }], [{ id: "b2", pairA: null, pairB: null, sets: [] }]],
  }],
});
const setMatch = (t, id, patch) => ({
  ...t,
  categories: t.categories.map((c) => ({
    ...c,
    groups: c.groups.map((g) => ({ ...g, matches: g.matches.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    bracket: c.bracket.map((r) => r.map((m) => (m.id === id ? { ...m, ...patch } : m))),
  })),
});

test("solo resultados: matchChanges devuelve cada partido con lo que cambió", () => {
  const base = torneo();
  const next = setMatch(setMatch(base, "m1", { sets: [{ a: 6, b: 3 }, { a: 6, b: 4 }] }), "b1", { walkover: "p3", schedule: { date: "2026-10-25", time: "10:00", court: 2 } });
  assert.deepEqual(matchChanges(base, next), [
    { categoria: "6ta", partido: "m1", cambios: { sets: [{ a: 6, b: 3 }, { a: 6, b: 4 }] } },
    { categoria: "6ta", partido: "b1", cambios: { walkover: "p3", schedule: { date: "2026-10-25", time: "10:00", court: 2 } } },
  ]);
});

test("borrar un resultado viaja como null", () => {
  const base = setMatch(torneo(), "m1", { liveStatus: "en_curso" });
  assert.deepEqual(matchChanges(base, setMatch(base, "m1", { liveStatus: null })), [{ categoria: "6ta", partido: "m1", cambios: { liveStatus: null } }]);
});

test("lo que se deduce de los resultados (avance en la llave) no cuenta como cambio de estructura", () => {
  const base = torneo();
  const next = setMatch(setMatch(base, "b1", { sets: [{ a: 6, b: 0 }, { a: 6, b: 0 }] }), "b2", { pairA: "p1" });
  assert.deepEqual(matchChanges(base, next), [{ categoria: "6ta", partido: "b1", cambios: { sets: [{ a: 6, b: 0 }, { a: 6, b: 0 }] } }]);
});

test("cambiar parejas, grupos o datos del torneo: se guarda entero (null)", () => {
  const base = torneo();
  assert.equal(matchChanges(base, { ...base, name: "Otro" }), null);
  assert.equal(matchChanges(base, { ...base, categories: [{ ...base.categories[0], pairs: [...base.categories[0].pairs, { id: "p5" }] }] }), null);
  assert.equal(matchChanges(base, setMatch(base, "b1", { pairA: "p2" })), null, "editar un cruce de primera ronda es estructura");
  assert.equal(matchChanges(undefined, base), null, "torneo nuevo");
});

test("sin cambios: lista vacía (el orden de las claves no importa)", () => {
  const base = torneo();
  const reordered = JSON.parse(JSON.stringify(base, Object.keys(base).reverse()));
  assert.deepEqual(matchChanges(base, { ...base }), []);
  assert.deepEqual(matchChanges(base, { ...reordered, categories: base.categories }), []);
});

test("applyMatchChanges aplica sobre otra versión y avisa los partidos que ya no están", () => {
  const remote = setMatch(torneo(), "m2", { sets: [{ a: 7, b: 5 }, { a: 6, b: 2 }] });
  const { tournament, omitted } = applyMatchChanges(remote, [
    { categoria: "6ta", partido: "m1", cambios: { sets: [{ a: 6, b: 3 }, { a: 6, b: 4 }] } },
    { categoria: "6ta", partido: "viejo", cambios: { sets: [] } },
  ]);
  const ms = tournament.categories[0].groups[0].matches;
  assert.equal(ms[0].sets[0].a, 6);
  assert.equal(ms[1].sets[0].a, 7, "lo del otro celular se conserva");
  assert.deepEqual(omitted, ["viejo"]);
});

test("choque al guardar entero: si el otro solo cargó resultados, quedan los dos cambios", () => {
  const base = torneo();
  const mine = { ...base, categories: [{ ...base.categories[0], pairs: [...base.categories[0].pairs, { id: "p5" }] }] };
  const remote = { ...setMatch(base, "m2", { sets: [{ a: 7, b: 5 }, { a: 6, b: 2 }] }), rev: 9 };
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.rev, 9);
  assert.equal(merged.categories[0].pairs.length, 5, "mi pareja nueva");
  assert.equal(merged.categories[0].groups[0].matches[1].sets[0].a, 7, "su resultado");
});

test("el mismo dato con las claves en otro orden no cuenta como cambio (no hay choque falso)", () => {
  const base = { id: "t", rev: 1, status: "Próximo", categories: [{ id: "c", name: "4TA", cupo: 10, pairs: [{ id: "p1", name: "A" }] }] };
  const mine = { ...base, categories: [{ ...base.categories[0], cupo: 12 }] };
  // La otra persona solo cambió el estado; su categoría vino con las claves en otro orden
  const remote = { ...base, rev: 2, status: "En curso", categories: [{ pairs: [{ name: "A", id: "p1" }], cupo: 10, name: "4TA", id: "c" }] };
  const { merged, conflicts } = mergeTournament(base, mine, remote);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.categories[0].cupo, 12, "mi cambio");
  assert.equal(merged.status, "En curso", "el suyo");
});
