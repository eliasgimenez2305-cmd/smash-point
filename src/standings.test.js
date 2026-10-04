/* Tests de la tabla de posiciones (computeStandings). Se corren con `npm test`.
   Criterio de desempate (igual para todos los torneos): diferencia de sets, diferencia de games,
   games a favor, games en contra, resultado entre sí y sorteo (ver standings.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStandings, DEFAULT_MATCH_FORMAT } from "./standings.js";

const CLASICO = DEFAULT_MATCH_FORMAT; // al mejor de 3, sets a 6, super tie-break en el tercero
const SUPER8_4 = { type: "super8", setsToPlay: 1, gamesPerSet: 4, setTiebreak: true, finalSuperTiebreak: false };
const AMERICANO_7 = { type: "americano", setsToPlay: 1, gamesPerSet: 7, setTiebreak: true, finalSuperTiebreak: false };

/* Partido con resultado: m("A", "B", [6, 3], [6, 4]) → A ganó 6-3 6-4 */
const m = (pairA, pairB, ...sets) => ({ pairA, pairB, sets: sets.map(([a, b]) => ({ a, b })) });
/* W.O.: wo("A", "B", "B") → B no se presentó (pierde ese partido y sigue en el torneo) */
const wo = (pairA, pairB, gaveWalkover) => ({ pairA, pairB, sets: [], walkover: gaveWalkover });
const group = (pairIds, matches, extra = {}) => ({ id: "g1", name: "Grupo A", pairIds, format: "roundrobin", matches, ...extra });
const order = (rows) => rows.map((r) => r.pairId);
const row = (rows, id) => rows.find((r) => r.pairId === id);

test("sin empate: ordena por puntos", () => {
  const rows = computeStandings(group(["A", "B", "C"], [m("A", "B", [6, 1], [6, 1]), m("A", "C", [6, 2], [6, 2]), m("B", "C", [6, 3], [6, 3])]), {}, CLASICO);
  assert.deepEqual(order(rows), ["A", "B", "C"]);
  assert.equal(row(rows, "A").pts, 4);
});

test("empate de a dos: manda la diferencia de games antes que el resultado entre sí", () => {
  // A y B ganan 2 partidos cada uno; A le ganó a B. B tiene mucha mejor diferencia de games.
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "B", [7, 6], [7, 6]),
    m("A", "C", [7, 5], [7, 5]),
    m("B", "C", [6, 0], [6, 0]),
    m("B", "D", [6, 0], [6, 0]),
    m("A", "D", [5, 7], [5, 7]),
    m("C", "D", [6, 4], [6, 4]),
  ]), {}, CLASICO);
  assert.equal(row(rows, "A").pts, row(rows, "B").pts);
  assert.ok(order(rows).indexOf("B") < order(rows).indexOf("A"), "B va arriba de A por diferencia de games (+22 contra +2)");
});

test("Súper 8 a un set: entre empatadas manda la diferencia de games aunque el otro haya ganado entre sí", () => {
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "B", [4, 3]),
    m("A", "C", [4, 3]),
    m("A", "D", [0, 4]),
    m("B", "C", [4, 0]),
    m("B", "D", [4, 0]),
    m("C", "D", [4, 0]),
  ]), {}, SUPER8_4);
  // A y B ganan 2. A: games 8-10 (-2) | B: games 11-4 (+7)
  assert.deepEqual(order(rows).slice(0, 2), ["B", "A"]);
});

test("empate en sets y games: mandan los games a favor", () => {
  // A y B ganan 2 y tienen la misma diferencia de sets (+4) y de games (+4), pero A hizo más games
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "C", [7, 6], [7, 6]),  // A 14-12
    m("A", "D", [7, 6], [7, 6]),  // A 14-12 → A 28-24 (+4)
    m("B", "C", [6, 5], [6, 5]),  // B 12-10
    m("B", "D", [6, 5], [6, 5]),  // B 12-10 → B 24-20 (+4)
  ]), {}, CLASICO);
  assert.deepEqual(order(rows).slice(0, 2), ["A", "B"]);
});

test("empate en sets y en games: manda el resultado entre sí", () => {
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "B", [6, 4], [6, 4]),
    m("A", "C", [4, 6], [4, 6]),
    m("B", "C", [6, 4], [6, 4]),
    m("A", "D", [6, 0], [6, 0]),
    m("B", "D", [6, 0], [6, 0]),
    m("D", "C", [6, 4], [6, 4]),
  ]), {}, CLASICO);
  // A y B: 2 ganados, sets 4-2, games 32-20 las dos. A le ganó a B.
  const a = row(rows, "A"), b = row(rows, "B");
  assert.deepEqual([a.setsF, a.setsC, a.gamesF, a.gamesC], [b.setsF, b.setsC, b.gamesF, b.gamesC]);
  assert.deepEqual(order(rows).slice(0, 2), ["A", "B"]);
  assert.ok(!a.byDraw && !b.byDraw, "no se definió por sorteo");
});

test("triple empate: diferencia de sets", () => {
  // Círculo: A le gana a B, B a C, C a A. Todos 1 ganado y 1 perdido.
  // Sets entre ellos: A 2-0 y 1-2 → +1 | B 2-1 y 0-2 → -1 | C 2-0... ver abajo
  const rows = computeStandings(group(["A", "B", "C"], [
    m("A", "B", [6, 1], [6, 1]),          // A 2-0
    m("B", "C", [6, 4], [4, 6], [10, 8]), // B 2-1
    m("C", "A", [6, 4], [3, 6], [10, 5]), // C 2-1
  ]), {}, CLASICO);
  // Diferencia de sets: A = 2-0 + 1-2 → +1 | B = 0-2 + 2-1 → -1 | C = 1-2 + 2-1 → 0
  assert.deepEqual(order(rows), ["A", "C", "B"]);
});

test("triple empate: iguales en sets, desempata la diferencia de games", () => {
  // Todos ganan y pierden 2-0: diferencia de sets 0 para los tres. Games: A +8, B -2, C -6
  const rows = computeStandings(group(["A", "B", "C"], [
    m("A", "B", [6, 1], [6, 1]), // A +10, B -10
    m("B", "C", [6, 2], [6, 2]), // B +8,  C -8
    m("C", "A", [6, 5], [7, 5]), // C +3,  A -3
  ]), {}, CLASICO);
  // A: +10 -3 = +7 | B: -10 +8 = -2 | C: -8 +3 = -5
  assert.deepEqual(order(rows), ["A", "B", "C"]);
});

test("triple empate: cuentan todos los partidos del grupo, no solo los partidos entre las empatadas", () => {
  // A, B y C empatan en 2 ganados; D pierde todo. Contra D, C gana 6-0 6-0 y eso le sirve.
  // Games: A 34-23 (+11) | C 29-22 (+7) | B 26-24 (+2)
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "B", [6, 1], [6, 1]),
    m("B", "C", [6, 2], [6, 2]),
    m("C", "A", [6, 5], [7, 5]),
    m("A", "D", [6, 4], [6, 4]),
    m("B", "D", [6, 4], [6, 4]),
    m("C", "D", [6, 0], [6, 0]),
  ]), {}, CLASICO);
  assert.deepEqual(order(rows), ["A", "C", "B", "D"]);
});

test("triple empate sin diferencias: se define por sorteo, siempre igual y marcado", () => {
  const partidos = [m("A", "B", [6, 3], [3, 6], [10, 5]), m("B", "C", [6, 3], [3, 6], [10, 5]), m("C", "A", [6, 3], [3, 6], [10, 5])];
  const first = computeStandings(group(["A", "B", "C"], partidos), {}, CLASICO);
  const again = computeStandings(group(["A", "B", "C"], partidos), {}, CLASICO);
  assert.deepEqual(order(first), order(again), "el sorteo no cambia entre una vista y otra");
  assert.ok(first.every((r) => r.byDraw), "las tres quedan marcadas como definidas por sorteo");
});

test("super tie-break: cuenta como un set y como un game para el que lo gana", () => {
  const rows = computeStandings(group(["A", "B"], [m("A", "B", [6, 4], [3, 6], [10, 7])]), {}, CLASICO);
  const a = row(rows, "A"), b = row(rows, "B");
  assert.equal(a.setsF, 2); assert.equal(a.setsC, 1);
  assert.equal(a.gamesF, 6 + 3 + 1); assert.equal(a.gamesC, 4 + 6);
  assert.equal(b.gamesF, 4 + 6); assert.equal(b.gamesC, 6 + 3 + 1);
  assert.equal(a.stb, 1); assert.equal(b.stb, 0);
});

test("W.O.: cuenta 6-0 6-0 en sets y games para el que se presentó", () => {
  const rows = computeStandings(group(["A", "B"], [wo("A", "B", "B")]), {}, CLASICO);
  const a = row(rows, "A"), b = row(rows, "B");
  assert.equal(a.pts, 2); assert.equal(a.pg, 1); assert.equal(b.pp, 1); assert.equal(b.pts, 0);
  assert.deepEqual([a.setsF, a.setsC, a.gamesF, a.gamesC], [2, 0, 12, 0]);
  assert.deepEqual([b.setsF, b.setsC, b.gamesF, b.gamesC], [0, 2, 0, 12]);
  assert.equal(b.wo, 1); assert.equal(a.wo, 0);
  assert.equal(b.eliminated, false, "el W.O. no elimina");
});

test("W.O. en Americano a 7: un set 7-0", () => {
  const rows = computeStandings(group(["A", "B"], [wo("A", "B", "A")]), {}, AMERICANO_7);
  const b = row(rows, "B");
  assert.deepEqual([b.setsF, b.setsC, b.gamesF, b.gamesC], [1, 0, 7, 0]);
});

test("W.O. afecta solo ese partido: la pareja sigue y puede clasificar", () => {
  // M ganó 6-0 6-0, después dio W.O. (llegó tarde) y X le ganó a Y. Los tres con 2 puntos:
  // games entre ellas: Y +8, M 0, X -8. M queda segunda, como cualquier otra pareja.
  const rows = computeStandings(group(["M", "X", "Y"], [
    m("M", "X", [6, 0], [6, 0]),
    wo("M", "Y", "M"),
    m("X", "Y", [6, 4], [6, 4]),
  ]), {}, CLASICO);
  assert.deepEqual(order(rows), ["Y", "M", "X"]);
  assert.equal(row(rows, "M").eliminated, false);
});

test("W.O.: si tiene más puntos que el resto, queda primero", () => {
  const rows = computeStandings(group(["M", "X", "Y", "Z"], [
    m("M", "X", [6, 0], [6, 0]),
    m("M", "Y", [6, 0], [6, 0]),
    wo("M", "Z", "M"),
  ]), {}, CLASICO);
  assert.equal(row(rows, "M").pts, 4);
  assert.equal(order(rows)[0], "M");
});

test("W.O.: los partidos que jugó antes siguen valiendo para sus rivales", () => {
  const rows = computeStandings(group(["M", "X", "Y"], [
    m("X", "M", [6, 2], [6, 2]),
    wo("M", "Y", "M"),
  ]), {}, CLASICO);
  const x = row(rows, "X"), m_ = row(rows, "M");
  assert.equal(x.pts, 2); assert.equal(x.gamesF, 12);
  assert.equal(m_.pj, 2, "M conserva todos sus resultados en la tabla");
});

test("dos W.O. de la misma pareja: se hunde sola al fondo, sin regla especial", () => {
  const rows = computeStandings(group(["P", "A", "B"], [
    wo("P", "A", "P"),
    wo("P", "B", "P"),
    m("A", "B", [6, 3], [6, 3]),
  ]), {}, CLASICO);
  const p = row(rows, "P");
  assert.equal(order(rows)[2], "P");
  assert.equal(p.wo, 2); assert.equal(p.eliminated, false);
  assert.equal(p.gamesF - p.gamesC, -24);
});

test("pareja eliminada por el organizador: va al fondo aunque tenga más puntos", () => {
  const rows = computeStandings(group(["M", "X", "Y", "Z"], [
    m("M", "X", [6, 0], [6, 0]),
    m("M", "Y", [6, 0], [6, 0]),
    m("Z", "X", [6, 4], [6, 4]),
  ]), { M: { eliminated: true } }, CLASICO);
  assert.equal(row(rows, "M").pts, 4);
  assert.equal(row(rows, "M").eliminated, true);
  assert.equal(order(rows)[3], "M");
});

test("pareja eliminada: sus partidos jugados siguen valiendo para sus rivales", () => {
  const rows = computeStandings(group(["M", "X", "Y"], [
    m("X", "M", [6, 2], [6, 2]),
  ]), { M: { eliminated: true } }, CLASICO);
  const x = row(rows, "X");
  assert.equal(x.pts, 2); assert.equal(x.gamesF, 12);
  assert.equal(row(rows, "M").pj, 1);
});

test("dos eliminadas en el mismo grupo: las dos al fondo, ordenadas entre ellas con el mismo desempate", () => {
  const rows = computeStandings(group(["A", "B", "P", "Q"], [
    m("P", "A", [6, 1], [6, 1]), // P gana antes de abandonar
    m("Q", "A", [1, 6], [1, 6]), // Q pierde antes de abandonar
    m("A", "B", [6, 3], [6, 3]),
  ]), { P: { eliminated: true }, Q: { eliminated: true } }, CLASICO);
  const o = order(rows);
  assert.deepEqual(o.slice(2), ["P", "Q"], "P (sets 2-0) va arriba de Q (sets 0-2)");
  assert.ok(o.slice(0, 2).includes("A") && o.slice(0, 2).includes("B"));
});

test("grupo de 4 con cruces: manda el cruce de ganadores y perdedores", () => {
  const g = group(["A", "B", "C", "D"], [
    { ...m("A", "B", [6, 1], [6, 1]), stage: "r1" },
    { ...m("C", "D", [6, 2], [6, 2]), stage: "r1" },
    { ...m("A", "C", [2, 6], [2, 6]), stage: "ganadores" },   // C gana el cruce de ganadores
    { ...m("B", "D", [6, 4], [6, 4]), stage: "perdedores" },  // B gana el de perdedores
  ], { format: "bracket4" });
  assert.deepEqual(order(computeStandings(g, {}, CLASICO)), ["C", "A", "B", "D"]);
});

test("grupo de 4 con cruces y W.O.: el que dio W.O. en el sorteo sigue y puede salir tercero", () => {
  const g = group(["A", "B", "C", "D"], [
    { ...m("A", "B", [6, 1], [6, 1]), stage: "r1" },
    { ...wo("C", "D", "C"), stage: "r1" },                    // C llegó tarde: W.O.
    { ...m("A", "D", [6, 2], [6, 2]), stage: "ganadores" },
    { ...m("B", "C", [0, 6], [0, 6]), stage: "perdedores" },  // C gana el cruce de perdedores
  ], { format: "bracket4" });
  assert.deepEqual(order(computeStandings(g, {}, CLASICO)), ["A", "D", "C", "B"]);
});

test("grupo de 4 con cruces y pareja eliminada: va al fondo aunque haya ganado el cruce", () => {
  const g = group(["A", "B", "C", "D"], [
    { ...m("A", "B", [6, 1], [6, 1]), stage: "r1" },
    { ...m("C", "D", [6, 2], [6, 2]), stage: "r1" },
    { ...m("A", "C", [2, 6], [2, 6]), stage: "ganadores" },   // C gana el cruce de ganadores
    { ...m("B", "D", [6, 4], [6, 4]), stage: "perdedores" },
  ], { format: "bracket4" });
  assert.deepEqual(order(computeStandings(g, { C: { eliminated: true } }, CLASICO)), ["A", "B", "D", "C"]);
});

test("grupo de 4 todos contra todos: triple empate definido por diferencia de games", () => {
  const rows = computeStandings(group(["A", "B", "C", "D"], [
    m("A", "B", [6, 4], [6, 4]),
    m("C", "D", [6, 4], [6, 4]),
    m("A", "C", [4, 6], [4, 6]),
    m("B", "D", [6, 1], [6, 1]),
    m("A", "D", [6, 0], [6, 0]),
    m("B", "C", [6, 0], [6, 0]),
  ]), {}, CLASICO);
  // A, B y C ganan 2 cada uno (sets 4-2 los tres). Games: A 32-20 (+12) | B 32-14 (+18) | C 24-28 (-4)
  assert.deepEqual(order(rows), ["B", "A", "C", "D"]);
});

test("empate de a dos sin enfrentamiento jugado todavía: diferencia general de sets", () => {
  const rows = computeStandings(group(["A", "B", "C"], [
    m("A", "C", [6, 0], [6, 0]),
    m("B", "C", [6, 4], [4, 6], [10, 8]),
  ]), {}, CLASICO);
  assert.deepEqual(order(rows), ["A", "B", "C"]);
});

/* RET: ret("A", "B", "B", [6, 3], [2, 1]) → B se retiró con 6-3 2-1 */
const ret = (pairA, pairB, retired, ...sets) => ({ ...m(pairA, pairB, ...sets), retired });

test("RET: respeta lo jugado y completa el resto a favor del rival", () => {
  // B ganó el primer set 3-6 y se retiró 1-2 abajo en el segundo: queda 3-6 6-1 10-0 para A
  const rows = computeStandings(group(["A", "B"], [ret("A", "B", "B", [3, 6], [2, 1])]), {}, CLASICO);
  const a = row(rows, "A"), b = row(rows, "B");
  assert.equal(a.pts, 2); assert.equal(b.pts, 0);
  assert.deepEqual([a.setsF, a.setsC], [2, 1]);
  assert.deepEqual([a.gamesF, a.gamesC], [3 + 6 + 1, 6 + 1], "el super tie-break vale un game");
});

test("RET: el set cortado lo gana el rival 7-5 si el que se retira tenía 5", () => {
  const rows = computeStandings(group(["A", "B"], [ret("A", "B", "A", [5, 4])]), {}, CLASICO);
  const b = row(rows, "B");
  assert.deepEqual([b.setsF, b.setsC, b.gamesF, b.gamesC], [2, 0, 7 + 6, 5]);
});

test("RET en set único: el rival llega a los games del set", () => {
  const rows = computeStandings(group(["A", "B"], [ret("A", "B", "B", [2, 3])]), {}, AMERICANO_7);
  const a = row(rows, "A");
  assert.deepEqual([a.setsF, a.setsC, a.gamesF, a.gamesC], [1, 0, 7, 3]);
});

test("RET: la pareja que se retira queda eliminada y va al fondo", () => {
  const rows = computeStandings(group(["M", "X", "Y"], [
    m("M", "X", [6, 0], [6, 0]),
    m("M", "Y", [6, 0], [6, 0]),
    ret("X", "Y", "X", [6, 2], [1, 1]),
  ]), {}, CLASICO);
  const x = row(rows, "X");
  assert.equal(x.ret, true); assert.equal(x.eliminated, true);
  assert.deepEqual(order(rows), ["M", "Y", "X"]);
});

test("grupo de 4 con cruces: si se juega antes el de perdedores, las del de ganadores siguen arriba", () => {
  const g = group(["A", "B", "C", "D"], [
    { ...m("A", "B", [6, 1], [6, 1]), stage: "r1" },
    { ...m("C", "D", [6, 2], [6, 2]), stage: "r1" },
    { ...m("A", "C"), stage: "ganadores" },                  // todavía sin jugar
    { ...m("B", "D", [6, 4], [6, 4]), stage: "perdedores" },  // B gana el de perdedores
  ], { format: "bracket4" });
  const o = order(computeStandings(g, {}, CLASICO));
  assert.deepEqual(o.slice(2), ["B", "D"], "3° y 4° ya definidos");
  assert.deepEqual([...o.slice(0, 2)].sort(), ["A", "C"], "A y C juegan por el 1° y el 2°");
});
