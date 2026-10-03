/* Tests del aviso de nombres repetidos (names.js). Se corren con `npm test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, nameMatch, splitPair, findNameDuplicates } from "./names.js";

test("normaliza acentos, mayúsculas, signos y espacios", () => {
  assert.equal(normalizeName("  Juan  PÉREZ. "), "juan perez");
  assert.equal(normalizeName("Ibáñez"), "ibanez");
});

test("mismo nombre escrito distinto: igual", () => {
  assert.equal(nameMatch("Juan Pérez", "juan perez"), "igual");
  assert.equal(nameMatch("Pérez Juan", "Juan Pérez"), "igual", "no importa el orden");
  assert.equal(nameMatch("JUAN  PEREZ", "Juan Pérez"), "igual");
});

test("solo el apellido contra nombre completo: parecido", () => {
  assert.equal(nameMatch("Pérez", "Juan Pérez"), "parecido");
  assert.equal(nameMatch("Juan Pérez", "perez"), "parecido");
});

test("nombres distintos: sin aviso", () => {
  assert.equal(nameMatch("Juan Pérez", "Martín López"), null);
  assert.equal(nameMatch("Juan Pérez", "Juan López"), null, "comparten el nombre de pila pero no son la misma persona");
  assert.equal(nameMatch("", "Juan"), null);
});

test("separa los jugadores de una pareja", () => {
  assert.deepEqual(splitPair("Gómez / Ibáñez"), ["Gómez", "Ibáñez"]);
  assert.deepEqual(splitPair("Juan Pérez"), ["Juan Pérez"]);
});

test("encuentra al jugador en otra categoría y en otra inscripción pendiente", () => {
  const found = findNameDuplicates(["Juan Pérez", "Martín López"], [
    { name: "Perez Juan / Diego Ruiz", where: "4ta", kind: "anotada" },
    { name: "López / Sosa", where: "5ta", kind: "pendiente" },
    { name: "Carlos Díaz / Pablo Gómez", where: "4ta", kind: "anotada" },
  ]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => [f.player, f.where, f.match]), [["Juan Pérez", "4ta", "igual"], ["Martín López", "5ta", "parecido"]]);
});
