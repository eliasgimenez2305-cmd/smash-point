import { test } from "node:test";
import assert from "node:assert/strict";
import { claveEquipo, leerHora, leerFixture, revisarFixture, todosContraTodos, armarSemis, cruceFinal } from "./liga.js";

test("claveEquipo: ignora tildes, mayúsculas, espacios y guiones", () => {
  assert.equal(claveEquipo("MARÍA R - ALINA"), claveEquipo("maria r-alina"));
  assert.notEqual(claveEquipo("Pino-Daiman"), claveEquipo("Pino-Damian"));
});

test("leerHora", () => {
  assert.equal(leerHora("10:00"), "10:00");
  assert.equal(leerHora("9.40"), "09:40");
  assert.equal(leerHora("14 hs"), "14:00");
  assert.equal(leerHora("25:00"), null);
  assert.equal(leerHora("diez"), null);
});

test("leerFixture: reconoce parejas cargadas y anota las nuevas", () => {
  const parejas = [{ id: "p1", name: "Priolo - Acosta" }, { id: "p2", name: "Pino - Daiman" }];
  const r = leerFixture("# ronda; cancha; hora; A; B\n1; 1; 10:00; PRIOLO-ACOSTA; PINO-DAIMAN\n1;2;10:20;María R - Alina;Olmos-Gingene\n\n", parejas);
  assert.deepEqual(r.errores, []);
  assert.equal(r.partidos.length, 2);
  assert.deepEqual(r.partidos[0], { ronda: 1, cancha: "Cancha 1", hora: "10:00", a: "p1", b: "p2", nombreA: "PRIOLO-ACOSTA", nombreB: "PINO-DAIMAN" });
  assert.equal(r.partidos[1].a, null);
  assert.deepEqual(r.nuevas, ["María R - Alina", "Olmos-Gingene"]);
});

test("leerFixture: errores por renglón", () => {
  const r = leerFixture("1;1;10:00;A\nx;1;10:00;A;B\n1;1;tarde;A;B\n1;1;10:00;A;a", []);
  assert.equal(r.errores.length, 4);
  assert.match(r.errores[0], /Renglón 1/);
  assert.equal(r.partidos.length, 0);
});

test("revisarFixture: misma hora, rival repetido y cantidades distintas", () => {
  const ps = [
    { ronda: 1, hora: "10:00", a: "A", b: "B" },
    { ronda: 1, hora: "10:00", a: "A", b: "C" },
    { ronda: 2, hora: "10:40", a: "B", b: "A" },
  ];
  const av = revisarFixture(ps);
  assert.ok(av.some((x) => x === "A juega 2 partidos a las 10:00."));
  assert.ok(av.some((x) => /A vs B se repite \(rondas 1 y 2\)/.test(x)));
  assert.ok(av.some((x) => x.startsWith("C juega 1 partidos")));
  assert.deepEqual(revisarFixture([{ ronda: 1, hora: "10:00", a: "A", b: "B" }]), []);
});

test("todosContraTodos: cada uno juega una vez con cada otro (par e impar)", () => {
  for (const n of [4, 5, 12]) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const ps = todosContraTodos(ids);
    assert.equal(ps.length, (n * (n - 1)) / 2);
    const cruces = new Set(ps.map((p) => [p.a, p.b].sort().join("|")));
    assert.equal(cruces.size, ps.length);
    // nadie juega dos veces en la misma ronda
    const porRonda = {};
    ps.forEach((p) => { (porRonda[p.ronda] ||= []).push(p.a, p.b); });
    Object.values(porRonda).forEach((l) => assert.equal(new Set(l).size, l.length));
  }
});

test("armarSemis y cruceFinal", () => {
  assert.equal(armarSemis(["a", "b", "c"]), null);
  assert.deepEqual(armarSemis(["a", "b", "c", "d"]), [{ a: "a", b: "d" }, { a: "b", b: "c" }]);
  const semis = [{ pairA: "a", pairB: "d" }, { pairA: "b", pairB: "c" }];
  assert.deepEqual(cruceFinal(semis, () => null), { final: [null, null], tercero: [null, null] });
  const g = { 0: "d", 1: "b" };
  assert.deepEqual(cruceFinal(semis, (s) => g[semis.indexOf(s)]), { final: ["d", "b"], tercero: ["a", "c"] });
});
