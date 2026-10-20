import { test } from "node:test";
import assert from "node:assert/strict";
import { separarNombre, nombreJugador, nombrePareja, jugadoresConPerfil, perfilesEnTorneo, rankingPorJugador } from "./jugadores.js";

test("separarNombre: el primer apellido y el resto es el nombre", () => {
  assert.deepEqual(separarNombre("  Gimenez   Elias  "), { apellido: "Gimenez", nombre: "Elias" });
  assert.deepEqual(separarNombre("Perez Juan Carlos"), { apellido: "Perez", nombre: "Juan Carlos" });
  assert.deepEqual(separarNombre("Perez"), { apellido: "Perez", nombre: "" });
  assert.deepEqual(separarNombre(""), { apellido: "", nombre: "" });
});

test("separarNombre: con coma, el apellido compuesto va antes", () => {
  assert.deepEqual(separarNombre("De la Fuente, Juan"), { apellido: "De la Fuente", nombre: "Juan" });
});

test("nombreJugador y nombrePareja: apellido y nombre, en ese orden", () => {
  assert.equal(nombreJugador({ apellido: "Gimenez", nombre: "Elias" }), "Gimenez Elias");
  assert.equal(nombreJugador({ apellido: "Perez", nombre: "" }), "Perez");
  assert.equal(nombrePareja([{ name: "Gimenez Elias" }, { name: "Perez Juan" }]), "Gimenez Elias / Perez Juan");
});

test("jugadoresConPerfil: usa players y, si no hay, los nombres de la pareja", () => {
  assert.deepEqual(jugadoresConPerfil({ name: "X", players: [{ id: "a", name: "Gimenez Elias" }] }), [{ id: "a", name: "Gimenez Elias" }]);
  assert.deepEqual(jugadoresConPerfil({ name: "Gómez / Ibáñez" }), [{ id: null, name: "Gómez" }, { id: null, name: "Ibáñez" }]);
});

test("perfilesEnTorneo: en qué categoría está cada perfil", () => {
  const t = { categories: [
    { name: "4TA", pairs: [{ name: "A / B", players: [{ id: "a", name: "A" }, { id: null, name: "B" }] }] },
    { name: "5TA", pairs: [{ name: "C / D" }] },
  ] };
  assert.deepEqual(perfilesEnTorneo(t), { a: "4TA" });
});

test("rankingPorJugador: suma por ID aunque cambie el nombre escrito", () => {
  const r = rankingPorJugador([
    { players: [{ id: "a", name: "Gimenez Elias" }, { id: "b", name: "Perez Juan" }], points: 100 },
    { players: [{ id: "a", name: "Gimenez E." }, { id: "c", name: "Lopez Ana" }], points: 50 },
  ]);
  assert.deepEqual(r[0], { name: "Gimenez Elias", points: 150, fechas: 2 });
  assert.equal(r.length, 3);
});

test("rankingPorJugador: sin ID suma por nombre, como antes", () => {
  const r = rankingPorJugador([
    { players: [{ id: null, name: "Ibáñez" }], points: 30 },
    { players: [{ id: null, name: "Ibanez" }], points: 20 },
  ]);
  assert.deepEqual(r, [{ name: "Ibáñez", points: 50, fechas: 2 }]);
});

test("rankingPorJugador: una fecha vieja sin ID se junta con el jugador que se llama igual", () => {
  const r = rankingPorJugador([
    { players: [{ id: null, name: "Gimenez Elias" }], points: 10 },
    { players: [{ id: "a", name: "Gimenez Elias" }], points: 100 },
  ]);
  assert.deepEqual(r, [{ name: "Gimenez Elias", points: 110, fechas: 2 }]);
});

test("rankingPorJugador: si dos jugadores con ID se llaman igual, el nombre suelto no se junta", () => {
  const r = rankingPorJugador([
    { players: [{ id: "a", name: "Perez Juan" }], points: 100 },
    { players: [{ id: "b", name: "Perez Juan" }], points: 70 },
    { players: [{ id: null, name: "Perez Juan" }], points: 10 },
  ]);
  assert.equal(r.length, 3);
});
