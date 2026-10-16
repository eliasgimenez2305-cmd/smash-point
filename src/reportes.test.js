import test from "node:test";
import assert from "node:assert/strict";
import { diasDelMes, ocupacionMes, sumarPorMes, rankingProductos } from "./reportes.js";

test("días del mes", () => {
  assert.equal(diasDelMes("2026-02").length, 28);
  assert.equal(diasDelMes("2026-10")[30], "2026-10-31");
});

test("ocupación: horas abiertas, ocupadas y % por día y hora", () => {
  const canchas = [{ id: "c1", nombre: "Cancha 1", apertura: "20:00:00", cierre: "22:00:00" }];
  const reservas = [
    { tipo: "turno", estado: "confirmada", cancha_id: "c1", fecha: "2026-02-03", inicio: "2026-02-03T20:00:00-03:00", fin: "2026-02-03T21:30:00-03:00" }, // martes
    { tipo: "turno", estado: "cancelada", cancha_id: "c1", fecha: "2026-02-04", inicio: "2026-02-04T20:00:00-03:00", fin: "2026-02-04T21:30:00-03:00" },
    { tipo: "bloqueo", estado: "confirmada", cancha_id: "c1", fecha: "2026-02-05", inicio: "2026-02-05T20:00:00-03:00", fin: "2026-02-05T22:00:00-03:00" },
  ];
  const o = ocupacionMes({ canchas, reservas, mes: "2026-02" });
  assert.equal(o.porCancha[0].horasAbiertas, 56); // 28 días × 2 h
  assert.equal(o.porCancha[0].horasOcupadas, 1.5);
  assert.deepEqual(o.horas, [20, 21]);
  // Martes 20 h: 1 de 4 martes ocupado entero → 25%; 21 h: media hora de 4 horas → 13%
  assert.equal(o.pct(2, 20), 25);
  assert.equal(o.pct(2, 21), 13);
  assert.equal(o.pct(3, 20), 0);
  assert.equal(o.pct(2, 9), null);
});

test("ocupación con cierre después de medianoche", () => {
  const canchas = [{ id: "c1", nombre: "C", apertura: "23:00:00", cierre: "01:00:00" }];
  const reservas = [{ tipo: "turno", estado: "confirmada", cancha_id: "c1", fecha: "2026-02-01", inicio: "2026-02-01T23:30:00-03:00", fin: "2026-02-02T00:30:00-03:00" }];
  const o = ocupacionMes({ canchas, reservas, mes: "2026-02" });
  assert.equal(o.porCancha[0].horasOcupadas, 1);
  assert.deepEqual(o.horas, [23, 24]);
});

test("sumar por mes y ranking de productos", () => {
  assert.deepEqual(sumarPorMes([{ fecha: "2026-09-30", monto: 100 }, { fecha: "2026-10-01", monto: 50 }, { fecha: "2026-10-20", monto: "25" }]), { "2026-09": 100, "2026-10": 75 });
  const r = rankingProductos([
    { descripcion: "Agua", cantidad: 10, precio_unitario: 1500, costo_unitario: 500 },
    { descripcion: "Paleta", cantidad: 1, precio_unitario: 250000 },
    { descripcion: "Agua", cantidad: 2, precio_unitario: 1500, costo_unitario: 550 },
  ]);
  assert.equal(r[0].descripcion, "Paleta");
  assert.equal(r[0].conCosto, false);
  assert.equal(r[1].cantidad, 12);
  assert.equal(r[1].facturado, 18000);
  assert.equal(r[1].ganancia, 10000 + 1900);
});

test("ranking: los talles del mismo producto van juntos", () => {
  const r = rankingProductos([
    { producto_id: "p1", talle: "S", descripcion: "Remera S", cantidad: 1, precio_unitario: 100 },
    { producto_id: "p1", talle: "M", descripcion: "Remera M", cantidad: 2, precio_unitario: 100 },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].descripcion, "Remera");
  assert.equal(r[0].cantidad, 3);
});
