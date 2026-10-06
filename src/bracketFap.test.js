/* Tests del cuadro FAP de la llave (bracketFap.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FAP_TABLES, fapRound1, fapGeneratedSlots, seedLines } from "./bracketFap.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const label = (s) => (s ? `${s.place}${LETTERS[s.group]}` : null);

/* Problemas de un cuadro: dos del mismo grupo en primera ronda, 1° y 2° de un grupo en la misma
   mitad, un 3° con bye, y cada clasificado una sola vez */
function check(counts, slots) {
  const size = slots.length;
  const out = { sameGroupR1: 0, firstSecondSameHalf: 0, thirdWithBye: 0, firstAloneFails: 0 };
  const seen = slots.filter(Boolean).map(label);
  const expected = counts.flatMap((c, g) => Array.from({ length: c }, (_, p) => `${p + 1}${LETTERS[g]}`));
  assert.deepEqual([...seen].sort(), [...expected].sort(), `clasificados de ${counts}`);
  assert.ok(size >= seen.length && (size & (size - 1)) === 0, "tamaño potencia de 2");
  for (let i = 0; i < size; i += 2) {
    const [a, b] = [slots[i], slots[i + 1]];
    if (a && b && a.group === b.group) out.sameGroupR1++;
    if ((a && !b && a.place >= 3) || (b && !a && b.place >= 3)) out.thirdWithBye++;
    assert.ok(a || b, "no hay partidos de bye contra bye");
  }
  const half = (i) => Math.floor(i / (size / 2));
  counts.forEach((c, g) => {
    const pos = (p) => slots.findIndex((s) => s && s.group === g && s.place === p);
    if (c >= 2 && half(pos(1)) === half(pos(2))) out.firstSecondSameHalf++;
    if (c >= 3 && half(pos(1)) === half(pos(3))) out.firstAloneFails++;
  });
  return out;
}

test("seedLines: el orden de siembra de los cuadros FAP", () => {
  assert.deepEqual(seedLines(2), [1, 2]);
  assert.deepEqual(seedLines(4), [1, 4, 3, 2]);
  assert.deepEqual(seedLines(8), [1, 8, 5, 4, 3, 6, 7, 2]);
  assert.deepEqual(seedLines(16), [1, 16, 9, 8, 5, 12, 13, 4, 3, 14, 11, 6, 7, 10, 15, 2]);
});

test("los 20 cuadros vistos en Padel NET salen tal cual", () => {
  assert.equal(Object.keys(FAP_TABLES).length, 20);
  Object.entries(FAP_TABLES).forEach(([key, table]) => {
    const counts = key.split(",").map(Number);
    assert.deepEqual(fapRound1(counts).map(label), table, key);
  });
});

test("cuadros FAP vistos: nunca dos del mismo grupo en primera ronda ni un 3° con bye", () => {
  Object.keys(FAP_TABLES).forEach((key) => {
    const counts = key.split(",").map(Number);
    const r = check(counts, fapRound1(counts));
    assert.equal(r.sameGroupR1, 0, key);
    assert.equal(r.thirdWithBye, 0, key);
    // Con solo grupos de 3 (clasifican 2), el 1° y el 2° solo se pueden cruzar en la final
    if (counts.every((c) => c === 2)) assert.equal(r.firstSecondSameHalf, 0, key);
  });
});

test("cuadro armado: grupos de 3 (de 2 a 16 grupos) separan siempre al 1° del 2°", () => {
  for (let groups = 2; groups <= 16; groups++) {
    const counts = Array(groups).fill(2);
    const slots = fapGeneratedSlots(counts);
    const r = check(counts, slots);
    assert.equal(r.sameGroupR1, 0, `${groups} grupos`);
    assert.equal(r.firstSecondSameHalf, 0, `${groups} grupos`);
    // Los byes van a los 1° antes que a nadie
    const byes = [];
    for (let i = 0; i < slots.length; i += 2) if (!slots[i] || !slots[i + 1]) byes.push(slots[i] || slots[i + 1]);
    const firstsWithBye = byes.filter((s) => s.place === 1).length;
    assert.equal(firstsWithBye, Math.min(groups, byes.length), `${groups} grupos: byes a los 1°`);
  }
});

test("cuadro armado: mezclas con grupos de 4 (clasifican 3)", () => {
  for (let groups = 2; groups <= 16; groups++) {
    for (let fours = 1; fours <= Math.min(2, groups); fours++) {
      const counts = Array.from({ length: groups }, (_, i) => (i < fours ? 3 : 2));
      const r = check(counts, fapGeneratedSlots(counts));
      assert.equal(r.sameGroupR1, 0, `${counts}`);
      assert.equal(r.thirdWithBye, 0, `${counts}`);
      assert.equal(r.firstSecondSameHalf, 0, `${counts}`);
    }
  }
});

test("un solo grupo: el 1° contra el 2° (o con bye si clasifican 3)", () => {
  assert.deepEqual(fapRound1([2]).map(label), ["1A", "2A"]);
  assert.deepEqual(fapRound1([3]).map(label), ["1A", null, "2A", "3A"]);
  assert.equal(fapRound1([1]), null);
});

test("un grupo que no clasifica a nadie no ocupa letra en el cuadro", () => {
  // A, B, C y D clasifican 2 y E ninguno: es el cuadro de 4 grupos, con sus letras de siempre
  assert.deepEqual(fapRound1([2, 2, 2, 2, 0]).map(label), FAP_TABLES["2,2,2,2"]);
  // B no clasifica: el cuadro de 3 grupos, pero con las letras reales (A, C, D)
  const r = fapRound1([2, 0, 2, 2]).map(label);
  assert.ok(r.every((s) => !s || !s.endsWith("B")));
});
