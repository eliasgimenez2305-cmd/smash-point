import test from "node:test";
import assert from "node:assert/strict";
import { aMinutos, etiquetaHora, horarioCancha, duracionesOfrecidas, iniciosPosibles, instante, minutoEnGrilla, motivoNoEntra, filasAgenda, fechasSemanales, sumarDias, hoyArgentina, leerPrecio, etiquetaFecha, iniciosLibres, horariosConLibres, franjaDe, precioDesde, rangoPeriodo, fechaArgentina, sumarMeses, etiquetaMes, agruparSeries } from "./reservas.js";

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

test("horarios libres en un complejo: alcanza con una cancha libre", () => {
  const c2 = { id: "c3", apertura: "14:00", cierre: "22:00", precio_90: 12000 };
  const ocupado = [
    { cancha_id: "c1", estado: "confirmada", inicio: instante("2026-10-14", 18 * 60), fin: instante("2026-10-14", 19 * 60 + 30) },
    { cancha_id: "c3", estado: "confirmada", inicio: instante("2026-10-14", 18 * 60), fin: instante("2026-10-14", 19 * 60 + 30) },
  ];
  const ahora = Date.parse("2026-10-14T12:00:00-03:00");
  const libres = iniciosLibres([cancha1, c2], "2026-10-14", 90, ocupado, { desdeMin: 17 * 60, ahora });
  const horas = libres.map((l) => etiquetaHora(l.desde));
  assert.deepEqual(horas.slice(0, 3), ["19:30", "20:00", "20:30"]); // 17:00 a 19:00 se pisan en las dos
  assert.equal(libres[0].cancha.id, "c1");
  // Lo que ya pasó no aparece
  const tarde = Date.parse("2026-10-14T20:10:00-03:00");
  assert.deepEqual(iniciosLibres([cancha1], "2026-10-14", 90, [], { ahora: tarde }).map((l) => etiquetaHora(l.desde)), ["20:30"]);
  assert.equal(precioDesde([cancha1, c2], 90), 12000);
  assert.equal(precioDesde([cancha1], 120), null);
});

test("períodos de la caja", () => {
  assert.deepEqual(rangoPeriodo("hoy", "2026-10-14"), { desde: "2026-10-14", hasta: "2026-10-14" });
  assert.deepEqual(rangoPeriodo("semana", "2026-10-14"), { desde: "2026-10-12", hasta: "2026-10-18" }); // miércoles
  assert.deepEqual(rangoPeriodo("semana", "2026-10-18"), { desde: "2026-10-12", hasta: "2026-10-18" }); // domingo
  assert.deepEqual(rangoPeriodo("mes", "2026-10-14"), { desde: "2026-10-01", hasta: "2026-10-31" });
  assert.deepEqual(rangoPeriodo("mes", "2026-02-10"), { desde: "2026-02-01", hasta: "2026-02-28" });
  assert.equal(fechaArgentina("2026-10-15T02:00:00Z"), "2026-10-14");
});

test("meses de la caja de la plataforma", () => {
  assert.equal(sumarMeses("2026-12", 1), "2027-01");
  assert.equal(sumarMeses("2026-01", -1), "2025-12");
  assert.equal(sumarMeses("2026-10", 0), "2026-10");
  assert.equal(etiquetaMes("2026-10"), "Octubre 2026");
});

test("precios escritos a mano", () => {
  assert.equal(leerPrecio("12.000"), 12000);
  assert.equal(leerPrecio(""), null);
  assert.equal(leerPrecio("$ 9500"), 9500);
});

test("turnos fijos: agrupa por serie con la próxima y la última fecha", () => {
  const rs = [
    { id: "a", serie_id: "s1", fecha: "2026-10-27", inicio: "2026-10-27T21:00:00-03:00" },
    { id: "b", serie_id: "s1", fecha: "2026-10-20", inicio: "2026-10-20T21:00:00-03:00" },
    { id: "c", serie_id: "s2", fecha: "2026-10-15", inicio: "2026-10-15T19:00:00-03:00" },
    { id: "d", fecha: "2026-10-15" },
  ];
  const g = agruparSeries(rs);
  assert.equal(g.length, 2);
  assert.equal(g[0].serieId, "s2");
  assert.equal(g[1].proxima.id, "b");
  assert.equal(g[1].ultima.id, "a");
  assert.equal(g[1].cantidad, 2);
  assert.deepEqual(g[1].fechas, ["2026-10-20", "2026-10-27"]);
});

test("cada horario con todas sus canchas libres", () => {
  const a = { id: "a", apertura: "18:00", cierre: "21:00", precio_90: 15000 };
  const b = { id: "b", apertura: "18:00", cierre: "21:00", precio_90: 18000 };
  const ocupado = [{ cancha_id: "a", estado: "confirmada", inicio: instante("2026-10-16", 18 * 60), fin: instante("2026-10-16", 19 * 60 + 30) }];
  const ahora = Date.parse("2026-10-16T12:00:00-03:00");
  const h = horariosConLibres([a, b], "2026-10-16", 90, ocupado, { ahora });
  assert.deepEqual(h.map((x) => [etiquetaHora(x.desde), x.canchas.map((c) => c.id).join("")]), [
    ["18:00", "b"], ["18:30", "b"], ["19:00", "b"], ["19:30", "ab"],
  ]);
  assert.deepEqual(horariosConLibres([a], "2026-10-16", 120, [], { ahora }), []);
});

test("franjas del día", () => {
  assert.equal(franjaDe(9 * 60), "manana");
  assert.equal(franjaDe(12 * 60 + 30), "manana");
  assert.equal(franjaDe(14 * 60 + 30), "tarde");
  assert.equal(franjaDe(17 * 60 + 30), "tarde");
  assert.equal(franjaDe(18 * 60 + 30), "noche");
  assert.equal(franjaDe(24 * 60 + 30), "noche");
});

test("canchaDelDia: horario del complejo por día, horario propio y horario online", async () => {
  const { canchaDelDia, horarioCancha } = await import("./reservas.js");
  const cancha = { id: "c1", apertura: "08:00:00", cierre: "23:00:00" };
  const complejo = { horario: { 1: [420, 1440], 6: [480, 1560], 0: null }, horario_online: { 1: [840, 1380], 6: [0, 1440] } };
  // Sin horario del complejo: el de la cancha
  assert.deepEqual(horarioCancha(canchaDelDia(cancha, {}, "2026-10-26")), { desde: 480, hasta: 1380 });
  // Lunes 26/10: 07 a 24; online 14 a 23
  assert.deepEqual(horarioCancha(canchaDelDia(cancha, complejo, "2026-10-26")), { desde: 420, hasta: 1440 });
  assert.deepEqual(horarioCancha(canchaDelDia(cancha, complejo, "2026-10-26", true)), { desde: 840, hasta: 1380 });
  // Sábado 31/10: 08 a 02 del domingo; online hasta las 24
  assert.deepEqual(horarioCancha(canchaDelDia(cancha, complejo, "2026-10-31")), { desde: 480, hasta: 1560 });
  assert.deepEqual(horarioCancha(canchaDelDia(cancha, complejo, "2026-10-31", true)), { desde: 480, hasta: 1440 });
  // Domingo cerrado; martes sin cargar = cerrado
  assert.equal(canchaDelDia(cancha, complejo, "2026-11-01"), null);
  assert.equal(canchaDelDia(cancha, complejo, "2026-10-27"), null);
  // Cancha con horario propio: la suya, recortada igual con el online
  assert.deepEqual(horarioCancha(canchaDelDia({ ...cancha, horario_propio: true }, complejo, "2026-10-26", true)), { desde: 840, hasta: 1380 });
});
