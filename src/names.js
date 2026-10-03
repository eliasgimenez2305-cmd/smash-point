/* Comparación de nombres de jugadores para avisar posibles inscripciones repetidas en un mismo
   torneo. Es solo un aviso para el organizador (nunca bloquea): dos personas distintas pueden
   llamarse parecido. Está en un archivo aparte (sin React) para poder probarlo: ver names.test.js. */

/* "  Juan  PÉREZ " -> "juan perez": sin acentos, en minúscula, sin signos y con un solo espacio */
export function normalizeName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Palabras del nombre, ordenadas: "Pérez Juan" y "Juan Pérez" dan lo mismo */
function nameTokens(name) {
  return normalizeName(name).split(" ").filter(Boolean).sort();
}

/* Jugadores de una pareja: "Gómez / Ibáñez" -> ["Gómez", "Ibáñez"] */
export function splitPair(pairName) {
  return String(pairName || "").split("/").map((s) => s.trim()).filter(Boolean);
}

/* Cuánto se parecen dos nombres de jugador:
   - "igual": las mismas palabras, sin importar acentos, mayúsculas ni el orden
   - "parecido": uno es una sola palabra (ej. solo el apellido, como suele cargar el organizador a
     mano) y está en el otro: "Pérez" y "Juan Pérez"
   - null: no se parecen */
export function nameMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return null;
  if (ta.join(" ") === tb.join(" ")) return "igual";
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 1 && short[0].length >= 3 && long.includes(short[0])) return "parecido";
  return null;
}

/* Busca, para cada jugador de `players`, otras anotaciones del mismo torneo con un nombre igual o
   parecido. `entries` son las otras anotaciones: [{ name: "A / B", where: "4ta", kind }]. Devuelve
   [{ player, other, where, kind, match }], primero las "igual". */
export function findNameDuplicates(players, entries) {
  const found = [];
  players.forEach((player) => {
    entries.forEach((e) => {
      splitPair(e.name).forEach((other) => {
        const match = nameMatch(player, other);
        if (match) found.push({ player, other, where: e.where, kind: e.kind, match });
      });
    });
  });
  return found.sort((x, y) => (x.match === y.match ? 0 : x.match === "igual" ? -1 : 1));
}
