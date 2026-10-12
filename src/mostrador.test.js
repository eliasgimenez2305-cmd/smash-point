import test from "node:test";
import assert from "node:assert/strict";
import { rubrosDe, subtotalDe, ajusteDe, resumenPagos, vueltoDe, itemsParaVender } from "./mostrador.js";

test("rubros: primero los sugeridos en su orden, después los propios", () => {
  const ps = [{ rubro: "Paletas" }, { rubro: "Grips" }, { rubro: "Bebidas" }, { rubro: "" }, { rubro: "Paletas" }, {}];
  assert.deepEqual(rubrosDe(ps), ["Bebidas", "Paletas", "Grips"]);
});

test("subtotal del ticket", () => {
  assert.equal(subtotalDe([{ precio: 1500, cantidad: 2 }, { precio: 8000, cantidad: 1 }]), 11000);
  assert.equal(subtotalDe([]), 0);
});

test("descuento y recargo", () => {
  assert.equal(ajusteDe(250000, { tipo: "descuento", modo: "%", valor: 10 }), -25000);
  assert.equal(ajusteDe(250000, { tipo: "recargo", modo: "%", valor: 10 }), 25000);
  assert.equal(ajusteDe(10000, { tipo: "descuento", modo: "$", valor: 1500 }), -1500);
  assert.equal(ajusteDe(10000, { tipo: "descuento", modo: "$", valor: 99999 }), -10000); // nunca más que el total
  assert.equal(ajusteDe(10000, { valor: 0 }), 0);
  assert.equal(ajusteDe(3333, { tipo: "descuento", modo: "%", valor: 10 }), -333);
});

test("pago dividido: lo que falta y lo que sobra", () => {
  assert.deepEqual(resumenPagos(225000, [{ medio: "efectivo", monto: 100000 }, { medio: "transferencia", monto: 125000 }]), { pagado: 225000, falta: 0, sobra: 0 });
  assert.deepEqual(resumenPagos(250000, [{ medio: "efectivo", monto: 50000 }]), { pagado: 50000, falta: 200000, sobra: 0 });
  assert.deepEqual(resumenPagos(1000, [{ medio: "efectivo", monto: 1500 }]), { pagado: 1500, falta: 0, sobra: 500 });
  assert.deepEqual(resumenPagos(1000, [{ medio: "efectivo", monto: "" }]), { pagado: 0, falta: 1000, sobra: 0 });
});

test("vuelto", () => {
  assert.equal(vueltoDe(20000, 11000), 9000);
  assert.equal(vueltoDe(10000, 11000), null);
  assert.equal(vueltoDe("", 11000), null);
});

test("items para vender", () => {
  assert.deepEqual(itemsParaVender({ a: 2, b: 0 }, [{ descripcion: " Encordado ", precio: "8000" }]), [
    { producto_id: "a", cantidad: 2 },
    { descripcion: "Encordado", precio: 8000, cantidad: 1 },
  ]);
});
