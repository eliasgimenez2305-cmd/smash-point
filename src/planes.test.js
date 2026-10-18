import test from "node:test";
import assert from "node:assert/strict";
import { estadoCliente, finDeCobertura, incluyePlan } from "./planes.js";

const hoy = "2026-10-18";
const base = { activo: true, suspendido: false, dias_gracia: 7, desde: "2026-10", cuota_mensual: 100000 };

test("bonificado sin fecha: gratis para siempre", () => {
  assert.deepEqual(estadoCliente({ ...base, modo: "bonificado", vence: null }, hoy), { estado: "bonificado", fin: null, dias: null });
});

test("prueba: al terminar la prueba queda por vencer, en gracia y después vencido", () => {
  const c = { ...base, modo: "prueba", vence: "2026-11-15" };
  assert.equal(estadoCliente(c, hoy).estado, "prueba");
  assert.equal(estadoCliente(c, "2026-11-10").estado, "por_vencer");
  assert.equal(estadoCliente(c, "2026-11-15").estado, "por_vencer");
  assert.equal(estadoCliente(c, "2026-11-20").estado, "en_gracia");
  assert.equal(estadoCliente(c, "2026-11-23").estado, "vencido");
});

test("pago: cubierto hasta el último día del último mes cobrado", () => {
  const c = { ...base, modo: "pago", pagado_hasta: "2026-10" };
  assert.equal(finDeCobertura(c), "2026-10-31");
  assert.equal(estadoCliente(c, "2026-10-10").estado, "al_dia");
  assert.equal(estadoCliente(c, "2026-10-26").estado, "por_vencer");
  assert.equal(estadoCliente(c, "2026-11-05").estado, "en_gracia");
  assert.equal(estadoCliente({ ...c, pagado_hasta: "2026-02" }, hoy).fin, "2026-02-28");
});

test("pago sin ningún cobro: vence el día antes del mes en que empieza a pagar", () => {
  const c = { ...base, modo: "pago", pagado_hasta: null, desde: "2026-09" };
  assert.equal(finDeCobertura(c), "2026-08-31");
  assert.equal(estadoCliente(c, hoy).estado, "vencido");
  assert.equal(estadoCliente({ ...c, cuota_mensual: null }, hoy).estado, "al_dia"); // sin cuota no vence
});

test("suspendido y de baja mandan sobre todo lo demás", () => {
  assert.equal(estadoCliente({ ...base, modo: "pago", pagado_hasta: "2030-01", suspendido: true }, hoy).estado, "suspendido");
  assert.equal(estadoCliente({ ...base, modo: "bonificado", activo: false }, hoy).estado, "baja");
});

test("lo que incluye un plan en una línea", () => {
  assert.equal(incluyePlan({ para: "complejo", modulo_torneos: true, modulo_reservas: true, modulo_cantina: true, reportes: true, empleados: null }), "Torneos · Reservas · Cantina · Reportes · empleados sin tope");
  assert.equal(incluyePlan({ para: "complejo", modulo_reservas: true, empleados: 2 }), "Reservas · 2 empleados");
  assert.equal(incluyePlan({ para: "publicidad" }), "Publicidad en el sitio");
});
