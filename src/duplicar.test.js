import test from "node:test";
import assert from "node:assert/strict";
import { duplicarTorneo, nombreSiguiente } from "./duplicar.js";

let n = 0;
const nuevoId = () => `id${++n}`;
const original = {
  id: "t1", name: "Circuito Fecha 3", date: "2026-10-23", status: "Finalizado", organizerId: "o1", rev: 40, eventId: "e1",
  inscripcionesAbiertas: true, circuitId: "circ", precioJugador: 15000, courtsCount: 4, coverImageUrl: "foto.jpg",
  matchFormat: { sets: 3 },
  playDates: [{ date: "2026-10-23", from: "18:00", to: "23:00" }, { date: "2026-10-24", from: "09:00", to: "23:00" }],
  venues: [{ id: "v1", name: "Black", courts: 2, days: [{ date: "2026-10-24", from: "09:00", to: "20:00" }] }],
  categories: [
    { id: "c1", name: "6ta", cupo: 16, precioJugador: 12000, pairs: [{ id: "p1" }], groups: [{ id: "g1" }], bracket: [[{}]], bracketPublished: true, bracketIsSkeleton: true, bracketSeeding: {}, start: { date: "2026-10-24", time: "10:00" }, bracketStart: { date: "2026-10-25", time: "09:00" }, bracketFinal: { time: "18:00", venueId: "v1" } },
    { id: "c2", name: "Súper 8", format: "super8_individual", teams: [{ id: "x" }], pairs: [{ id: "p2" }] },
  ],
};

test("duplicar: copia la configuración y arranca de cero lo de cada fecha", () => {
  const d = duplicarTorneo(original, { name: "Circuito Fecha 4", date: "2026-11-06", estado: "Próximo", nuevoId });
  assert.notEqual(d.id, "t1");
  assert.equal(d.name, "Circuito Fecha 4");
  assert.equal(d.status, "Próximo");
  assert.equal(d.inscripcionesAbiertas, false);
  assert.equal(d.rev, undefined);
  assert.equal(d.eventId, undefined);
  assert.equal(d.circuitId, "circ");
  assert.equal(d.precioJugador, 15000);
  assert.equal(d.coverImageUrl, "foto.jpg");
  assert.deepEqual(d.matchFormat, { sets: 3 });
  // Categorías: misma configuración, sin parejas, grupos ni llave, con ids nuevos
  const [c1, c2] = d.categories;
  assert.notEqual(c1.id, "c1");
  assert.equal(c1.cupo, 16);
  assert.equal(c1.precioJugador, 12000);
  assert.deepEqual(c1.pairs, []);
  assert.deepEqual(c1.groups, []);
  assert.equal(c1.bracket, null);
  assert.equal(c1.bracketPublished, undefined);
  assert.deepEqual(c1.bracketFinal, { time: "18:00", venueId: "v1" });
  assert.equal(c2.format, "super8_individual");
  assert.deepEqual(c2.teams, []);
  // El original no cambia
  assert.equal(original.categories[0].pairs.length, 1);
});

test("duplicar: las fechas se corren lo mismo que la fecha del torneo (14 días)", () => {
  const d = duplicarTorneo(original, { name: "X", date: "2026-11-06", estado: "Próximo", nuevoId });
  assert.deepEqual(d.playDates.map((p) => p.date), ["2026-11-06", "2026-11-07"]);
  assert.equal(d.playDates[1].from, "09:00");
  assert.equal(d.venues[0].days[0].date, "2026-11-07");
  assert.equal(d.categories[0].start.date, "2026-11-07");
  assert.equal(d.categories[0].bracketStart.date, "2026-11-08");
  assert.equal(d.categories[0].start.time, "10:00");
});

test("nombre de la fecha siguiente", () => {
  assert.equal(nombreSiguiente("Circuito Fecha 3"), "Circuito Fecha 4");
  assert.equal(nombreSiguiente("Torneo 9"), "Torneo 10");
  assert.equal(nombreSiguiente("Torneo de Primavera"), "Torneo de Primavera (copia)");
});

test("no copia los datos calculados del resumen (claves con _)", () => {
  const t = { id: "a", name: "Fecha 1", date: "2026-10-10", _light: true, _stats: { progress: 1 }, categories: [{ id: "c", name: "4ta", _pairsCount: 12, _placements: [1], pairs: [] }] };
  let n = 0;
  const copia = duplicarTorneo(t, { name: "Fecha 2", date: "2026-10-17", estado: "Próximo", nuevoId: () => `n${n++}` });
  assert.equal(copia._stats, undefined);
  assert.equal(copia.categories[0]._pairsCount, undefined);
  assert.equal(copia.categories[0]._placements, undefined);
});

test("la copia nace no pública y sin los links de transmisión", () => {
  let n = 0;
  const copia = duplicarTorneo({ id: "a", name: "Fecha 1", date: "2026-10-10", publico: true, streams: { "2026-10-10": { 1: "https://x" } }, categories: [] }, { name: "Fecha 2", date: "2026-10-17", estado: "Próximo", nuevoId: () => `n${n++}` });
  assert.equal(copia.publico, false);
  assert.equal(copia.streams, undefined);
});
