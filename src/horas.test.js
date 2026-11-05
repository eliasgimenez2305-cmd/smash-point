/* Tests de los días que terminan pasada la medianoche (horas.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayEndMin, validDayRange, clockTime, endsAfterMidnight, isAfterMidnight } from "./horas.js";

test("18:00 a 01:00 termina a la 1 del día siguiente", () => {
  assert.equal(endsAfterMidnight("18:00", "01:00"), true);
  assert.equal(dayEndMin({ from: "18:00", to: "01:00" }), 25 * 60);
  assert.equal(dayEndMin({ from: "18:00", to: "00:00" }), 24 * 60, "hasta la medianoche justa");
  assert.equal(dayEndMin({ from: "09:00", to: "23:59" }), 23 * 60 + 59, "un día común no cambia");
});

test("un cierre de mediodía o de la tarde no se lee como madrugada", () => {
  assert.equal(validDayRange("18:00", "12:00"), false, "18 a 12 es un error de carga, no 18 horas");
  assert.equal(validDayRange("18:00", "06:00"), true);
  assert.equal(validDayRange("18:00", "06:30"), false);
  assert.equal(validDayRange("10:00", "10:00"), false);
  assert.equal(validDayRange("10:00", "22:00"), true);
});

test("las horas corridas se muestran como hora del reloj", () => {
  assert.equal(clockTime("24:00"), "00:00");
  assert.equal(clockTime("25:30"), "01:30");
  assert.equal(clockTime("23:00"), "23:00");
  assert.equal(isAfterMidnight("24:00"), true);
  assert.equal(isAfterMidnight("23:59"), false);
});

test("turnos de un día 18:00 a 01:00 con partidos de 60 minutos: hasta el de las 00", () => {
  const day = { from: "18:00", to: "01:00" };
  const turnos = [];
  for (let t = 18 * 60; t + 60 <= dayEndMin(day); t += 60) turnos.push(clockTime(`${String(Math.floor(t / 60)).padStart(2, "0")}:00`));
  assert.deepEqual(turnos, ["18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "00:00"]);
});
