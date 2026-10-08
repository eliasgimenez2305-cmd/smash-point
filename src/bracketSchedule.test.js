/* Tests de los horarios de la llave (bracketSchedule.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleKnockout, scheduleKnockouts } from "./bracketSchedule.js";
import { fapRound1 } from "./bracketFap.js";

const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const abs = (s) => Date.parse(`${s.date}T00:00:00Z`) / 60000 + toMin(s.time);

// Fecha 8 de Gualeguaychú: MONO 2 canchas, PATIO 2, Tenis del Sol 2, Drop 1
const VENUES = [2, 2, 2, 1];
const venueOf = (court) => { let off = 0; for (let v = 0; v < VENUES.length; v++) { if (court <= off + VENUES[v]) return v; off += VENUES[v]; } return 0; };
const SAT = "2026-10-03", SUN = "2026-10-04";
const DAYS = [{ date: SAT, from: "10:00", to: "22:00", bracket: false }, { date: SUN, from: "09:00", to: "21:00", bracket: true }];

/* Llave vacía (sin horarios) para una configuración de clasificados por grupo */
function emptyRounds(counts) {
  const slots = fapRound1(counts);
  const r0 = [];
  for (let i = 0; i < slots.length; i += 2) r0.push({ schedule: null, bye: !slots[i] || !slots[i + 1] });
  const rounds = [r0];
  for (let n = r0.length / 2; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, () => ({ schedule: null, bye: false })));
  return rounds;
}

/* Arma las llaves de todas las categorías juntas, como "Rearmar horarios" */
function scheduleAll(categories, extra = {}) {
  const outs = scheduleKnockouts({
    categories: categories.map((c) => ({ rounds: c.rounds, finalPref: c.finalPref || null, categoryStart: null, ownStart: c.ownStart || null, entrants: c.entrants || (() => []) })),
    days: DAYS, duration: 60, courts: 7, venueOf, busy: new Set(extra.busy || []), rest: 120,
    closingFrom: toMin("18:00"), otherFinals: [],
  });
  return categories.map((c, i) => ({ ...c, out: outs[i] }));
}

const F8 = [
  { name: "6ta", rounds: emptyRounds(Array(9).fill(2)) },
  { name: "5ta", rounds: emptyRounds(Array(7).fill(2)) },
  { name: "7ma", rounds: emptyRounds(Array(6).fill(2)) },
  { name: "4ta", rounds: emptyRounds(Array(4).fill(2)) },
  { name: "Damas 6ta", rounds: emptyRounds([3, 3, 2]) },
  { name: "Damas 7ma", rounds: emptyRounds([3, 3, 2]) },
  { name: "Suma 6", rounds: emptyRounds([3, 2]) },
];

test("domingo tipo Fecha 8: todo con horario, sin choques, con descanso y finales al cierre", () => {
  const res = scheduleAll(F8);
  const used = new Set();
  res.forEach(({ name, rounds, out }) => {
    rounds.forEach((round, ri) => round.forEach((m, mi) => {
      const s = out[ri][mi];
      if (m.bye) { assert.equal(s, null, `${name}: bye sin horario`); return; }
      assert.ok(s, `${name} ronda ${ri + 1} partido ${mi + 1} con horario`);
      // Ninguna cancha con dos partidos a la vez
      const key = `${s.date}|${s.time}|${s.court}`;
      assert.ok(!used.has(key), `${name}: cancha libre ${key}`);
      used.add(key);
      // Del 16avos de la 6ta en adelante, todo el domingo (no hay "La llave arranca")
      assert.equal(s.date, SUN, `${name}: llave el domingo`);
      // Descanso: el partido siguiente del camino, al menos 2 h después
      const next = out[ri + 1]?.[Math.floor(mi / 2)];
      if (next) assert.ok(abs(next) - abs(s) >= 120, `${name}: 2 h entre ronda ${ri + 1} y ${ri + 2}`);
    }));
    // Semis y final en la misma sede; final en la franja de cierre (18 a 20)
    const final = out[out.length - 1][0];
    assert.ok(toMin(final.time) >= toMin("18:00"), `${name}: final al cierre (${final.time})`);
    out[out.length - 2].filter(Boolean).forEach((s) => assert.equal(venueOf(s.court), venueOf(final.court), `${name}: semi en la sede de la final`));
  });
});

test("las finales se reparten en la franja de cierre", () => {
  const res = scheduleAll(F8);
  const times = res.map(({ out }) => out[out.length - 1][0].time);
  const perHour = {};
  times.forEach((t) => { perHour[t] = (perHour[t] || 0) + 1; });
  assert.ok(Object.keys(perHour).length >= 3, `finales en varias horas: ${times.join(", ")}`);
  assert.ok(Math.max(...Object.values(perHour)) <= 3, `no más de 3 finales a la vez: ${times.join(", ")}`);
});

test("hora y sede de la final elegidas por el organizador", () => {
  const [res] = scheduleAll([{ name: "7ma", rounds: emptyRounds(Array(6).fill(2)), finalPref: { time: "19:00", venue: 1 } }]);
  const final = res.out[res.out.length - 1][0];
  assert.equal(final.time, "19:00");
  assert.equal(venueOf(final.court), 1);
  res.out[res.out.length - 2].forEach((s) => { assert.equal(venueOf(s.court), 1); assert.ok(toMin(s.time) <= toMin("17:00")); });
});

test("las categorías chicas arrancan más tarde que las grandes", () => {
  const res = scheduleAll(F8);
  const start = (name) => Math.min(...res.find((r) => r.name === name).out.flat().filter(Boolean).map((s) => toMin(s.time)));
  assert.ok(start("Suma 6") > start("6ta"), "Suma 6 arranca después que la 6ta");
  assert.ok(start("4ta") > start("5ta"), "4ta arranca después que la 5ta");
});

test("La llave arranca el sábado: primera ronda ese día, 2 h después de los grupos de quienes llegan", () => {
  // 6ta con 9 grupos: dos partidos de 16avos. Los grupos de quienes llegan terminan a las 19 y 20.
  const rounds = emptyRounds(Array(9).fill(2));
  const groupEnd = { 1: "19:00", 14: "20:00" }; // partidos de 16avos que se juegan (los demás son byes)
  const [res] = scheduleAll([{
    name: "6ta", rounds, ownStart: { date: SAT, minutes: toMin("19:00") },
    entrants: (i) => (groupEnd[i] ? [{ date: SAT, time: groupEnd[i], court: 1 }] : []),
  }]);
  // El de las 19: a las 21 del sábado. El de las 20 necesitaría las 22, pero el sábado termina a
  // las 22: pasa al domingo, antes de los octavos
  assert.deepEqual([res.out[0][1].date, res.out[0][1].time], [SAT, "21:00"]);
  assert.equal(res.out[0][14].date, SUN);
  assert.ok(abs(res.out[1][7]) - abs(res.out[0][14]) >= 120, "2 h antes de su octavo");
  res.out[1].forEach((s) => assert.equal(s.date, SUN, "octavos el domingo"));
});

test("lo que ya tiene horario (a mano) no se toca y lo nuevo se arma alrededor", () => {
  const rounds = emptyRounds(Array(4).fill(2));
  rounds[2][0].schedule = { date: SUN, time: "16:00", court: 3 }; // final puesta a mano
  const [res] = scheduleAll([{ name: "4ta", rounds }]);
  assert.deepEqual(res.out[2][0], { date: SUN, time: "16:00", court: 3 });
  res.out[1].forEach((s) => assert.ok(toMin(s.time) <= toMin("14:00"), "semis 2 h antes de la final"));
});

test("si no entra todo, primero se ubican la final y las semis", () => {
  // Domingo cortito (de 17 a 21): solo entran final y semis de la 6ta
  const days = [{ date: SUN, from: "17:00", to: "21:00", bracket: true }];
  const rounds = emptyRounds(Array(9).fill(2));
  const out = scheduleKnockout({ rounds, days, duration: 60, courts: 7, venueOf, busy: new Set(), rest: 120, closingFrom: toMin("18:00"), finalPref: null, otherFinals: [], categoryStart: null, ownStart: null, entrants: () => [] });
  assert.ok(out[out.length - 1][0], "final con horario");
  assert.ok(out[out.length - 2].every(Boolean), "semis con horario");
  assert.ok(out[0].some((s, i) => !rounds[0][i].bye && !s), "la primera ronda queda sin horario");
});
