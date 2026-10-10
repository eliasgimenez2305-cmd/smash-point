import test from "node:test";
import assert from "node:assert/strict";
import { aMinutos, etiquetaHora, horarioCancha, duracionesOfrecidas, iniciosPosibles, instante, minutoEnGrilla, motivoNoEntra, filasAgenda, fechasSemanales, sumarDias, hoyArgentina, leerPrecio, etiquetaFecha } from "./reservas.js";

const cancha1 = { id: "c1", apertura: "14:00:00", cierre: "22:00:00", precio_60: 10000, precio_90: 14000, precio_120: null };
const nocturna = { id: "c2", apertura: "18:00", cierre: "01:00", precio_90: 15000 };

test("horas y minutos", () => {
  assert.equal(aMinutos("14:30:00"), 870);
  assert.equal(etiquetaHora(870), "14:30");
  assert.equal(etiquetaHora(1500), "01:00");
});

test("horario de una cancha, también pasada la medianoche", () => {
  assert.deepEqual(horarioCancha(cancha1), { desde: 840, hasta: 1320 });
  assert.deepEqual(horarioCancha(nocturna), { desde: 1080, hasta: 1500 });
});

test("duraciones ofrecidas según los precios cargados", () => {
  assert.deepEqual(duracionesOfrecidas(cancha1), [60, 90]);
  assert.deepEqual(duracionesOfrecidas(nocturna), [90]);
});

test("inicios posibles: el turno tiene que entrar entero antes del cierre", () => {
  const i90 = iniciosPosibles(cancha1, 90);
  assert.equal(etiquetaHora(i90[0]), "14:00");
  assert.equal(etiquetaHora(i90.at(-1)), "20:30");
  const noche = iniciosPosibles(nocturna, 90);
  assert.equal(etiquetaHora(noche.at(-1)), "23:30"); // 23:30 a 01:00
});

test("instantes: pasada la medianoche cae en el día siguiente, en hora de Argentina", () => {
  assert.equal(instante("2026-10-14", 870), "2026-10-14T14:30:00-03:00");
  assert.equal(instante("2026-10-14", 1470), "2026-10-15T00:30:00-03:00");
  assert.equal(instante("2026-12-31", 1470), "2027-01-01T00:30:00-03:00");
  // Lo que devuelve Supabase viene en UTC
  assert.equal(minutoEnGrilla("2026-10-14", "2026-10-15T03:30:00+00:00"), 1470);
  assert.equal(minutoEnGrilla("2026-10-14", "2026-10-14T17:30:00+00:00"), 870);
});

test("un turno no entra si se pisa con otro o con un bloqueo, ni fuera de horario", () => {
  const reservas = [
    { cancha_id: "c1", estado: "confirmada", inicio: instante("2026-10-14", 960), fin: instante("2026-10-14", 1050) }, // 16:00 a 17:30
    { cancha_id: "c1", estado: "cancelada", inicio: instante("2026-10-14", 1080), fin: instante("2026-10-14", 1170) }, // cancelada: no ocupa
  ];
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 900, 60, reservas), null); // 15:00 a 16:00 (justo antes)
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 930, 60, reservas), "superpuesto"); // 15:30 a 16:30
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 1050, 90, reservas), null); // 17:30 (justo después)
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 1080, 90, reservas), null); // donde estaba la cancelada
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 1260, 90, reservas), "fuera_de_horario"); // 21:00 a 22:30
  assert.equal(motivoNoEntra(cancha1, "2026-10-14", 810, 60, reservas), "fuera_de_horario"); // 13:30
});

test("filas de la agenda: de la primera apertura al último cierre", () => {
  const filas = filasAgenda([cancha1, nocturna]);
  assert.equal(etiquetaHora(filas[0]), "14:00");
  assert.equal(etiquetaHora(filas.at(-1)), "00:30");
  assert.deepEqual(filasAgenda([]), []);
});

test("fechas", () => {
  assert.deepEqual(fechasSemanales("2026-10-14", 3), ["2026-10-14", "2026-10-21", "2026-10-28"]);
  assert.equal(sumarDias("2026-10-31", 1), "2026-11-01");
  assert.equal(hoyArgentina(new Date("2026-10-15T02:00:00Z")), "2026-10-14"); // 23 hs del 14 en Argentina
  assert.equal(etiquetaFecha("2026-10-14"), "Miércoles 14/10");
});

test("precios escritos a mano", () => {
  assert.equal(leerPrecio("12.000"), 12000);
  assert.equal(leerPrecio(""), null);
  assert.equal(leerPrecio("$ 9500"), 9500);
});
