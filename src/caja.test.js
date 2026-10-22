import { test } from "node:test";
import assert from "node:assert/strict";
import { aCentavos, centavosATexto, resumenLibro, barrasPorCategoria, efectoEnCuenta, signoMovimiento, filtrarMovimientos } from "./caja.js";

test("aCentavos: pesos escritos a mano a centavos", () => {
  assert.equal(aCentavos("12.500"), 1250000);
  assert.equal(aCentavos("$ 12500"), 1250000);
  assert.equal(aCentavos("12500,5"), 1250050);
  assert.equal(aCentavos("12500,55"), 1250055);
  assert.equal(aCentavos("0"), null);
  assert.equal(aCentavos(""), null);
  assert.equal(aCentavos("abc"), null);
  assert.equal(aCentavos("1,2,3"), null);
});

test("centavosATexto: vuelve al campo sin perder decimales", () => {
  assert.equal(centavosATexto(1250000), "12500");
  assert.equal(centavosATexto(1250050), "12500,5");
  assert.equal(centavosATexto(1250055), "12500,55");
});

const movs = [
  { id: "1", tipo: "ingreso", sentido: 1, monto: 100000, categoria_id: "turnos", cuenta_id: "ef" },
  { id: "2", tipo: "ingreso", sentido: 1, monto: 50000, categoria_id: "mostrador", cuenta_id: "mp" },
  { id: "3", tipo: "gasto", sentido: -1, monto: 30000, categoria_id: "luz", cuenta_id: "ef" },
  { id: "4", tipo: "retiro_socio", sentido: -1, monto: 20000, cuenta_id: "ef", cargado_por: "otro" },
  { id: "5", tipo: "transferencia_interna", sentido: -1, monto: 10000, cuenta_id: "ef", cuenta_destino_id: "cf" },
  { id: "6", tipo: "ajuste", sentido: -1, monto: 500, cuenta_id: "ef" },
  { id: "7", tipo: "ingreso", sentido: 1, monto: 999999, categoria_id: "turnos", cuenta_id: "ef", anulado_at: "2026-10-22" },
];

test("resumenLibro: ingresos y gastos dan el resultado; retiros, pases y ajustes no cuentan; anulados afuera", () => {
  const r = resumenLibro(movs);
  assert.equal(r.ingresos, 150000);
  assert.equal(r.gastos, 30000);
  assert.equal(r.resultado, 120000);
  assert.equal(r.retiros, 20000);
  assert.equal(r.ajustes, -500);
  assert.deepEqual(r.porCategoria.ingreso, { turnos: 100000, mostrador: 50000 });
});

test("barrasPorCategoria: de mayor a menor con su porcentaje", () => {
  const b = barrasPorCategoria({ turnos: 100000, mostrador: 50000 }, [{ id: "turnos", nombre: "Turnos" }, { id: "mostrador", nombre: "Mostrador" }]);
  assert.deepEqual(b.map((x) => [x.nombre, x.pct]), [["Turnos", 100], ["Mostrador", 50]]);
});

test("efectoEnCuenta: el pase baja una cuenta y sube la otra", () => {
  const saldo = (c) => movs.reduce((s, m) => s + efectoEnCuenta(m, c), 0);
  assert.equal(saldo("ef"), 100000 - 30000 - 20000 - 10000 - 500);
  assert.equal(saldo("cf"), 10000);
  assert.equal(signoMovimiento(movs[4]), 0);
});

test("filtrarMovimientos: por cuenta (también destino), quién cargó, texto y anulados", () => {
  const ids = (f) => filtrarMovimientos(movs.map((m) => ({ concepto: `Mov ${m.id}`, cargado_por: "yo", ...m })), f, "yo").map((m) => m.id);
  assert.deepEqual(ids({ cuenta: "cf" }), ["5"]);
  assert.deepEqual(ids({ quien: "otros" }), ["4"]);
  assert.deepEqual(ids({ buscar: "mov 3" }), ["3"]);
  assert.equal(ids({}).includes("7"), false);
  assert.equal(ids({ verAnulados: true }).includes("7"), true);
});
