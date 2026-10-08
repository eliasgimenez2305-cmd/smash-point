/* Cuadro de la llave final de un torneo Clásico, como los arma la FAP (Federación Argentina de
   Pádel): un cuadro fijo según cuántos grupos hay y cuántas parejas clasifican de cada uno.

   - Los lugares se definen por letra de grupo ("1° Grupo A", "2° Grupo C"...), no por los
     resultados: el cuadro es el mismo desde que se arman los grupos hasta que se juega la llave, y
     cuando terminan los grupos solo se completa quién ocupa cada lugar.
   - Las configuraciones que ya vimos jugarse (Circuito Gualeguaychú 2026 en Padel NET, 41 llaves)
     están cargadas tal cual en FAP_TABLES, así el cuadro es idéntico al que conocen los jugadores.
   - Para las demás, fapGeneratedSlots arma uno con las mismas reglas (ver ahí).

   Sin React, para poder probarlo: ver bracketFap.test.js. */

/* Cuadros FAP vistos: clave = clasificados de cada grupo en orden de letra ("3,2,2" = el A
   clasifica 3 y el B y el C, 2). Valor = la primera ronda de arriba hacia abajo, de a dos lugares
   por partido; "2C" = 2° del Grupo C y null = bye (esa pareja pasa directo). */
export const FAP_TABLES = {
  "3,2": ["1A", null, "3A", "2B", "2A", null, "1B", null],
  "3,3": ["1A", null, "3A", "2B", "2A", "3B", "1B", null],
  "3,2,2": ["1A", null, "2B", "2C", "1C", "2A", "3A", "1B"],
  "3,3,2": ["1A", "3B", "2B", "2C", "1C", "2A", "3A", "1B"],
  "2,2,2,2": ["1A", "2B", "2C", "1D", "1C", "2D", "2A", "1B"],
  "3,2,2,2": ["1A", null, "3A", "2B", "2C", null, "1D", null, "1C", null, "2D", null, "2A", null, "1B", null],
  "3,3,2,2": ["1A", null, "3A", "2B", "2C", null, "1D", null, "1C", null, "2D", null, "2A", "3B", "1B", null],
  "2,2,2,2,2": ["1A", null, "2B", "2C", "1E", null, "1D", null, "1C", null, "2E", null, "2D", "2A", "1B", null],
  "3,2,2,2,2": ["1A", null, "2B", "2C", "1E", null, "1D", null, "1C", null, "3A", "2E", "2D", "2A", "1B", null],
  "3,3,2,2,2": ["1A", null, "2B", "2C", "1E", "3B", "1D", null, "1C", null, "3A", "2E", "2D", "2A", "1B", null],
  "2,2,2,2,2,2": ["1A", null, "2C", "2F", "1E", "2B", "1D", null, "1C", null, "2A", "1F", "2E", "2D", "1B", null],
  "3,3,2,2,2,2": ["1A", null, "2C", "2F", "1E", "2B", "3A", "1D", "1C", "3B", "2A", "1F", "2E", "2D", "1B", null],
  "2,2,2,2,2,2,2": ["1A", null, "2F", "2G", "1E", "2C", "2B", "1D", "1C", "2A", "2D", "1F", "1G", "2E", "1B", null],
  "3,2,2,2,2,2,2": ["1A", null, "2F", "2G", "1E", "2C", "2B", "1D", "1C", "2A", "2D", "1F", "1G", "2E", "3A", "1B"],
  "2,2,2,2,2,2,2,2": ["1A", "2B", "2G", "1H", "1E", "2F", "2C", "1D", "1C", "2D", "2E", "1F", "1G", "2H", "2A", "1B"],
  "2,2,2,2,2,2,2,2,2": ["1A", null, "2B", "2C", "1I", null, "1H", null, "1E", null, "2G", null, "2F", null, "1D", null, "1C", null, "2E", null, "2H", null, "1F", null, "1G", null, "2I", null, "2D", "2A", "1B", null],
  "3,2,2,2,2,2,2,2,2": ["1A", null, "2B", "2C", "1I", null, "1H", null, "1E", null, "2G", null, "2F", null, "1D", null, "1C", null, "3A", "2E", "2H", null, "1F", null, "1G", null, "2I", null, "2D", "2A", "1B", null],
  "3,3,2,2,2,2,2,2,2,2": ["1A", null, "2C", "2F", "1I", null, "1H", null, "1E", null, "3B", "2J", "2G", "2B", "1D", null, "1C", null, "2A", "2H", "2I", "3A", "1F", null, "1G", null, "1J", null, "2E", "2D", "1B", null],
  "2,2,2,2,2,2,2,2,2,2,2": ["1A", null, "2F", "2G", "1I", null, "1H", null, "1E", null, "2B", "2K", "2J", "2C", "1D", null, "1C", null, "2D", "2I", "1K", "2A", "1F", null, "1G", null, "1J", null, "2H", "2E", "1B", null],
  "2,2,2,2,2,2,2,2,2,2,2,2": ["1A", null, "2G", "2J", "1I", "2B", "1H", null, "1E", null, "2C", "1L", "2K", "2F", "1D", null, "1C", null, "2E", "2L", "1K", "2D", "1F", null, "1G", null, "2A", "1J", "2I", "2H", "1B", null],
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/* Orden de los partidos de primera ronda según la siembra de su lugar de arriba, como en los
   cuadros FAP: el 1 arriba de todo, el 2 abajo de todo, el 3 al principio de la mitad de abajo, el 4
   al final de la de arriba... La mitad de abajo es el espejo de la de arriba (cada siembra impar
   enfrente de la par que le sigue). Ej. con 8 partidos: [1, 8, 5, 4, 3, 6, 7, 2]. */
export function seedLines(lines) {
  if (lines <= 1) return [1];
  let top = [1];
  for (let n = 4; n <= lines; n *= 2) {
    top = top.flatMap((s, i) => (i % 2 === 0 ? [s, n + 1 - s] : [n + 1 - s, s]));
  }
  const partner = (s) => (s % 2 === 1 ? s + 1 : s - 1);
  return [...top, ...[...top].reverse().map(partner)];
}

/* Arma el cuadro para una configuración que no está en FAP_TABLES, con las mismas reglas:
   - Siembra: primero los 1° por letra (el 1A es el 1), después los 2° desde el último grupo hacia el
     A, y después los 3°. Los byes van a las mejores siembras (nunca a un 3°).
   - Cada partido enfrenta a la siembra s con la S + 1 - s (S = tamaño del cuadro).
   - Después se acomoda moviendo solo a los 2° y 3° (los 1° y los byes quedan fijos) para que, en
     orden de importancia: nunca se crucen en primera ronda dos del mismo grupo; el 1° y el 2° de un
     grupo queden en mitades opuestas (solo se pueden cruzar en la final); el 1° quede solo en su
     mitad si el grupo clasifica 3; y, si se puede, que dos del mismo grupo no queden en el mismo
     cuarto. Entre los acomodos posibles, el más parecido a la siembra. */
export function fapGeneratedSlots(counts) {
  const entrants = [];
  counts.forEach((_, g) => entrants.push({ group: g, place: 1 }));
  for (let g = counts.length - 1; g >= 0; g--) if (counts[g] >= 2) entrants.push({ group: g, place: 2 });
  for (let g = counts.length - 1; g >= 0; g--) for (let p = 3; p <= counts[g]; p++) entrants.push({ group: g, place: p });
  const n = entrants.length;
  if (n === 0) return [];
  let size = 2;
  while (size < n) size *= 2;
  const lines = size / 2;

  // Lugares iniciales por siembra
  const slots = new Array(size).fill(null);
  seedLines(lines).forEach((seed, line) => {
    slots[line * 2] = seed <= n ? entrants[seed - 1] : null;
    const opp = size + 1 - seed;
    slots[line * 2 + 1] = opp <= n ? entrants[opp - 1] : null;
  });
  if (counts.length < 2) return slots;

  const cost = (arr) => {
    let c = 0;
    const byGroup = {};
    arr.forEach((e, i) => { if (e) (byGroup[e.group] = byGroup[e.group] || []).push({ e, i }); });
    for (let i = 0; i < size; i += 2) {
      if (arr[i] && arr[i + 1] && arr[i].group === arr[i + 1].group) c += 100000; // mismo grupo en primera ronda
      if (arr[i] && arr[i + 1] && arr[i].place === 1 && arr[i + 1].place === 1) c += 1000; // dos 1° en primera ronda
    }
    Object.values(byGroup).forEach((list) => {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const x = list[a], y = list[b];
          const sameHalf = Math.floor(x.i / (size / 2)) === Math.floor(y.i / (size / 2));
          const sameQuarter = size >= 8 && Math.floor(x.i / (size / 4)) === Math.floor(y.i / (size / 4));
          const hasFirst = x.e.place === 1 || y.e.place === 1;
          if (sameHalf) c += hasFirst ? (x.e.place + y.e.place === 3 ? 10000 : 2000) : 0;
          if (sameQuarter) c += hasFirst ? 300 : 100;
        }
      }
    });
    // Parecido a la siembra: cuánto se movió cada pareja
    arr.forEach((e, i) => { if (e && e.place > 1) c += Math.abs(i - (e.home ?? i)) * 0.01; });
    return c;
  };
  slots.forEach((e, i) => { if (e) e.home = i; });

  // Solo se mueven los 2° y 3°, y un 3° nunca pasa a un lugar con bye
  const movable = slots.map((e, i) => (e && e.place > 1 ? i : -1)).filter((i) => i >= 0);
  const byeLine = (i) => slots[i ^ 1] === null;
  const canSwap = (arr, i, j) => !((arr[i].place >= 3 && byeLine(j)) || (arr[j].place >= 3 && byeLine(i)));
  // Intercambios de a dos mientras mejore
  const climb = (arr) => {
    let current = cost(arr);
    let improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (let a = 0; a < movable.length; a++) {
        for (let b = a + 1; b < movable.length; b++) {
          const i = movable[a], j = movable[b];
          if (!canSwap(arr, i, j)) continue;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          const next = cost(arr);
          if (next < current - 1e-9) { current = next; improved = true; } else [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      }
    }
    return current;
  };
  // Desde la siembra y desde otros puntos de partida (mezclas fijas, así el cuadro sale siempre
  // igual para la misma configuración): queda el mejor
  let best = [...slots], bestCost = climb(best);
  let seed = 12345;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let attempt = 0; attempt < 40 && bestCost >= 1; attempt++) {
    const arr = [...slots];
    for (let k = movable.length - 1; k > 0; k--) {
      const i = movable[k], j = movable[rnd(k + 1)];
      if (canSwap(arr, i, j)) [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const c = climb(arr);
    if (c < bestCost - 1e-9) { best = arr; bestCost = c; }
  }
  return best.map((e) => (e ? { group: e.group, place: e.place } : null));
}

/* Primera ronda del cuadro: lista de lugares de arriba hacia abajo (de a dos por partido), cada uno
   { group: índice del grupo, place: puesto } o null (bye). counts = cuántos clasifican de cada
   grupo, en el orden de los grupos (A, B, C...). Un grupo que no clasifica a nadie no ocupa letra
   en el cuadro, pero sí la suya propia en los nombres. */
export function fapRound1(counts) {
  const used = counts.map((c, g) => ({ c, g })).filter((x) => x.c > 0);
  if (used.reduce((s, x) => s + x.c, 0) < 2) return null;
  const table = FAP_TABLES[used.map((x) => x.c).join(",")];
  const slots = table
    ? table.map((s) => (s ? { group: LETTERS.indexOf(s[1]), place: Number(s[0]) } : null))
    : fapGeneratedSlots(used.map((x) => x.c));
  return slots.map((s) => (s ? { group: used[s.group].g, place: s.place } : null));
}
