/* Jugadores de una pareja con su perfil (ver supabase/migrations/20261038_perfiles_jugador.sql).
   Cada pareja del torneo sigue teniendo su nombre ("Gimenez Elias / Perez Juan") y, si se cargó con
   teléfono, la lista players: [{ id, name }] con el ID fijo de cada jugador. El teléfono nunca va
   en el torneo (es público): queda solo en la tabla de perfiles.

   Sin React, para poder probarlo: ver jugadores.test.js. */

import { normalizeName, splitPair } from "./names.js";

/* "Gimenez Elias" -> { apellido: "Gimenez", nombre: "Elias" }. Con coma, el apellido es todo lo que
   va antes: "De la Fuente, Juan" -> { apellido: "De la Fuente", nombre: "Juan" } */
export function separarNombre(texto) {
  const limpio = String(texto || "").replace(/\s+/g, " ").trim();
  if (!limpio) return { apellido: "", nombre: "" };
  const coma = limpio.indexOf(",");
  if (coma >= 0) return { apellido: limpio.slice(0, coma).trim(), nombre: limpio.slice(coma + 1).trim() };
  const [apellido, ...resto] = limpio.split(" ");
  return { apellido, nombre: resto.join(" ") };
}

/* { apellido: "Gimenez", nombre: "Elias" } -> "Gimenez Elias" (apellido y nombre, en ese orden) */
export function nombreJugador({ apellido = "", nombre = "" }) {
  return `${apellido} ${nombre}`.replace(/\s+/g, " ").trim();
}

/* Nombre de la pareja a partir de sus jugadores: "Gimenez Elias / Perez Juan" */
export function nombrePareja(players) {
  return players.map((p) => p.name).filter(Boolean).join(" / ");
}

/* Los jugadores de una pareja: los de players si los tiene; si no (parejas cargadas antes, o sin
   teléfono), los nombres de la pareja, sin ID */
export function jugadoresConPerfil(pair) {
  if (Array.isArray(pair?.players) && pair.players.length > 0) return pair.players;
  return splitPair(pair?.name).map((name) => ({ id: null, name }));
}

/* Dónde está anotado cada jugador con perfil en el torneo: { [id]: "4TA" } (para avisar repetidos) */
export function perfilesEnTorneo(tournament) {
  const donde = {};
  (tournament?.categories || []).forEach((c) => (c.pairs || []).forEach((p) => {
    (p.players || []).forEach((j) => { if (j.id && !donde[j.id]) donde[j.id] = c.name; });
  }));
  return donde;
}

/* Ranking de una categoría del circuito, sumando por jugador. entradas: [{ players, points }] (una por
   pareja y por fecha). Suma por ID cuando el jugador lo tiene y por nombre cuando no; si un nombre sin
   ID es igual al de un jugador con ID (por ejemplo, fechas cargadas antes de usar teléfonos), se suma
   a ese jugador. Devuelve [{ name, points, fechas }] de mayor a menor. */
export function rankingPorJugador(entradas) {
  const porId = {};
  const porNombre = {};
  entradas.forEach(({ players, points }) => players.forEach((j) => {
    const tabla = j.id ? porId : porNombre;
    const clave = j.id || normalizeName(j.name);
    if (!clave) return;
    if (!tabla[clave]) tabla[clave] = { name: j.name, points: 0, fechas: 0 };
    tabla[clave].points += points;
    tabla[clave].fechas += 1;
  }));
  // Los que solo tienen nombre se juntan con el jugador con ID que se llama igual (si hay uno solo)
  const conId = Object.values(porId);
  Object.entries(porNombre).forEach(([clave, fila]) => {
    const iguales = conId.filter((x) => normalizeName(x.name) === clave);
    if (iguales.length === 1) {
      iguales[0].points += fila.points;
      iguales[0].fechas += fila.fechas;
      delete porNombre[clave];
    }
  });
  return [...conId, ...Object.values(porNombre)].sort((a, b) => b.points - a.points);
}
