import test from "node:test";
import assert from "node:assert/strict";
import { armarClientes, noVienenHace, claveNombre } from "./clientes.js";

const hoy = "2026-10-12";
const turno = (o) => ({ tipo: "turno", estado: "confirmada", precio: 15000, medio_pago: "efectivo", ...o });

test("clave por nombre sin acentos ni mayúsculas", () => {
  assert.equal(claveNombre("  Martín  MOYANO "), "martin moyano");
});

test("junta turnos, cuenta e inscripciones de la misma persona por WhatsApp", () => {
  const cs = armarClientes({
    hoy,
    reservas: [
      turno({ nombre: "Roberto", telefono: "5493446111111", fecha: "2026-10-01" }),
      turno({ nombre: "Roberto García", telefono: "5493446111111", fecha: "2026-10-08" }),
      turno({ nombre: "Roberto García", telefono: "5493446111111", fecha: "2026-10-15", medio_pago: null }),
      turno({ nombre: "Roberto García", telefono: "5493446111111", fecha: "2026-09-20", no_vino: true }),
      turno({ nombre: "Otro", telefono: "5493446222222", fecha: "2026-10-05", estado: "cancelada" }),
    ],
    cuentas: [{ id: "k1", nombre: "Roberto", telefono: "5493446111111", consumido: 8000, pagado: 3000 }],
    inscripciones: [{ jugador1_nombre: "Roberto G", telefono: "5493446111111", estado: "aceptada" }, { jugador1_nombre: "R", telefono: "5493446111111", estado: "rechazada" }],
  });
  const r = cs.find((c) => c.telefono === "5493446111111");
  assert.equal(r.nombre, "Roberto García"); // el nombre del turno más nuevo
  assert.equal(r.turnos, 2);
  assert.equal(r.proximos, 1);
  assert.equal(r.noVino, 1);
  assert.equal(r.ultimaVisita, "2026-10-08");
  assert.equal(r.diasSinVenir, 4);
  assert.equal(r.gastado, 30000);
  assert.equal(r.deuda, 5000);
  assert.equal(r.cuentaId, "k1");
  assert.equal(r.torneos, 1);
  // El que solo canceló aparece, pero sin turnos
  assert.equal(cs.find((c) => c.telefono === "5493446222222").turnos, 0);
});

test("sin WhatsApp se reconoce por el nombre, y se junta con el que tiene WhatsApp", () => {
  const cs = armarClientes({
    hoy,
    reservas: [
      turno({ nombre: "Juan Pérez", telefono: null, fecha: "2026-08-01" }),
      turno({ nombre: "juan perez", telefono: "5493446333333", fecha: "2026-08-10" }),
    ],
    cuentas: [{ id: "k2", nombre: "JUAN PÉREZ", telefono: null, consumido: 1000, pagado: 0 }],
  });
  assert.equal(cs.length, 1);
  assert.equal(cs[0].turnos, 2);
  assert.equal(cs[0].deuda, 1000);
  assert.equal(cs[0].telefono, "5493446333333");
});

test("no vienen hace 30 días (y no tienen turnos próximos)", () => {
  assert.equal(noVienenHace({ turnos: 3, proximos: 0, diasSinVenir: 45 }), true);
  assert.equal(noVienenHace({ turnos: 3, proximos: 1, diasSinVenir: 45 }), false);
  assert.equal(noVienenHace({ turnos: 3, proximos: 0, diasSinVenir: 10 }), false);
  assert.equal(noVienenHace({ turnos: 0, proximos: 0, diasSinVenir: null }), false);
});

test("un turno de hoy que todavía no empezó cuenta como próximo, no como jugado", () => {
  const ahora = Date.parse("2026-10-12T12:30:00-03:00");
  const cs = armarClientes({
    hoy, ahora,
    reservas: [
      turno({ nombre: "Ana", telefono: "5493446444444", fecha: hoy, inicio: "2026-10-12T21:00:00-03:00", medio_pago: null }),
      turno({ nombre: "Ana", telefono: "5493446444444", fecha: hoy, inicio: "2026-10-12T10:00:00-03:00" }),
    ],
  });
  assert.equal(cs[0].turnos, 1);
  assert.equal(cs[0].proximos, 1);
  assert.equal(cs[0].ultimaVisita, hoy);
});
