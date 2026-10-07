/* Tests de los días y horarios de cada sede (venueDays.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { courtVenueIndex, courtIsOpen, closedCourtSlots, courtsOfDay, matchesAtClosedCourts } from "./venueDays.js";
import { scheduleKnockout } from "./bracketSchedule.js";

const JUE = "2026-10-08", VIE = "2026-10-09", SAB = "2026-10-10";
const playDates = [{ date: JUE, from: "16:00", to: "21:00" }, { date: VIE, from: "16:00", to: "21:00" }, { date: SAB, from: "10:00", to: "21:00" }];
// BLACK 2 canchas (todos los días), MONO 2 (solo el sábado de 10 a 14), MUNDO 1 (jueves y viernes desde las 18)
const tournament = {
  matchDurationMinutes: 60, courtsCount: 5, playDates,
  venues: [
    { id: "b", name: "BLACK", courts: 2 },
    { id: "m", name: "MONO", courts: 2, days: [{ date: SAB, from: "10:00", to: "14:00" }] },
    { id: "u", name: "MUNDO", courts: 1, days: [{ date: JUE, from: "18:00", to: "21:00" }, { date: VIE, from: "18:00", to: "21:00" }] },
  ],
};
const min = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

test("canchas numeradas de corrido por sede", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((c) => courtVenueIndex(tournament, c)), [0, 0, 1, 1, 2]);
});

test("una sede sin días se usa siempre; con días, solo esos días y si el partido entero entra en su horario", () => {
  assert.equal(courtIsOpen(tournament, 1, JUE, min("16:00")), true);
  assert.equal(courtIsOpen(tournament, 3, JUE, min("16:00")), false); // MONO no juega el jueves
  assert.equal(courtIsOpen(tournament, 3, SAB, min("13:00")), true);
  assert.equal(courtIsOpen(tournament, 3, SAB, min("14:00")), false); // cierra a las 14
  assert.equal(courtIsOpen(tournament, 5, VIE, min("17:00")), false); // MUNDO abre a las 18
  assert.equal(courtIsOpen(tournament, 5, VIE, min("18:00")), true);
  assert.equal(courtIsOpen(tournament, 5, SAB, min("12:00")), false);
});

test("turnos cerrados de la grilla", () => {
  const closed = closedCourtSlots(tournament);
  assert.ok(closed.has(`${JUE}|16:00|3`) && closed.has(`${JUE}|16:00|4`) && closed.has(`${JUE}|17:00|5`));
  assert.ok(!closed.has(`${JUE}|18:00|5`) && !closed.has(`${SAB}|10:00|3`));
  assert.ok(![...closed].some((k) => k.endsWith("|1") || k.endsWith("|2"))); // BLACK nunca cierra
  // Jueves y viernes: MONO cerrado los 5 turnos (2 canchas) y MUNDO 2 turnos; sábado: MONO 7 turnos y MUNDO 11
  assert.equal(closed.size, 2 * (5 * 2 + 2) + (7 * 2 + 11));
});

test("sin días cargados en ninguna sede no hay nada cerrado", () => {
  assert.equal(closedCourtSlots({ ...tournament, venues: tournament.venues.map(({ days, ...v }) => v) }).size, 0);
  assert.equal(closedCourtSlots({ courtsCount: 4, playDates }).size, 0);
});

test("canchas de cada día en la grilla, más las que igual tienen un partido", () => {
  assert.deepEqual(courtsOfDay(tournament, JUE), [1, 2, 5]);
  assert.deepEqual(courtsOfDay(tournament, SAB), [1, 2, 3, 4]);
  assert.deepEqual(courtsOfDay(tournament, SAB, [{ schedule: { date: SAB, time: "19:00", court: 5 } }]), [1, 2, 3, 4, 5]);
});

test("partidos que quedaron en una sede cerrada", () => {
  const ok = { schedule: { date: SAB, time: "11:00", court: 3 } };
  const late = { schedule: { date: SAB, time: "15:00", court: 4 } };
  const wrongDay = { schedule: { date: VIE, time: "19:00", court: 3 } };
  assert.deepEqual(matchesAtClosedCourts(tournament, [ok, late, wrongDay, { schedule: null }]), [late, wrongDay]);
});

test("la llave no usa canchas de una sede cerrada", () => {
  // Llave de 8 el sábado: con solo MONO y BLACK, MONO cierra a las 14
  const rounds = [Array.from({ length: 4 }, () => ({ schedule: null, bye: false })), [{ schedule: null, bye: false }, { schedule: null, bye: false }], [{ schedule: null, bye: false }]];
  const out = scheduleKnockout({
    rounds, finalPref: null, categoryStart: null, ownStart: null, entrants: () => [],
    days: playDates.map((d) => ({ ...d, bracket: d.date === SAB })), duration: 60, courts: 5,
    venueOf: (c) => courtVenueIndex(tournament, c), busy: closedCourtSlots(tournament), rest: 120, closingFrom: min("18:00"), otherFinals: [],
  });
  const all = out.flat();
  assert.equal(all.filter(Boolean).length, 7);
  all.forEach((s) => assert.ok(courtIsOpen(tournament, s.court, s.date, min(s.time)), `${s.date} ${s.time} cancha ${s.court}`));
});
