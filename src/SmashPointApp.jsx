import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import portadaUrl from "./assets/portada.jpg";
import logoMarkUrl from "./assets/logo-mark.png";

/* ---------- Utilidades de datos ---------- */

const uid = () => Math.random().toString(36).slice(2, 10);

const STORAGE_KEY_TOURNAMENTS = "sp:tournaments";
const STORAGE_KEY_ADS = "sp:ads";
const STORAGE_KEY_CIRCUITS = "sp:circuits";
// Foto de portada de cada organizador ({ [organizerId]: url }): se guarda aparte porque la tabla
// organizers de Supabase solo tiene nombre y logo
const STORAGE_KEY_ORGANIZER_COVERS = "sp:organizer_covers";

/* ---------- Supabase (login y perfiles de organizador) ---------- */
/* Usamos fetch directo a la API REST de Supabase (sin el SDK) para que
   este archivo siga funcionando igual en el sandbox de Claude y en producción. */
const SUPABASE_URL = "https://cfaapvyttzedackbmkpt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_D6uARuXOiMKEmpOr2evMsQ_r7V3d9wh";

async function supabaseSignIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Usuario o contraseña incorrectos.");
  return data; // { access_token, user: { id, email, ... }, ... }
}

async function supabaseRequestPasswordReset(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error_description || data.msg || "No pudimos enviar el correo de recuperación.");
  }
}

async function fetchOrganizers() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/organizers?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("No se pudo cargar la lista de organizadores.");
  const rows = await res.json();
  return rows.map((r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, logoUrl: r.logo_url }));
}

async function updateOrganizerProfileRemote(id, accessToken, patch) {
  const body = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.logoUrl !== undefined) body.logo_url = patch.logoUrl;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/organizers?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("No se pudo guardar el perfil.");
}

/* Crear/borrar cuentas de organizador de verdad: pasa por una Edge Function de Supabase
   (admin-organizers) porque esto requiere la service_role key, que nunca debe estar en el
   navegador. Solo funciona si el que llama está logueado como "creador". */
async function callAdminOrganizers(accessToken, payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-organizers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "No se pudo completar la operación.");
  return data;
}

/* Guardado genérico (torneos, anuncios, circuitos) en la tabla app_data de Supabase.
   Reemplaza a window.storage, que solo existe dentro del sandbox de Claude. */
async function kvGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SUPABASE_ANON_KEY },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`No se pudo leer "${key}".`);
  const rows = await res.json();
  return rows.length > 0 ? rows[0].value : null;
}

async function kvSet(key, value, accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`No se pudo guardar "${key}".`);
}

/* ---------- Inscripciones online (ver supabase/migrations/20260927_inscripciones.sql) ---------- */

/* Llama a una función de Supabase. Sin accessToken va como público (anon). Si falla, el error trae
   en .code el motivo que manda la función (ej: "cupo_completo"). */
async function supabaseRpc(fn, params, accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || "No se pudo completar la operación.");
    err.code = data?.message;
    throw err;
  }
  return data;
}

/* Inscripciones de los torneos del organizador logueado (la base solo le devuelve las suyas) */
async function fetchInscripciones(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/inscripciones?select=*&order=created_at.desc`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("No se pudieron cargar las inscripciones.");
  return res.json();
}

const INSCRIPCION_ERRORES = {
  inscripciones_cerradas: "Las inscripciones de este torneo están cerradas.",
  categoria_invalida: "Elegí una categoría válida.",
  cupo_completo: "El cupo de esa categoría ya está completo.",
  datos_invalidos: "Revisá los nombres: tienen que tener entre 3 y 80 letras.",
  telefono_invalido: "Revisá el WhatsApp: tiene que ser un número de Argentina con característica.",
  duplicada: "Ya hay una inscripción con ese WhatsApp en esta categoría.",
  no_autorizado: "No tenés permiso para esta inscripción.",
  ya_resuelta: "Esta inscripción ya fue aceptada o rechazada.",
  partidos_generados: "Los partidos de esa categoría ya están generados: no se pueden sumar inscriptos.",
  torneo_no_encontrado: "No se encontró el torneo de esta inscripción.",
};
const inscripcionErrorText = (e) => INSCRIPCION_ERRORES[e?.code] || "No se pudo completar. Probá de nuevo en un rato.";

/* WhatsApp argentino a formato internacional sin signos (549 + característica + número), el que usa
   wa.me. Acepta cómo lo escribe la gente: con +54, con 9, con 0 adelante o con 15. Devuelve null si
   no se puede armar un número válido. */
function normalizeArPhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.startsWith("549") && d.length === 13) return d;
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("9") && d.length === 11) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 12) {
    for (const pos of [2, 3, 4]) {
      if (d.slice(pos, pos + 2) === "15") { d = d.slice(0, pos) + d.slice(pos + 2); break; }
    }
  }
  return d.length === 10 ? "549" + d : null;
}

function formatArPhone(normalized) {
  return normalized ? `+54 9 ${normalized.slice(3)}` : "";
}

/* Cupo de una categoría (el Súper 8 es siempre de 8); null = sin límite */
function categoryCupo(category) {
  if (isSuper8(category)) return SUPER8_SIZE;
  return Number.isInteger(category.cupo) && category.cupo > 0 ? category.cupo : null;
}

/* Un Súper 8 con los partidos ya generados no admite más inscriptos */
function categoryAcceptsRegistrations(category) {
  return !(isSuper8(category) && category.groups.length > 0);
}

/* Lugares libres: cuentan todas las parejas anotadas (a mano o aceptadas). null = sin límite */
function categorySpotsLeft(category) {
  const cupo = categoryCupo(category);
  return cupo == null ? null : Math.max(0, cupo - category.pairs.length);
}

/* Estado de las inscripciones de un torneo para la vista pública: "abierto", "completo" (todas las
   categorías llenas) o "cerrado" (no se muestra el botón) */
function registrationStatus(t) {
  if (!t.inscripcionesAbiertas || t.status === STATUS.FINALIZADO) return "cerrado";
  const categories = (t.categories || []).filter(categoryAcceptsRegistrations);
  if (categories.length === 0) return "cerrado";
  return categories.some((c) => categorySpotsLeft(c) !== 0) ? "abierto" : "completo";
}

/* Subida de imágenes (logos, publicidades, portadas de torneo) a Supabase Storage.
   El bucket "images" tiene que existir y ser público (ver instrucciones de configuración). */
const IMAGES_BUCKET = "images";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

async function uploadImageToSupabase(file, accessToken, folder = "misc") {
  if (!accessToken) throw new Error("Tenés que iniciar sesión de nuevo para subir imágenes.");
  if (!file.type || !file.type.startsWith("image/")) throw new Error("El archivo tiene que ser una imagen.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("La imagen pesa demasiado (máximo 5 MB).");
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(file.name || "");
  const ext = (extMatch ? extMatch[1] : "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${folder}/${uid()}${Date.now().toString(36)}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGES_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": file.type,
      "x-upsert": "false",
    },
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || "No se pudo subir la imagen.");
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGES_BUCKET}/${path}`;
}

const STATUS = {
  PROXIMO: "Próximo",
  EN_CURSO: "En curso",
  FINALIZADO: "Finalizado",
};

const DEFAULT_MATCH_FORMAT = { setsToPlay: 3, gamesPerSet: 6, setTiebreak: true, finalSuperTiebreak: true };

/* ---------- Tipo de torneo ---------- */

/* Cada torneo es de uno de tres tipos, que se elige al crearlo (y se puede cambiar después):
   - Clásico: zonas + llave final, partidos por sets, con grilla de horarios.
   - Súper 8: cada categoría es un cuadro fijo de 8 jugadores sueltos (Individual) u 8 parejas
     (Por Parejas) que termina en tabla de posiciones. Un solo set a los games que elija el organizador.
   - Americano: zonas + llave final en un solo día, con un set único a 7 o a 9 games. Usa la grilla
     de horarios (canchas, horario de arranque y tiempo entre partidos se piden al crearlo).
   El Súper 8 no usa la grilla de horarios: los partidos se juegan uno atrás del otro.
   En los formatos de set único, si llegan a N-1 iguales se define con un tie break a 7 puntos con
   diferencia de 2 y el set queda N a N-1 (7-6 jugando a 7, 9-8 jugando a 9). */
const TOURNAMENT_TYPE_LABEL = { clasico: "Clásico", super8: "Súper 8", americano: "Americano" };
const SUPER8_MODE_LABEL = { individual: "Individual", parejas: "Por Parejas" };
const SUPER8_GAMES_OPTIONS = [4, 5, 6, 7, 8, 9];
const AMERICANO_GAMES_OPTIONS = [7, 9];

function singleSetMatchFormat(type, games) {
  return { type, setsToPlay: 1, gamesPerSet: games, setTiebreak: true, finalSuperTiebreak: false };
}

function isSingleSetFormat(format) {
  return format?.type === "americano" || format?.type === "super8";
}

/* Torneos creados antes de que existiera el tipo: son Clásicos, salvo los que ya tenían el
   formato de partido Americano. */
function tournamentType(t) {
  return t.type || (t.matchFormat?.type === "americano" ? "americano" : "clasico");
}

function tournamentUsesSchedule(t) {
  return tournamentType(t) !== "super8";
}

/* Configuración elegible del tipo de torneo: { type, super8Mode, games } */
function tournamentConfig(t) {
  const type = tournamentType(t);
  return { type, super8Mode: type === "super8" ? t.super8Mode : null, games: isSingleSetFormat(t.matchFormat) ? t.matchFormat.gamesPerSet : null };
}

function tournamentConfigIsComplete(config) {
  if (config.type === "super8") return !!config.super8Mode && SUPER8_GAMES_OPTIONS.includes(config.games);
  if (config.type === "americano") return AMERICANO_GAMES_OPTIONS.includes(config.games);
  return config.type === "clasico";
}

/* Formato de las categorías de un torneo según su tipo (ver CATEGORY_FORMAT_LABEL) */
function categoryFormatForConfig(config) {
  return config.type === "super8" ? `super8_${config.super8Mode}` : "zonas";
}

function newCategory(name, categoryFormat) {
  return { id: uid(), name, pairs: [], groups: [], bracket: null, ...(categoryFormat !== "zonas" ? { format: categoryFormat, teams: [] } : {}) };
}

/* Aplica una configuración de tipo a un torneo. Si cambia el formato de las categorías (pasar a o
   desde Súper 8, o de Individual a Por Parejas), las categorías se adaptan; eso solo se permite
   mientras ninguna tenga partidos armados (ver tournamentConfigChangeBlocked). */
function withTournamentConfig(t, config) {
  const matchFormat = config.type === "clasico"
    ? (isSingleSetFormat(t.matchFormat) ? { ...DEFAULT_MATCH_FORMAT } : t.matchFormat || { ...DEFAULT_MATCH_FORMAT })
    : singleSetMatchFormat(config.type, config.games);
  const prev = tournamentConfig(t);
  const categoriesChange = prev.type !== config.type || prev.super8Mode !== config.super8Mode;
  const categoryFormat = categoryFormatForConfig(config);
  const categories = !categoriesChange ? t.categories : t.categories.map((c) => {
    if ((c.format || "zonas") === categoryFormat) return c;
    const { format, teams, ...rest } = c;
    return categoryFormat === "zonas" ? rest : { ...rest, format: categoryFormat, teams: [] };
  });
  // Solo el Clásico suma para un circuito
  const circuitId = config.type === "clasico" ? t.circuitId || null : null;
  return { ...t, type: config.type, super8Mode: config.type === "super8" ? config.super8Mode : null, matchFormat, categories, circuitId };
}

/* Cambiar el formato de una categoría con partidos ya armados rompería esos partidos */
function tournamentConfigChangeBlocked(t, config) {
  const categoryFormat = categoryFormatForConfig(config);
  return t.categories.some((c) => (c.format || "zonas") !== categoryFormat && (c.groups.length > 0 || c.bracket));
}

/* Un set único a N games está completo y bien cargado si el ganador llegó a N y el otro quedó
   en N-1 o menos (N a N-1 solo se da ganando el tie break en N-1 iguales). */
function singleSetIsValid(a, b, games) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi === games && lo <= games - 1;
}
const WEEKDAY_LABEL = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function formatDateShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${WEEKDAY_LABEL[d.getDay()]} ${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })}`;
}

function seedTournaments(organizerId) {
  const playDates = [
    { date: "2026-10-01", from: "18:00", to: "23:00" },
    { date: "2026-10-02", from: "18:00", to: "23:00" },
    { date: "2026-10-03", from: "09:00", to: "20:00" },
    { date: "2026-10-04", from: "09:00", to: "20:00" },
  ];
  const avail = playDates.slice(2).map((d) => ({ date: d.date, from: "09:00", to: "20:00" })); // sáb y dom por defecto
  return [
    {
      id: uid(),
      name: "Copa Apertura Smash Point",
      date: "2026-09-20",
      status: STATUS.EN_CURSO,
      organizerId,
      matchFormat: { ...DEFAULT_MATCH_FORMAT },
      courtsCount: 6,
      matchDurationMinutes: 90,
      playDates,
      categories: [
        {
          id: uid(),
          name: "4ta Caballeros",
          pairs: [
            { id: uid(), name: "Gómez / Ibáñez", availability: avail },
            { id: uid(), name: "Rossi / Peralta", availability: avail },
            { id: uid(), name: "Funes / Aquino", availability: avail },
            { id: uid(), name: "Vidal / Lucero", availability: avail },
          ],
          groups: [],
          bracket: null,
        },
      ],
    },
  ];
}

/* Round robin: todos contra todos dentro de un grupo */
function buildRoundRobin(pairIds) {
  const matches = [];
  for (let i = 0; i < pairIds.length; i++) {
    for (let j = i + 1; j < pairIds.length; j++) {
      matches.push({ id: uid(), pairA: pairIds[i], pairB: pairIds[j], sets: [] });
    }
  }
  return matches;
}

/* Arma los partidos de un grupo. Con 3 parejas (o cualquier tamaño distinto de 4) es todos contra
   todos. Con 4 parejas, se sortean los rivales (A vs B, C vs D) y recién cuando esos dos resultados
   están cargados se arman solos los cruces de ganadores y de perdedores. */
/* Mueve una pareja de un grupo de zona a otro (edición manual post-sorteo) y reconstruye los
   partidos de ambos grupos afectados desde cero (se pierden los resultados ya cargados en esos
   dos grupos, por eso esto solo debe ofrecerse mientras ningún partido de esos grupos esté jugado). */
function moveGroupPair(groups, pairId, fromGroupId, toGroupId) {
  return groups.map((g) => {
    if (g.id === fromGroupId) {
      const pairIds = g.pairIds.filter((id) => id !== pairId);
      const built = buildGroupMatches(pairIds);
      return { ...g, pairIds, format: built.format, matches: built.matches };
    }
    if (g.id === toGroupId) {
      const pairIds = [...g.pairIds, pairId];
      const built = buildGroupMatches(pairIds);
      return { ...g, pairIds, format: built.format, matches: built.matches };
    }
    return g;
  });
}

function buildGroupMatches(pairIds) {
  if (pairIds.length === 4) {
    const shuffled = [...pairIds].sort(() => Math.random() - 0.5);
    return {
      format: "bracket4",
      matches: [
        { id: uid(), pairA: shuffled[0], pairB: shuffled[1], sets: [], stage: "r1" },
        { id: uid(), pairA: shuffled[2], pairB: shuffled[3], sets: [], stage: "r1" },
        { id: uid(), pairA: null, pairB: null, sets: [], stage: "ganadores" },
        { id: uid(), pairA: null, pairB: null, sets: [], stage: "perdedores" },
      ],
    };
  }
  return { format: "roundrobin", matches: buildRoundRobin(pairIds) };
}

/* ---------- Formato Súper 8 ---------- */

/* Una categoría puede jugarse con el sistema clásico (zonas + llave) o en alguna de las dos
   variantes del Súper 8: un cuadro fijo de partidos sin eliminación que termina en tabla de posiciones.
   - Individual: 8 jugadores sueltos; las parejas rotan para que cada uno juegue una vez con cada
     otro como compañero y dos veces contra cada otro como rival (14 partidos, 7 rondas de 2).
   - Parejas Fijas: 8 parejas armadas, todos contra todos (28 partidos, 7 rondas de 4). */
const CATEGORY_FORMAT_LABEL = {
  zonas: "Zonas + llave",
  super8_individual: "Súper 8 Individual",
  super8_parejas: "Súper 8 por Parejas Fijas",
};
const SUPER8_SIZE = 8;

function isSuper8(category) {
  return category?.format === "super8_individual" || category?.format === "super8_parejas";
}

/* Round robin por el método del círculo: el primero queda fijo y el resto rota un lugar por ronda.
   Devuelve las rondas como listas de cruces [a, b]. Con 8 parejas da 7 rondas de 4 partidos. */
function buildCircleRounds(ids) {
  const n = ids.length;
  let arr = [...ids];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) round.push([arr[i], arr[n - 1 - i]]);
    rounds.push(round);
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return rounds;
}

/* Rondas del Súper 8 Individual para n jugadores (n múltiplo de 4). Cada ronda es una lista de
   partidos [[a1, a2], [b1, b2]] donde juegan todos, y en el total cada jugador es compañero de
   cada otro exactamente una vez y rival exactamente dos veces.
   Construcción cíclica: el jugador 0 queda fijo y los demás se numeran módulo n-1. Se busca una
   ronda base que, sumando 1 a cada número ronda tras ronda, cumpla las dos condiciones. La búsqueda
   recorre siempre el mismo orden, así que para la misma cantidad de jugadores sale siempre la misma
   tabla (con 8 jugadores tarda unos milisegundos). */
function buildSuper8IndividualRounds(ids) {
  const n = ids.length;
  if (n < 4 || n % 4 !== 0) return null;
  const m = n - 1;
  const shift = (x, r) => (x === 0 ? 0 : ((x - 1 + r) % m) + 1);
  const key = (a, b) => (a < b ? a * n + b : b * n + a);
  const develop = (base) => Array.from({ length: m }, (_, r) => base.map(([t1, t2]) => [t1.map((x) => shift(x, r)), t2.map((x) => shift(x, r))]));
  const isValid = (rounds) => {
    const partners = new Set();
    const opponents = new Map();
    for (const round of rounds) {
      for (const [t1, t2] of round) {
        for (const t of [t1, t2]) {
          const k = key(t[0], t[1]);
          if (partners.has(k)) return false;
          partners.add(k);
        }
        for (const x of t1) for (const y of t2) {
          const k = key(x, y), count = (opponents.get(k) || 0) + 1;
          if (count > 2) return false;
          opponents.set(k, count);
        }
      }
    }
    return true;
  };
  // Arma la ronda base de a 4 jugadores (el primero libre + otros 3), probando los 3 repartos de compañeros
  const search = (free, base) => {
    if (free.length === 0) {
      const rounds = develop(base);
      return isValid(rounds) ? rounds : null;
    }
    const [a, ...rest] = free;
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = j + 1; k < rest.length; k++) {
      const quad = [a, rest[i], rest[j], rest[k]];
      const others = rest.filter((_, x) => x !== i && x !== j && x !== k);
      for (const p of [1, 2, 3]) {
        const t1 = [quad[0], quad[p]];
        const t2 = quad.filter((_, x) => x !== 0 && x !== p);
        base.push([t1, t2]);
        const found = search(others, base);
        if (found) return found;
        base.pop();
      }
    }
    return null;
  };
  const rounds = search(Array.from({ length: n }, (_, i) => i), []);
  return rounds && rounds.map((round) => round.map(([t1, t2]) => [t1.map((x) => ids[x]), t2.map((x) => ids[x])]));
}

/* Arma la zona única del Súper 8 con los jugadores/parejas ya numerados (orderedIds[0] = el 1, etc.).
   En el Individual, cada lado de un partido es un "equipo" de 2 jugadores que se guarda en
   category.teams; los partidos apuntan a esos equipos en pairA/pairB, así el resto de la app
   (resultados, WO, horarios) los trata igual que a una pareja. */
function buildSuper8Group(format, orderedIds) {
  const teams = [];
  let matches;
  if (format === "super8_individual") {
    const rounds = buildSuper8IndividualRounds(orderedIds);
    if (!rounds) return null;
    const teamFor = (playerIds) => {
      const team = { id: uid(), playerIds };
      teams.push(team);
      return team.id;
    };
    matches = rounds.flatMap((round, ri) => round.map(([t1, t2]) => ({ id: uid(), pairA: teamFor(t1), pairB: teamFor(t2), sets: [], round: ri + 1 })));
  } else {
    matches = buildCircleRounds(orderedIds).flatMap((round, ri) => round.map(([a, b]) => ({ id: uid(), pairA: a, pairB: b, sets: [], round: ri + 1 })));
  }
  return { group: { id: uid(), name: "Súper 8", pairIds: orderedIds, format: "super8", matches }, teams };
}

/* Parejas/jugadores de la categoría por id, sumando los equipos del Súper 8 Individual (cuyo nombre
   se arma con el de sus dos jugadores, para que un cambio de nombre se refleje solo). */
function categoryEntitiesById(category) {
  const map = Object.fromEntries(category.pairs.map((p) => [p.id, p]));
  (category.teams || []).forEach((t) => {
    map[t.id] = { id: t.id, name: t.playerIds.map((pid) => map[pid]?.name || "—").join(" - ") };
  });
  return map;
}

/* Quiénes juegan de verdad en un lado de un partido: los dos jugadores si es un equipo del Súper 8
   Individual, o la pareja misma en cualquier otro caso. */
function sideParticipantIds(category, sideId) {
  const team = (category?.teams || []).find((t) => t.id === sideId);
  return team ? team.playerIds : [sideId];
}

/* Para la tabla de posiciones del Súper 8 Individual: cada partido de equipos se parte en dos
   "partidos" jugador contra jugador con el mismo resultado, así computeStandings le suma a cada
   jugador lo que hizo su equipo (sin contarlo doble). */
function super8IndividualStandingsGroup(category, group) {
  const teamsById = Object.fromEntries((category.teams || []).map((t) => [t.id, t]));
  const matches = group.matches.flatMap((m) => {
    const tA = teamsById[m.pairA], tB = teamsById[m.pairB];
    if (!tA || !tB) return [];
    return [0, 1].map((i) => ({
      ...m,
      pairA: tA.playerIds[i],
      pairB: tB.playerIds[i],
      walkover: m.walkover ? (m.walkover === m.pairA ? tA.playerIds[i] : tB.playerIds[i]) : null,
    }));
  });
  return { ...group, matches };
}

/* Cuenta sets ganados por cada lado a partir de los games/puntos cargados set por set */
function setsWon(match) {
  let a = 0, b = 0;
  (match.sets || []).forEach((s) => {
    if (!s || s.a == null || s.b == null) return;
    if (s.a > s.b) a++; else if (s.b > s.a) b++;
  });
  return { a, b };
}

function matchIsPlayed(match) {
  if (match && match.walkover) return true;
  const { a, b } = setsWon(match);
  return a + b > 0;
}

/* Avance del torneo: cuántos partidos ya se jugaron sobre el total (grupos + llave con ambas parejas definidas) */
function tournamentProgress(t) {
  let total = 0, played = 0;
  (t.categories || []).forEach((c) => {
    (c.groups || []).forEach((g) => g.matches.forEach((m) => { total++; if (matchIsPlayed(m)) played++; }));
    (c.bracket || []).forEach((round) => round.forEach((m) => {
      if (m.pairA && m.pairB) { total++; if (matchIsPlayed(m)) played++; }
    }));
  });
  return { total, played, pct: total > 0 ? Math.round((played / total) * 100) : 0 };
}

function matchWinnerId(match) {
  if (match && match.walkover) return match.walkover === match.pairA ? match.pairB : match.pairA;
  const { a, b } = setsWon(match);
  if (a === b) return null;
  return a > b ? match.pairA : match.pairB;
}

/* Estado visual de un partido para la tabla de horarios: "finalizado" se calcula solo al cargar
   resultado o walkover; "en_curso" lo marca el organizador a mano mientras no haya resultado. */
function matchDisplayStatus(m) {
  if (matchIsPlayed(m)) return "finalizado";
  if (m && m.liveStatus === "en_curso") return "en_curso";
  return "pendiente";
}

/* Chequea si una pareja (o jugador del Súper 8 Individual) ya jugó algún partido (de grupos o de la llave) dentro de la categoría */
function pairHasPlayed(category, pairId) {
  const plays = (m) => [m.pairA, m.pairB].some((side) => sideParticipantIds(category, side).includes(pairId));
  const inGroups = (category.groups || []).some((g) => g.matches.some((m) => plays(m) && matchIsPlayed(m)));
  const inBracket = (category.bracket || []).some((round) => round.some((m) => (m.pairA === pairId || m.pairB === pairId) && matchIsPlayed(m)));
  return inGroups || inBracket;
}

/* Agrega/actualiza el resultado de un set puntual dentro del array de sets de un partido */
function withSetScore(sets, setIndex, side, value) {
  const next = [...(sets || [])];
  while (next.length <= setIndex) next.push({ a: null, b: null });
  next[setIndex] = { ...next[setIndex], [side]: value };
  return next;
}

function computeStandings(group, pairsById, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const stbIndex = f.finalSuperTiebreak ? f.setsToPlay - 1 : -1; // índice del set que es el super tie-break (si aplica)

  const table = {};
  group.pairIds.forEach((pid) => {
    table[pid] = { pairId: pid, pj: 0, pg: 0, pp: 0, setsF: 0, setsC: 0, gamesF: 0, gamesC: 0, stb: 0, pts: 0 };
  });
  group.matches.forEach((m) => {
    if (!matchIsPlayed(m)) return;
    const a = table[m.pairA];
    const b = table[m.pairB];
    if (!a || !b) return;
    const { a: sa, b: sb } = setsWon(m);
    a.pj++; b.pj++;
    a.setsF += sa; a.setsC += sb;
    b.setsF += sb; b.setsC += sa;
    (m.sets || []).forEach((s, i) => {
      if (!s || s.a == null || s.b == null) return;
      if (i === stbIndex) {
        // Es el super tie-break: son puntos, no games — solo cuenta quién lo ganó
        if (s.a > s.b) a.stb++; else if (s.b > s.a) b.stb++;
      } else {
        a.gamesF += s.a; a.gamesC += s.b;
        b.gamesF += s.b; b.gamesC += s.a;
      }
    });
    // Un WO cuenta como partido ganado para el rival de quien no se presentó (sin sets ni games)
    const woWinner = m.walkover ? (m.walkover === m.pairA ? b : a) : null;
    if (woWinner) { const woLoser = woWinner === a ? b : a; woWinner.pg++; woWinner.pts += 2; woLoser.pp++; }
    else if (sa > sb) { a.pg++; a.pts += 2; b.pp++; }
    else if (sb > sa) { b.pg++; b.pts += 2; a.pp++; }
  });
  const rows = Object.values(table);

  if (group.format === "bracket4" && group.matches.length === 4) {
    // El orden sale directo del cruce de ganadores/perdedores, no de la tabla de puntos:
    // 1° = ganó el cruce de ganadores, 2° = lo perdió, 3° = ganó el de perdedores, 4° = lo perdió.
    const [, , mw, ml] = group.matches;
    const order = [winnerOf(mw), loserOf(mw), winnerOf(ml), loserOf(ml)];
    return rows.sort((x, y) => {
      const rx = order.indexOf(x.pairId), ry = order.indexOf(y.pairId);
      const px = rx === -1 ? 99 : rx, py = ry === -1 ? 99 : ry;
      if (px !== py) return px - py;
      // Todavía sin definir (partidos no jugados): dejamos la tabla de puntos como orden provisorio
      if (y.pts !== x.pts) return y.pts - x.pts;
      const setsDiff = (y.setsF - y.setsC) - (x.setsF - x.setsC);
      if (setsDiff !== 0) return setsDiff;
      return (y.gamesF - y.gamesC) - (x.gamesF - x.gamesC);
    });
  }

  return rows.sort((x, y) => {
    if (y.pts !== x.pts) return y.pts - x.pts;
    const setsDiff = (y.setsF - y.setsC) - (x.setsF - x.setsC);
    if (setsDiff !== 0) return setsDiff;
    // Desempate final: diferencia de games ganados (típico en grupos de 3 donde todos ganan 1 partido)
    return (y.gamesF - y.gamesC) - (x.gamesF - x.gamesC);
  });
}

/* Cuántas parejas pasan de un grupo a la llave final: lo elige el organizador en cada grupo por
   separado (g.qualifiersCount, por defecto 2), nunca más que las parejas que tiene el grupo. */
function groupQualifiersCount(group) {
  return Math.min(group.qualifiersCount || 2, group.pairIds.length);
}

/* Arma la primera ronda de la llave final a partir de los clasificados de todos los grupos, sea
   cual sea la cantidad que pase de cada uno (el Grupo A puede clasificar 2, el B 3 y el C 1).
   Recibe una entrada por clasificado { groupIndex, place, ... } y una función que ordena a los
   del mismo puesto entre sí (mejor primero). Devuelve la lista de partidos de ronda 1 como pares
   [entrada, entrada | null] (null = pasa directo, bye), ya en el orden de la llave.

   - Orden general: primero todos los 1°, después todos los 2°, los 3°, etc.; dentro de cada puesto
     decide la función de orden (el mérito en la tabla, o el orden de los grupos si todavía no se
     jugó nada).
   - Si la cantidad no es potencia de dos, los mejor ubicados pasan directo a la ronda siguiente
     (bye), como es habitual en pádel.
   - El resto se cruza el mejor con el peor que quede, siempre de un grupo distinto cuando se puede:
     así un 1° nunca se enfrenta en primera ronda con el 2° de su propio grupo.
   - Los cruces se ubican en la llave por siembra, para que los dos mejores clasificados recién
     puedan cruzarse en la final. */
function seedKnockoutRound1(entries, compareSamePlace) {
  const ranked = [...entries].sort((a, b) => a.place - b.place || compareSamePlace(a, b));
  let size = 1;
  while (size < ranked.length) size *= 2;
  const byeCount = size - ranked.length;

  const units = ranked.slice(0, byeCount).map((e) => [e, null]);
  const pool = ranked.slice(byeCount);
  while (pool.length > 0) {
    const top = pool.shift();
    if (pool.length === 0) { units.push([top, null]); break; }
    let idx = pool.length - 1;
    while (idx > 0 && pool[idx].groupIndex === top.groupIndex) idx--;
    if (pool[idx].groupIndex === top.groupIndex) idx = pool.length - 1; // todos del mismo grupo: no queda otra
    units.push([top, pool.splice(idx, 1)[0]]);
  }

  // Posiciones de siembra: con 4 cruces queda [1, 4, 2, 3], así el 1 y el 2 van a mitades opuestas
  let order = [1];
  while (order.length < units.length) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  const placed = order.map((s) => units[s - 1]);

  // Segunda ronda: si un cruce puede terminar en dos parejas de la misma zona (por ejemplo el 1° A
  // con bye contra el ganador de 2° A vs 2° B), se intercambia el de abajo con otro lugar de la
  // llave que no genere el mismo problema, probando primero los de peor siembra.
  const groupsOf = (unit) => unit.filter(Boolean).map((e) => e.groupIndex);
  const clash = (u, v) => groupsOf(u).some((g) => groupsOf(v).includes(g));
  for (let i = 0; i + 1 < placed.length; i += 2) {
    if (!clash(placed[i], placed[i + 1])) continue;
    for (let j = placed.length - 1; j > i + 1; j--) {
      const partner = j % 2 === 0 ? j + 1 : j - 1;
      if (clash(placed[i], placed[j]) || clash(placed[i + 1], placed[partner])) continue;
      [placed[i + 1], placed[j]] = [placed[j], placed[i + 1]];
      break;
    }
  }
  return placed;
}

/* Arma el orden de clasificados para la llave final a partir de las tablas de los grupos,
   tomando de cada grupo la cantidad de clasificados que eligió el organizador. Entre parejas del
   mismo puesto de distintos grupos manda el mérito: puntos, diferencia de sets y diferencia de games. */
function buildKnockoutSeeding(groups, pairsById, format) {
  const entries = groups.flatMap((g, gi) => {
    const table = computeStandings(g, pairsById, format);
    return table.slice(0, groupQualifiersCount(g)).map((row, i) => ({ groupIndex: gi, place: i + 1, row }));
  });
  const meritKey = (e) => [e.row.pts, e.row.setsF - e.row.setsC, e.row.gamesF - e.row.gamesC];
  const compareMerit = (a, b) => {
    const ka = meritKey(a), kb = meritKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return a.groupIndex - b.groupIndex;
  };
  return seedKnockoutRound1(entries, compareMerit).map(([a, b]) => [a.row.pairId, b ? b.row.pairId : null]);
}

/* Llave eliminación directa a partir de una lista ordenada de pairIds (o null = BYE) */
function buildBracket(pairIds) {
  let size = 1;
  while (size < pairIds.length) size *= 2;
  const slots = [...pairIds];
  while (slots.length < size) slots.push(null);

  const round1 = [];
  for (let i = 0; i < slots.length; i += 2) {
    round1.push({ id: uid(), pairA: slots[i], pairB: slots[i + 1], sets: [] });
  }
  const rounds = [round1];
  let count = round1.length;
  while (count > 1) {
    count = count / 2;
    rounds.push(Array.from({ length: count }, () => ({ id: uid(), pairA: null, pairB: null, sets: [] })));
  }
  return propagateBracket(rounds);
}

/* Arma un esqueleto de llave SIN saber todavía qué pareja concreta clasifica a cada lugar:
   solo usa los grupos y cuántos clasificados definió el organizador en cada uno. Cada partido de
   ronda 1 lleva un label textual tipo "1° Grupo A vs 2° Grupo B" (guardado en
   placeholderA/placeholderB) en vez de pairA/pairB reales. Usa la misma siembra que la llave real
   (seedKnockoutRound1), así los casilleros coinciden cuando después se completa con las parejas;
   como todavía no hay tabla, entre los del mismo puesto ordena por grupo. Quiénes pasan directo
   (bye) puede cambiar en la llave real, porque ahí manda el mérito. */
function buildPlaceholderBracket(groups) {
  if (!groups || groups.length === 0) return null;
  const entries = groups.flatMap((g, gi) =>
    Array.from({ length: groupQualifiersCount(g) }, (_, i) => ({ groupIndex: gi, place: i + 1, label: `${i + 1}° ${g.name}` })));
  if (entries.length < 2) return null;

  const round1 = seedKnockoutRound1(entries, (a, b) => a.groupIndex - b.groupIndex).map(([a, b]) => (
    { id: uid(), pairA: null, pairB: null, placeholderA: a.label, placeholderB: b ? b.label : null, sets: [] }
  ));
  const rounds = [round1];
  let count = round1.length;
  while (count > 1) {
    count = count / 2;
    rounds.push(Array.from({ length: count }, () => ({ id: uid(), pairA: null, pairB: null, sets: [] })));
  }
  return rounds;
}

/* Como buildBracket, pero a partir de los cruces de ronda 1 que arma buildKnockoutSeeding (las
   parejas con bye van contra un lugar vacío y pasan solas a la ronda siguiente). */
function buildSeededBracket(round1Pairs) {
  return buildBracket(round1Pairs.flat());
}

function winnerOf(m) {
  if (m.pairA && !m.pairB) return m.pairA;
  if (m.pairB && !m.pairA) return m.pairB;
  return matchWinnerId(m);
}

function loserOf(m) {
  if (!matchIsPlayed(m) || !m.pairA || !m.pairB) return null;
  const w = matchWinnerId(m);
  if (!w) return null;
  return w === m.pairA ? m.pairB : m.pairA;
}

/* En un grupo de 4 parejas, arma solos los cruces de ganadores y de perdedores apenas se cargan
   los dos primeros resultados (partido 1 y partido 2 del sorteo inicial) */
function propagateGroupBracket4(matches) {
  const next = matches.map((m) => ({ ...m }));
  const [m1, m2] = next;
  next[2] = { ...next[2], pairA: winnerOf(m1), pairB: winnerOf(m2) };
  next[3] = { ...next[3], pairA: loserOf(m1), pairB: loserOf(m2) };
  return next;
}

/* Nombre real de cada instancia de la llave (Final, Semifinal, Cuartos, Octavos...) según cuántas
   rondas tenga en total esa llave, contando desde el final hacia atrás */
const ROUND_STAGE_NAMES = ["Final", "Semifinal", "Cuartos de Final", "Octavos de Final", "16avos de Final", "32avos de Final"];
function roundStageLabel(totalRounds, roundIndex) {
  const fromEnd = totalRounds - 1 - roundIndex;
  return ROUND_STAGE_NAMES[fromEnd] || `Ronda ${roundIndex + 1}`;
}

/* Intercambia de lugar a dos parejas dentro de la ronda 1 de la llave ya generada (para forzar
   manualmente un cruce distinto al automático). Solo tiene sentido antes de que esos partidos
   se hayan jugado; si alguno de los dos ya tiene resultado cargado, no se debería ofrecer esta
   opción en la interfaz. */
function swapBracketPairs(bracket, pairIdA, pairIdB) {
  const rounds = bracket.map((r) => r.map((m) => ({ ...m })));
  rounds[0].forEach((m) => {
    if (m.pairA === pairIdA) m.pairA = pairIdB;
    else if (m.pairA === pairIdB) m.pairA = pairIdA;
    if (m.pairB === pairIdA) m.pairB = pairIdB;
    else if (m.pairB === pairIdB) m.pairB = pairIdA;
  });
  return propagateBracket(rounds);
}

function propagateBracket(rounds) {
  const next = rounds.map((r) => r.map((m) => ({ ...m })));
  for (let r = 0; r < next.length - 1; r++) {
    for (let i = 0; i < next[r].length; i++) {
      const w = winnerOf(next[r][i]);
      const targetMatch = next[r + 1][Math.floor(i / 2)];
      const slot = i % 2 === 0 ? "pairA" : "pairB";
      targetMatch[slot] = w;
    }
  }
  return next;
}

function formatSummary(format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  if (isSingleSetFormat(f)) {
    const tie = f.gamesPerSet - 1;
    const set = f.type === "americano" ? `set único a ${f.gamesPerSet} games, sin ventaja` : `un solo set a ${f.gamesPerSet} games`;
    return `${set} · en ${tie}-${tie} tie break a 7 puntos (diferencia de 2)`;
  }
  const parts = [
    f.setsToPlay === 2 ? "2 sets directos" : "Al mejor de 3 sets",
    `${f.gamesPerSet} games por set`,
  ];
  if (f.setTiebreak) parts.push(`tie break a 7 en ${f.gamesPerSet}-${f.gamesPerSet}`);
  parts.push(f.finalSuperTiebreak ? "super tie-break a 10 en el set decisivo" : "sin super tie-break (se juega el set completo)");
  return parts.join(" · ");
}

/* ---------- Horarios y canchas ---------- */

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/* Junta todos los partidos con ambas parejas ya definidas (de grupos y de la llave) de todas las categorías */
function collectScheduleableMatches(tournament) {
  const list = [];
  (tournament.categories || []).forEach((c) => {
    (c.groups || []).forEach((g) => {
      g.matches.forEach((m) => {
        const isPending4 = g.format === "bracket4" && (m.stage === "ganadores" || m.stage === "perdedores") && !(m.pairA && m.pairB);
        if ((m.pairA && m.pairB) || isPending4) {
          list.push({
            key: `${c.id}:g:${g.id}:${m.id}`, categoryId: c.id, categoryName: c.name,
            location: { type: "group", groupId: g.id }, matchId: m.id, label: m.round ? `${g.name} · Ronda ${m.round}` : g.name,
            pairA: m.pairA, pairB: m.pairB, schedule: m.schedule || null, sets: m.sets || [],
            walkover: m.walkover || null, liveStatus: m.liveStatus || null,
            stage: m.stage || null, groupFormat: g.format || "roundrobin",
            placeholder: isPending4 ? (m.stage === "ganadores" ? "Ganador Partido 1 vs Ganador Partido 2" : "Perdedor Partido 1 vs Perdedor Partido 2") : null,
          });
        }
      });
    });
    (c.bracket || []).forEach((round, ri) => {
      round.forEach((m, mi) => {
        // En un esqueleto precargado, no solo la ronda 1 tiene placeholders de texto propios:
        // TODAS las rondas siguientes (semis, final...) también deben poder programarse de
        // antemano, aunque todavía no tengan ni pairA/pairB ni placeholderA/placeholderB propios
        // (esos se completan recién cuando se resuelve la ronda anterior).
        const isSkeletonSlot = c.bracketIsSkeleton && !(m.pairA && m.pairB);
        let placeholderText = null;
        if (isSkeletonSlot) {
          if (m.placeholderA || m.placeholderB) {
            placeholderText = `${m.placeholderA || "?"} vs ${m.placeholderB || "?"}`;
          } else {
            const prevLabel = roundStageLabel(c.bracket.length, ri - 1);
            placeholderText = `Ganador ${prevLabel} ${mi * 2 + 1} vs Ganador ${prevLabel} ${mi * 2 + 2}`;
          }
        }
        if ((m.pairA && m.pairB) || isSkeletonSlot) {
          list.push({
            key: `${c.id}:b:${ri}:${m.id}`, categoryId: c.id, categoryName: c.name,
            location: { type: "bracket", roundIndex: ri }, matchId: m.id, label: roundStageLabel(c.bracket.length, ri),
            pairA: m.pairA, pairB: m.pairB, schedule: m.schedule || null, sets: m.sets || [],
            walkover: m.walkover || null, liveStatus: m.liveStatus || null, draft: !c.bracketPublished,
            placeholder: placeholderText,
          });
        }
      });
    });
  });
  return list;
}

/* Marca como públicos (visibles para jugadores) los horarios de la llave de una categoría puntual,
   que hasta ahora estaban precargados en modo borrador (ver autoScheduleBracket) */
function publishBracketSchedule(tournament, categoryId) {
  return {
    ...tournament,
    categories: tournament.categories.map((c) => (c.id === categoryId ? { ...c, bracketPublished: true } : c)),
  };
}

/* Actualiza el horario de un partido puntual dentro de la estructura anidada del torneo */
function withMatchSchedule(tournament, categoryId, location, matchId, schedule) {
  return {
    ...tournament,
    categories: tournament.categories.map((c) => {
      if (c.id !== categoryId) return c;
      if (location.type === "group") {
        return {
          ...c,
          groups: c.groups.map((g) => (g.id !== location.groupId ? g : {
            ...g, matches: g.matches.map((m) => (m.id === matchId ? { ...m, schedule } : m)),
          })),
        };
      }
      return {
        ...c,
        bracket: c.bracket.map((round, ri) => (ri !== location.roundIndex ? round : round.map((m) => (m.id === matchId ? { ...m, schedule } : m)))),
      };
    }),
  };
}

/* Cambia el resultado (sets o WO) de un partido puntual y propaga lo que dependa de él: los cruces
   de ganadores/perdedores en un grupo de 4, o las rondas siguientes de la llave. */
function withMatchResult(tournament, categoryId, location, matchId, change) {
  return {
    ...tournament,
    categories: tournament.categories.map((c) => {
      if (c.id !== categoryId) return c;
      if (location.type === "group") {
        return {
          ...c,
          groups: c.groups.map((g) => {
            if (g.id !== location.groupId) return g;
            const matches = g.matches.map((m) => (m.id === matchId ? change(m) : m));
            return { ...g, matches: g.format === "bracket4" ? propagateGroupBracket4(matches) : matches };
          }),
        };
      }
      const rounds = c.bracket.map((round, ri) => (ri !== location.roundIndex ? round : round.map((m) => (m.id === matchId ? change(m) : m))));
      return { ...c, bracket: propagateBracket(rounds) };
    }),
  };
}

/* Rearma la grilla desde cero: saca el horario a todos los partidos que todavía no se jugaron ni
   están en curso, y los vuelve a ubicar con las canchas, el horario y la duración actuales (primero
   los de grupos y después las llaves). Sirve cuando cambia el horario de arranque, la cantidad de
   canchas o el tiempo entre partidos con los horarios ya generados. */
function rescheduleTournament(tournament) {
  const keep = (m) => matchIsPlayed(m) || m.liveStatus === "en_curso";
  const clear = (m) => (m.schedule && !keep(m) ? { ...m, schedule: null } : m);
  let next = {
    ...tournament,
    categories: tournament.categories.map((c) => ({
      ...c,
      groups: (c.groups || []).map((g) => ({ ...g, matches: g.matches.map(clear) })),
      bracket: c.bracket ? c.bracket.map((round) => round.map(clear)) : c.bracket,
    })),
  };
  next = autoSchedule(next);
  next.categories.forEach((c) => {
    if (!c.bracket) return;
    const scheduled = autoScheduleBracket(next, c);
    next = { ...next, categories: next.categories.map((x) => (x.id === c.id ? scheduled : x)) };
  });
  return next;
}

/* Marca/quita el estado "en curso" a mano en un partido puntual (se usa mientras no tenga resultado cargado) */
function withMatchLiveStatus(tournament, categoryId, location, matchId, liveStatus) {
  return {
    ...tournament,
    categories: tournament.categories.map((c) => {
      if (c.id !== categoryId) return c;
      if (location.type === "group") {
        return {
          ...c,
          groups: c.groups.map((g) => (g.id !== location.groupId ? g : {
            ...g, matches: g.matches.map((m) => (m.id === matchId ? { ...m, liveStatus } : m)),
          })),
        };
      }
      return {
        ...c,
        bracket: c.bracket.map((round, ri) => (ri !== location.roundIndex ? round : round.map((m) => (m.id === matchId ? { ...m, liveStatus } : m)))),
      };
    }),
  };
}

/* Todos los horarios ya reservados en el torneo (de cualquier categoría, sean partidos de grupos
   o de la llave, tengan o no las dos parejas definidas todavía) */
function collectAllSchedules(tournament) {
  const list = [];
  (tournament.categories || []).forEach((c) => {
    (c.groups || []).forEach((g) => g.matches.forEach((m) => { if (m.schedule) list.push(m.schedule); }));
    (c.bracket || []).forEach((round) => round.forEach((m) => { if (m.schedule) list.push(m.schedule); }));
  });
  return list;
}

/* Todos los horarios de la llave ya reservados en el torneo, agrupados por ronda (índice 0 = Ronda 1,
   1 = Ronda 2, etc.), de CUALQUIER categoría. Sirve para saber hasta qué hora llega cada ronda en
   general, sin importar en qué categoría se jugó ese partido puntual. */
function collectBracketScheduleTiers(tournament) {
  const tiers = {};
  (tournament.categories || []).forEach((c) => {
    (c.bracket || []).forEach((round, ri) => {
      round.forEach((m) => { if (m.schedule) (tiers[ri] = tiers[ri] || []).push(m.schedule); });
    });
  });
  return tiers;
}

function scheduleEndPoint(schedule, duration) {
  return { date: schedule.date, minutes: timeToMinutes(schedule.time) + duration };
}

function laterPoint(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.date !== b.date) return a.date > b.date ? a : b;
  return a.minutes > b.minutes ? a : b;
}

/* Reserva de antemano cancha y horario para TODOS los partidos de una llave recién generada
   (aunque todavía no se sepa qué pareja llega a semifinales o a la final), sin pisar ningún
   horario ya ocupado por otra categoría del mismo torneo. Las llaves se juegan "por ronda": primero
   la Ronda 1 de TODAS las categorías, después la Ronda 2 de todas, y así — por eso el piso de cada
   ronda se calcula mirando lo que ya se jugó en rondas anteriores de cualquier categoría, no solo la propia. */
function autoScheduleBracket(tournament, category) {
  const duration = tournament.matchDurationMinutes || 90;
  const courts = tournament.courtsCount || 4;
  const dates = tournament.playDates || [];
  if (!tournamentUsesSchedule(tournament) || dates.length === 0 || !category.bracket) return category;

  // Cada fecha del torneo ya trae su propio rango horario
  const slots = [];
  dates.forEach(({ date, from, to }) => {
    const start = timeToMinutes(from), end = timeToMinutes(to);
    for (let t = start; t + duration <= end; t += duration) slots.push({ date, minutes: t });
  });

  const courtBusy = new Set();
  collectAllSchedules(tournament).forEach((s) => courtBusy.add(`${s.date}|${s.time}|${s.court}`));

  // Final más tardío conocido de cada ronda (tier), agregando lo que ya jugaron todas las categorías
  const tierEnd = {};
  Object.entries(collectBracketScheduleTiers(tournament)).forEach(([ri, schedules]) => {
    schedules.forEach((s) => { tierEnd[ri] = laterPoint(tierEnd[ri], scheduleEndPoint(s, duration)); });
  });

  const rounds = category.bracket.map((round) => round.map((m) => ({ ...m })));

  rounds.forEach((round, ri) => {
    // El piso de esta ronda es el final más tardío de CUALQUIER ronda anterior, de cualquier categoría
    let floor = null;
    for (let t = 0; t < ri; t++) floor = laterPoint(floor, tierEnd[t]);

    round.forEach((match) => {
      if (match.schedule) return; // ya tenía horario asignado a mano; no lo tocamos
      const startIdx = floor ? slots.findIndex((s) => s.date > floor.date || (s.date === floor.date && s.minutes >= floor.minutes)) : 0;
      for (let i = Math.max(startIdx, 0); i < slots.length; i++) {
        const slot = slots[i];
        const timeStr = minutesToTime(slot.minutes);
        let freeCourt = null;
        for (let c = 1; c <= courts; c++) {
          if (!courtBusy.has(`${slot.date}|${timeStr}|${c}`)) { freeCourt = c; break; }
        }
        if (freeCourt != null) {
          match.schedule = { date: slot.date, time: timeStr, court: freeCourt };
          courtBusy.add(`${slot.date}|${timeStr}|${freeCourt}`);
          const end = { date: slot.date, minutes: slot.minutes + duration };
          tierEnd[ri] = laterPoint(tierEnd[ri], end);
          break;
        }
      }
    });
  });

  return { ...category, bracket: rounds };
}

/* Horarios de arranque de la grilla para un día de juego, según la duración de cada partido */
function dayTimeSlots(dateInfo, duration) {
  const times = [];
  for (let t = timeToMinutes(dateInfo.from); t + duration <= timeToMinutes(dateInfo.to); t += duration) times.push(minutesToTime(t));
  return times;
}

/* Orden cronológico de partidos con horario: fecha, hora y cancha */
function compareBySchedule(a, b) {
  if (a.schedule.date !== b.schedule.date) return a.schedule.date < b.schedule.date ? -1 : 1;
  if (a.schedule.time !== b.schedule.time) return a.schedule.time < b.schedule.time ? -1 : 1;
  return a.schedule.court - b.schedule.court;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Partidos ya ubicados (de cualquier categoría) en una fecha/cancha puntual, excluyendo opcionalmente
   uno en particular (el que se está por mover) */
function matchesAtSlot(scheduledMatches, date, time, court, excludeKey) {
  return scheduledMatches.filter((m) => m.key !== excludeKey && m.schedule && m.schedule.date === date && m.schedule.time === time && m.schedule.court === court);
}

/* Busca el próximo horario libre en la MISMA cancha y fecha, a partir de un horario dado (inclusive),
   respetando el rango horario de esa fecha. Devuelve null si no queda ningún hueco libre ese día. */
function findNextFreeSlotOnCourt(scheduledMatches, dateInfo, court, fromTime, duration, excludeKey) {
  if (!dateInfo) return null;
  const end = timeToMinutes(dateInfo.to);
  for (let t = timeToMinutes(fromTime); t + duration <= end; t += duration) {
    const timeStr = minutesToTime(t);
    if (matchesAtSlot(scheduledMatches, dateInfo.date, timeStr, court, excludeKey).length === 0) {
      return { date: dateInfo.date, time: timeStr, court };
    }
  }
  return null;
}

function pairAvailability(tournament, categoryId, pairId) {
  const cat = tournament.categories.find((c) => c.id === categoryId);
  // Equipo del Súper 8 Individual: puede jugar solo cuando coinciden sus dos jugadores
  const team = (cat?.teams || []).find((t) => t.id === pairId);
  if (team) return groupCombinedAvailability(tournament, categoryId, team.playerIds);
  const pair = cat?.pairs.find((p) => p.id === pairId);
  if (pair?.availability && pair.availability.length > 0) return pair.availability;
  // Sin disponibilidad cargada: se toma como disponible todos los días del torneo, en el horario de cada uno
  return (tournament.playDates || []).map((d) => ({ date: d.date, from: d.from, to: d.to }));
}

/* Disponibilidad combinada (intersección) de varias parejas de un mismo grupo: sirve para reservar
   de antemano el horario del cruce de ganadores/perdedores de un grupo de 4, antes de saber qué
   pareja concreta lo va a jugar. Solo devuelve fechas en las que TODAS coinciden. */
function groupCombinedAvailability(tournament, categoryId, pairIds) {
  const dates = (tournament.playDates || []).map((d) => d.date);
  const perPair = pairIds.map((pid) => pairAvailability(tournament, categoryId, pid));
  const combined = [];
  dates.forEach((date) => {
    const slots = perPair.map((avail) => avail.find((a) => a.date === date)).filter(Boolean);
    if (slots.length !== perPair.length) return;
    const from = Math.max(...slots.map((s) => timeToMinutes(s.from)));
    const to = Math.min(...slots.map((s) => timeToMinutes(s.to)));
    if (from < to) combined.push({ date, from: minutesToTime(from), to: minutesToTime(to) });
  });
  return combined;
}

/* ---------- Sorteo de grupos y control de una sola categoría por jugador ---------- */

const GROUP_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/* Arma grupos por sorteo, priorizando juntar en el mismo grupo a las parejas que comparten
   fechas de disponibilidad (para que el grupo se pueda jugar en la menor cantidad de días posible).
   `pairs` son objetos {id, availability}. */
function autoFormGroups(pairs, playDates) {
  const TARGET_SIZE = 3;
  const total = pairs.length;
  // Cantidad de grupos fija segun el total de parejas: siempre se arman en base a grupos de 3.
  // Lo que sobra al dividir por 3 (0, 1 o 2 parejas) se reparte como cuarto integrante en esa
  // cantidad de grupos. Ej: 12 parejas -> 4 grupos de 3. 13 parejas -> 3 grupos de 3 + 1 de 4.
  // 14 parejas -> 2 grupos de 3 + 2 de 4. Nunca se arman grupos de menos de 3.
  const numGroups = Math.max(1, Math.floor(total / TARGET_SIZE));
  const remainder = total - numGroups * TARGET_SIZE; // 0, 1 o 2
  const groupSizes = Array.from({ length: numGroups }, (_, i) => TARGET_SIZE + (i < remainder ? 1 : 0));

  const pairsById = Object.fromEntries(pairs.map((p) => [p.id, p]));
  const allDates = (playDates || []).map((d) => d.date);

  // Ventanas horarias por pareja y fecha, en minutos: { fecha: { from, to } }.
  // Sin disponibilidad cargada = disponible todos los dias del torneo, en el horario general.
  const windowsById = Object.fromEntries(pairs.map((p) => {
    const avail = (p.availability && p.availability.length > 0)
      ? p.availability
      : (playDates || []).map((d) => ({ date: d.date, from: d.from, to: d.to }));
    const map = {};
    avail.forEach((a) => {
      if (a && a.date && a.from && a.to) map[a.date] = { from: timeToMinutes(a.from), to: timeToMinutes(a.to) };
    });
    return [p.id, map];
  }));

  // Interseccion de ventanas horarias: solo quedan las fechas donde ambas partes coinciden
  // Y el rango horario realmente se superpone (no alcanza con compartir el dia).
  const intersectWindows = (winsA, winsB) => {
    const result = {};
    Object.keys(winsA).forEach((date) => {
      const b = winsB[date];
      if (!b) return;
      const a = winsA[date];
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (from < to) result[date] = { from, to };
    });
    return result;
  };
  const overlapCount = (winsA, winsB) => Object.keys(intersectWindows(winsA, winsB)).length;

  const groups = []; // { pairIds: [], commonWindows: {fecha: {from,to}}, targetSize }
  const remainingSizes = [...groupSizes]; // cupos de grupo que todavia hay que llenar, se van consumiendo

  // Fase 1: buscamos, entre todas las fechas del torneo, la franja horaria donde mas parejas del
  // pool coinciden realmente (no solo el dia, sino el rango horario superpuesto entre todas ellas).
  // Usamos un barrido de eventos (sweep line). El tamano de cada grupo ya esta fijado de antemano
  // (3, salvo el resto que va a 4); aca solo elegimos QUE parejas entran juntas, respetando ese tamano.
  let pool = pairs.map((p) => p.id).sort(() => Math.random() - 0.5); // sorteo para desempatar
  while (remainingSizes.length > 0 && pool.length >= TARGET_SIZE) {
    const wantSize = remainingSizes[0];
    let best = null; // { date, ids: [...], from, to }
    allDates.forEach((date) => {
      const candidates = pool.filter((id) => windowsById[id][date]);
      if (candidates.length < TARGET_SIZE) return;
      const events = [];
      candidates.forEach((id) => {
        const w = windowsById[id][date];
        events.push({ t: w.from, type: 1, id });
        events.push({ t: w.to, type: -1, id });
      });
      // Los cierres se procesan antes que las aperturas en el mismo minuto exacto, para no
      // contar como "simultaneas" a dos ventanas que solo se tocan en un punto (superposicion nula).
      events.sort((a, b) => a.t - b.t || a.type - b.type);
      const active = new Set();
      events.forEach((ev) => {
        if (ev.type === 1) {
          active.add(ev.id);
          if (active.size >= TARGET_SIZE && (!best || active.size > best.ids.length)) {
            best = { date, ids: [...active], from: ev.t };
          }
        } else {
          active.delete(ev.id);
        }
      });
    });
    if (!best) break;
    // Tomamos hasta el tamano de grupo pedido; si sobran parejas compatibles, quedan en el pool
    // para el proximo grupo (sigue siendo mutuamente compatible, se podra usar despues).
    const chunkIds = best.ids.slice(0, Math.min(best.ids.length, wantSize));
    const finalIds = chunkIds;
    let commonWindows = null;
    finalIds.forEach((id) => {
      commonWindows = commonWindows ? intersectWindows(commonWindows, windowsById[id]) : windowsById[id];
    });
    groups.push({ pairIds: finalIds, commonWindows: commonWindows || {}, targetSize: wantSize });
    pool = pool.filter((id) => !finalIds.includes(id));
    remainingSizes.shift();
  }

  // Fase 2: lo que sobro no alcanza para llenar un grupo con horario realmente compatible, o ya
  // no quedan cupos de grupo "nuevo" por abrir. Se acomoda de a una pareja, completando primero
  // los grupos ya armados que todavia no llegaron a su tamano objetivo, buscando siempre la mejor
  // coincidencia posible con lo ya armado.
  pool.sort((a, b) => {
    const aEmpty = Object.keys(windowsById[a]).length === 0, bEmpty = Object.keys(windowsById[b]).length === 0;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    return Object.keys(windowsById[a]).length - Object.keys(windowsById[b]).length;
  });
  // Si quedaron cupos de grupo sin abrir (no se encontro franja compatible), los abrimos vacios
  // para que sigan existiendo como destino valido en esta fase.
  remainingSizes.forEach((size) => {
    groups.push({ pairIds: [], commonWindows: {}, targetSize: size });
  });
  const leftover = [];
  pool.forEach((id) => {
    const wins = windowsById[id];
    let best = null, bestOverlap = -1;
    groups.forEach((g) => {
      if (g.pairIds.length >= g.targetSize) return;
      const overlap = g.pairIds.length === 0 ? 0 : overlapCount(g.commonWindows, wins);
      if (!best || overlap > bestOverlap) { bestOverlap = overlap; best = g; }
    });
    if (best) {
      best.pairIds.push(id);
      best.commonWindows = best.pairIds.length === 1 ? wins : intersectWindows(best.commonWindows, wins);
    } else {
      leftover.push({ pairIds: [id], commonWindows: wins, targetSize: TARGET_SIZE });
    }
  });
  groups.push(...leftover);

  // Ningun grupo puede quedar con menos de 3 parejas (en padel se juega de a 3, con 4 solo para
  // la que sobra). Cualquier grupo chico se desarma y sus parejas se reparten en los demas grupos,
  // subiendo hasta un maximo de 4, priorizando siempre la mejor coincidencia horaria real.
  const warnings = [];
  let orphans = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].pairIds.length >= TARGET_SIZE) continue;
    orphans.push(...groups[i].pairIds);
    groups.splice(i, 1);
  }
  orphans.forEach((orphanId) => {
    const orphanWins = windowsById[orphanId];
    let best = null, bestOverlap = -1;
    groups.forEach((g) => {
      if (g.pairIds.length >= 4) return;
      const overlap = overlapCount(g.commonWindows, orphanWins);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = g; }
    });
    if (best) {
      if (bestOverlap === 0) warnings.push(pairsById[orphanId]?.name || "Pareja");
      best.pairIds.push(orphanId);
      best.commonWindows = intersectWindows(best.commonWindows, orphanWins);
    } else {
      groups.push({ pairIds: [orphanId], commonWindows: orphanWins, targetSize: TARGET_SIZE });
    }
  });
  // Ultimo recurso: si quedaron grupos sueltos de menos de 3 (no habia donde meterlos), se
  // combinan entre si para no dejar a nadie sin grupo.
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].pairIds.length >= TARGET_SIZE || groups.length === 1) continue;
    const small = groups.splice(i, 1)[0];
    const target = groups.find((g) => g.pairIds.length < 4) || groups[0];
    if (target) target.pairIds.push(...small.pairIds);
    else groups.push(small);
  }

  const formed = groups.map((g, i) => {
    const built = buildGroupMatches(g.pairIds);
    return { id: uid(), name: `Grupo ${GROUP_LETTERS[i] || i + 1}`, pairIds: g.pairIds, format: built.format, matches: built.matches };
  });
  return { groups: formed, warnings };
}
/* Separa los nombres de jugadores de una pareja: "Gómez / Ibáñez" -> ["gómez", "ibáñez"] */
function splitPlayers(pairName) {
  return pairName.split("/").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/* Busca si algún jugador de esta pareja ya está anotado en otra categoría del mismo torneo.
   Devuelve el nombre de esa categoría, o null si no hay conflicto. */
function findPlayerCategoryConflict(pairName, tournament, currentCategoryId) {
  const players = splitPlayers(pairName);
  if (players.length === 0) return null;
  for (const c of tournament.categories) {
    if (c.id === currentCategoryId) continue;
    for (const p of c.pairs) {
      const otherPlayers = splitPlayers(p.name);
      if (players.some((pl) => otherPlayers.includes(pl))) return c.name;
    }
  }
  return null;
}

/* ---------- Circuitos anuales (torneos "fecha" que suman puntos individuales) ---------- */

const DEFAULT_CIRCUIT_POINTS = { campeon: 100, finalista: 70, semifinalista: 50, cuartos: 30, octavos: 20, grupos: 10 };
const CIRCUIT_TIER_LABEL = { campeon: "Campeón", finalista: "Finalista", semifinalista: "Semifinalista", cuartos: "Cuartos de final", octavos: "Octavos de final", grupos: "Fase de grupos" };
const CIRCUIT_TIER_ORDER = ["campeon", "finalista", "semifinalista", "cuartos", "octavos", "grupos"];

/* A partir de la llave final de una categoría, determina en qué instancia quedó eliminada cada pareja.
   Las que nunca entraron a la llave (o no hay llave todavía) quedan en "fase de grupos". */
function categoryPlacements(category) {
  const results = []; // { pairId, tier }
  const bracket = category.bracket;
  if (bracket && bracket.length > 0) {
    const finalMatch = bracket[bracket.length - 1][0];
    const champion = winnerOf(finalMatch);
    [finalMatch.pairA, finalMatch.pairB].filter(Boolean).forEach((pid) => {
      results.push({ pairId: pid, tier: pid === champion ? "campeon" : "finalista" });
    });
    if (bracket.length >= 2) {
      bracket[bracket.length - 2].forEach((m) => {
        const w = winnerOf(m);
        [m.pairA, m.pairB].filter(Boolean).forEach((pid) => { if (pid !== w) results.push({ pairId: pid, tier: "semifinalista" }); });
      });
    }
    // Cuartos de Final es exactamente la ronda bracket.length-3
    if (bracket.length >= 3) {
      bracket[bracket.length - 3].forEach((m) => {
        const w = winnerOf(m);
        [m.pairA, m.pairB].filter(Boolean).forEach((pid) => { if (pid !== w) results.push({ pairId: pid, tier: "cuartos" }); });
      });
    }
    // Octavos y cualquier ronda anterior (16avos, etc.) se agrupan en "octavos" por no tener escalón propio
    for (let r = 0; r <= bracket.length - 4; r++) {
      bracket[r].forEach((m) => {
        const w = winnerOf(m);
        [m.pairA, m.pairB].filter(Boolean).forEach((pid) => { if (pid !== w) results.push({ pairId: pid, tier: "octavos" }); });
      });
    }
  }
  const placed = new Set(results.map((r) => r.pairId));
  category.pairs.forEach((p) => { if (!placed.has(p.id)) results.push({ pairId: p.id, tier: "grupos" }); });
  return results;
}

/* Tabla de puntos de un circuito, separada por categoría, sumando por jugador individual
   (no por pareja, porque puede cambiar de compañero entre fechas) */
function computeCircuitStandings(circuit, tournaments) {
  const points = circuit.pointsScale || DEFAULT_CIRCUIT_POINTS;
  const table = {}; // { [categoryName]: { [playerKey]: { name, points, fechas } } }
  circuit.categoryNames.forEach((cn) => { table[cn] = {}; });

  tournaments.filter((t) => t.circuitId === circuit.id).forEach((t) => {
    t.categories.forEach((cat) => {
      if (isSuper8(cat)) return; // El Súper 8 no suma puntos de circuito
      const matchName = circuit.categoryNames.find((cn) => cn.trim().toLowerCase() === cat.name.trim().toLowerCase());
      if (!matchName) return;
      categoryPlacements(cat).forEach(({ pairId, tier }) => {
        const pair = cat.pairs.find((p) => p.id === pairId);
        if (!pair) return;
        const pts = points[tier] ?? 0;
        pair.name.split("/").map((s) => s.trim()).filter(Boolean).forEach((playerName) => {
          const key = playerName.toLowerCase();
          if (!table[matchName][key]) table[matchName][key] = { name: playerName, points: 0, fechas: 0 };
          table[matchName][key].points += pts;
          table[matchName][key].fechas += 1;
        });
      });
    });
  });

  const result = {};
  Object.entries(table).forEach(([cn, players]) => {
    result[cn] = Object.values(players).sort((a, b) => b.points - a.points);
  });
  return result;
}

/* Arma la grilla de forma automática: solo completa partidos que todavía no tengan horario asignado,
   respetando disponibilidad de parejas, sin repetir cancha ni hacer jugar a una pareja dos veces a la vez */
function autoSchedule(tournament) {
  if (!tournamentUsesSchedule(tournament)) return tournament; // El Súper 8 no tiene grilla
  const courts = tournament.courtsCount || 4;
  const duration = tournament.matchDurationMinutes || 90;
  const dates = (tournament.playDates || []).map((d) => d.date);
  const all = collectScheduleableMatches(tournament);

  // Quiénes no pueden estar en dos canchas a la vez: las dos parejas, o los 4 jugadores en el
  // Súper 8 Individual (ahí las parejas cambian en cada partido, así que se controla por jugador).
  const categoriesById = Object.fromEntries((tournament.categories || []).map((c) => [c.id, c]));
  const participants = (m) => [m.pairA, m.pairB].flatMap((side) => sideParticipantIds(categoriesById[m.categoryId], side));

  const courtBusy = new Set();
  const pairBusy = new Set();
  all.filter((m) => m.schedule).forEach((m) => {
    const { date, time, court } = m.schedule;
    courtBusy.add(`${date}|${time}|${court}`);
    participants(m).forEach((pid) => pairBusy.add(`${date}|${time}|${pid}`));
  });

  let updated = tournament;

  // En un grupo de 4, el cruce de ganadores y el de perdedores no pueden arrancar hasta que
  // terminen los dos partidos del sorteo inicial (r1). Guardamos esos horarios por grupo para
  // poder calcular ese piso, y procesamos primero los partidos r1 para tenerlo disponible.
  const groupR1Schedules = {}; // `${categoryId}:${groupId}` -> [schedule, ...]
  all.filter((m) => m.schedule && m.location.type === "group" && m.stage === "r1").forEach((m) => {
    const key = `${m.categoryId}:${m.location.groupId}`;
    (groupR1Schedules[key] = groupR1Schedules[key] || []).push(m.schedule);
  });

  const toSchedule = all
    .filter((m) => !m.schedule && m.location.type === "group")
    .sort((a, b) => {
      const rank = (x) => (x.groupFormat === "bracket4" && x.stage !== "r1" ? 1 : 0);
      return rank(a) - rank(b);
    });

  // Solo se auto-programan partidos de grupos: las parejas únicamente informan disponibilidad
  // para esa fase. Los partidos de la llave final los agenda siempre el organizador a mano.
  toSchedule.forEach((m) => {
    const groupKey = `${m.categoryId}:${m.location.groupId}`;
    let floor = null;
    if (m.groupFormat === "bracket4" && m.stage !== "r1") {
      (groupR1Schedules[groupKey] || []).forEach((s) => { floor = laterPoint(floor, scheduleEndPoint(s, duration)); });
    }

    const isPlaceholder = !m.pairA || !m.pairB;
    let availA, availB;
    if (isPlaceholder) {
      const cat = updated.categories.find((c) => c.id === m.categoryId);
      const group = cat?.groups.find((g) => g.id === m.location.groupId);
      const combined = groupCombinedAvailability(updated, m.categoryId, group?.pairIds || []);
      availA = combined;
      availB = combined;
    } else {
      availA = pairAvailability(updated, m.categoryId, m.pairA);
      availB = pairAvailability(updated, m.categoryId, m.pairB);
    }
    let placed = null;
    for (const date of dates) {
      if (floor && date < floor.date) continue;
      const aSlot = availA.find((a) => a.date === date);
      const bSlot = availB.find((a) => a.date === date);
      if (!aSlot || !bSlot) continue;
      const start = Math.max(timeToMinutes(aSlot.from), timeToMinutes(bSlot.from));
      const end = Math.min(timeToMinutes(aSlot.to), timeToMinutes(bSlot.to));
      for (let t = start; t + duration <= end; t += duration) {
        if (floor && date === floor.date && t < floor.minutes) continue;
        const time = minutesToTime(t);
        // Para el cruce de ganadores/perdedores todavía no sabemos qué pareja concreta juega,
        // así que solo evitamos pisar otra cancha (no hay pareja puntual que chequear todavía).
        if (!isPlaceholder && participants(m).some((pid) => pairBusy.has(`${date}|${time}|${pid}`))) continue;
        let freeCourt = null;
        for (let c = 1; c <= courts; c++) {
          if (!courtBusy.has(`${date}|${time}|${c}`)) { freeCourt = c; break; }
        }
        if (freeCourt == null) continue;
        placed = { date, time, court: freeCourt };
        break;
      }
      if (placed) break;
    }
    if (placed) {
      courtBusy.add(`${placed.date}|${placed.time}|${placed.court}`);
      if (!isPlaceholder) participants(m).forEach((pid) => pairBusy.add(`${placed.date}|${placed.time}|${pid}`));
      if (m.stage === "r1") (groupR1Schedules[groupKey] = groupR1Schedules[groupKey] || []).push(placed);
      updated = withMatchSchedule(updated, m.categoryId, m.location, m.matchId, placed);
    }
  });
  return updated;
}

/* ---------- Fuentes ---------- */
function useBrandFonts() {
  useEffect(() => {
    if (document.getElementById("sp-fonts")) return;
    const link = document.createElement("link");
    link.id = "sp-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Work+Sans:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }, []);
}

const F = { display: { fontFamily: "'Archivo Black', sans-serif" }, body: { fontFamily: "'Work Sans', sans-serif" } };

/* Colores de marca, tomados del logo */
const BRAND = { bgStart: "#14181f", bgEnd: "#1b2027", lime: "#9fe022", limeText: "#14181f", ink: "#f2f5f8", cyan: "#22d3ee", logoLime: "#c1ef26" };

/* Fondo general: azul petróleo muy oscuro con un brillo suave arriba */
const APP_BACKGROUND = "radial-gradient(120% 60% at 50% 0%, #0f2f3a 0%, #0b1c24 45%, #081218 100%)";

/* Borde de neón con resplandor, para tarjetas y botones destacados */
function neonStyle(color, strong = false) {
  return {
    border: `1.5px solid ${color}${strong ? "" : "cc"}`,
    boxShadow: `0 0 ${strong ? 22 : 12}px ${color}${strong ? "80" : "4d"}, inset 0 0 18px ${color}14`,
  };
}

/* Fondo de cancha genérico (sin foto): vidrio oscuro con líneas de luz, para cuando el organizador
   todavía no subió su foto de portada */
const COURT_FALLBACK_BACKGROUND = [
  "linear-gradient(115deg, transparent 0 38%, rgba(159,224,34,0.18) 38.5%, transparent 40%)",
  "repeating-linear-gradient(90deg, rgba(148,163,184,0.07) 0 1px, transparent 1px 22px)",
  "repeating-linear-gradient(0deg, rgba(148,163,184,0.07) 0 1px, transparent 1px 22px)",
  "radial-gradient(80% 70% at 50% 30%, #12313b 0%, #0a1a21 100%)",
].join(", ");

/* ---------- Componentes chicos ---------- */

/* Logo: la "S" con el trazo de la pelota (imagen con fondo transparente), del alto indicado. Con
   withWordmark suma "SMASH POINT / EVENTOS DE PADEL" escrito como texto, para que se vea nítido
   en cualquier tamaño. */
function Logo({ size = 40, withWordmark = false }) {
  const mark = <img src={logoMarkUrl} alt="Smash Point" style={{ height: size, width: "auto" }} className="shrink-0" />;
  if (!withWordmark) return mark;
  return (
    <div className="flex flex-col items-center">
      {mark}
      <span className="mt-2 text-2xl" style={{ ...F.display, color: BRAND.logoLime, letterSpacing: "1px" }}>SMASH POINT</span>
      <span className="text-[11px]" style={{ ...F.body, color: BRAND.logoLime, letterSpacing: "4px" }}>EVENTOS DE PADEL</span>
    </div>
  );
}

/* Publicidad, igual en toda la app: una cuadrícula de 4 anuncios (2×2 en el celular, 4 en fila en
   la compu) que va rotando de a 4 cada 6 segundos. Los puntitos muestran la tanda actual y se
   pueden tocar para pasar a otra. No se muestra nada si no hay anuncios activos. */
const ADS_PAGE_SIZE = 4;

function AdBanner({ ads, className = "" }) {
  const active = (ads || []).filter((a) => a.active);
  const pages = [];
  for (let i = 0; i < active.length; i += ADS_PAGE_SIZE) pages.push(active.slice(i, i + ADS_PAGE_SIZE));
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (pages.length < 2) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages.length), 6000);
    return () => clearInterval(id);
  }, [pages.length, page]); // al tocar un puntito se reinicia la cuenta

  if (active.length === 0) return null;
  const current = page % pages.length;

  return (
    <section className={className} aria-label="Publicidad">
      <div key={current} className="grid gap-3 grid-cols-2 sm:grid-cols-4 sp-fade-in">
        {pages[current].map((ad, i) => {
          const color = (Math.floor(i / 2) + i) % 2 === 0 ? BRAND.lime : BRAND.cyan;
          return (
            <a
              key={ad.id}
              href={ad.linkUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="block relative rounded-2xl overflow-hidden"
              style={neonStyle(color)}
            >
              <img src={ad.imageUrl} alt={ad.name || "Publicidad"} className="w-full aspect-[4/3] object-cover" />
              <span className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: "rgba(8,18,24,0.8)", color: "#cbd5e1", ...F.body }}>Publicidad</span>
            </a>
          );
        })}
      </div>
      {pages.length > 1 && (
        <div className="flex gap-2 justify-center mt-3">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-label={`Publicidades ${i + 1} de ${pages.length}`}
              className="w-2.5 h-2.5 rounded-full transition"
              style={{ backgroundColor: i === current ? BRAND.lime : "#1e3a45" }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/* Logo del organizador en un círculo (o su inicial si no subió logo) */
function OrganizerAvatar({ organizer, size = 48, color = BRAND.cyan }) {
  const style = { width: size, height: size, ...neonStyle(color), backgroundColor: "#081218" };
  if (organizer?.logoUrl) return <img src={organizer.logoUrl} alt={organizer.name} className="rounded-full object-cover shrink-0" style={style} />;
  return (
    <span className="rounded-full flex items-center justify-center shrink-0" style={{ ...style, ...F.display, color, fontSize: size * 0.4 }}>
      {(organizer?.name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

/* Formulario público de inscripción, en una hoja que sube desde abajo (en la compu, centrada).
   Sin cuenta: se guarda como "pendiente" y el organizador la acepta o rechaza desde su panel.
   Trae un campo trampa (honeypot) oculto para frenar bots y el botón se bloquea mientras envía. */
function RegistrationSheet({ tournament, organizer, onClose }) {
  const categories = tournament.categories.filter(categoryAcceptsRegistrations);
  const [categoryId, setCategoryId] = useState(categories.length === 1 ? categories[0].id : "");
  const [player1, setPlayer1] = useState("");
  const [player2, setPlayer2] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState(""); // honeypot: una persona nunca lo ve ni lo completa
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !sending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const category = categories.find((c) => c.id === categoryId);
  const individual = category?.format === "super8_individual";
  const full = category ? categorySpotsLeft(category) === 0 : false;
  const normalizedPhone = normalizeArPhone(phone);
  const validName = (n) => n.trim().length >= 3 && n.trim().includes(" ");
  const ready = category && !full && validName(player1) && (individual || validName(player2)) && normalizedPhone;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError("");
    try {
      await supabaseRpc("crear_inscripcion", {
        p_torneo_id: tournament.id,
        p_categoria_id: category.id,
        p_jugador1: player1.trim(),
        p_jugador2: individual ? null : player2.trim(),
        p_telefono: normalizedPhone,
        p_honeypot: website,
      });
      setDone(true);
    } catch (err) {
      setError(inscripcionErrorText(err));
    } finally {
      setSending(false);
    }
  };

  const input = "w-full px-3 py-3 rounded-lg border outline-none text-base focus:border-lime-400";
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };
  const label = "block text-xs text-teal-300 mb-1";
  const spotsText = (c) => {
    const left = categorySpotsLeft(c);
    return left == null ? "" : left === 0 ? " (completo)" : ` (quedan ${left})`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.7)" }} onClick={() => { if (!sending) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Inscripción a ${tournament.name}`}
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl px-5 pt-4 sm:p-6"
        style={{ backgroundColor: "#0b1c24", color: "#e2e8f0", ...neonStyle(BRAND.cyan), paddingBottom: "calc(env(safe-area-inset-bottom) + 1.25rem)", ...F.body }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full mx-auto mb-4 sm:hidden" style={{ backgroundColor: "#1e3a45" }} />
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <span className="text-teal-600 text-lg">×</span>
            <OrganizerAvatar organizer={organizer} size={44} />
          </div>
          <button type="button" onClick={onClose} disabled={sending} className="text-teal-400 hover:text-lime-400 text-xl leading-none p-1" aria-label="Cerrar">✕</button>
        </div>

        <p className="text-xs text-teal-400 mb-0.5">{organizer?.name || "Organizador"}</p>
        <h2 className="text-xl mb-1" style={F.display}>{tournament.name.toUpperCase()}</h2>
        <div className="flex items-center gap-2 flex-wrap mb-5">
          <TournamentTypeTag tournament={tournament} />
          <span className="text-xs text-teal-300">{new Date(tournament.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "long" })}</span>
        </div>

        {done ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center text-2xl" style={{ ...neonStyle(BRAND.lime, true), color: BRAND.lime }}>✓</div>
            <p className="text-base font-semibold mb-1">¡Listo!</p>
            <p className="text-sm text-teal-200 mb-5">Tu inscripción está pendiente de confirmación del organizador.</p>
            <button type="button" onClick={onClose} className="w-full py-3 rounded-full font-semibold" style={{ backgroundColor: BRAND.lime, color: "#14181f" }}>Listo</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            {categories.length > 1 ? (
              <div>
                <label className={label} htmlFor="insc-cat">Categoría</label>
                <select id="insc-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={input} style={inputStyle} required>
                  <option value="">Elegí la categoría…</option>
                  {categories.map((c) => <option key={c.id} value={c.id} disabled={categorySpotsLeft(c) === 0}>{c.name}{spotsText(c)}</option>)}
                </select>
              </div>
            ) : category && (
              <p className="text-sm">Categoría: <span className="font-semibold text-lime-400">{category.name}</span><span className="text-teal-400">{spotsText(category)}</span></p>
            )}

            <div>
              <label className={label} htmlFor="insc-j1">{individual ? "Nombre y apellido" : "Jugador 1 · nombre y apellido"}</label>
              <input id="insc-j1" value={player1} onChange={(e) => setPlayer1(e.target.value)} autoComplete="name" maxLength={80} className={input} style={inputStyle} placeholder="Ej: Juan Pérez" />
            </div>
            {!individual && (
              <div>
                <label className={label} htmlFor="insc-j2">Jugador 2 · nombre y apellido</label>
                <input id="insc-j2" value={player2} onChange={(e) => setPlayer2(e.target.value)} autoComplete="off" maxLength={80} className={input} style={inputStyle} placeholder="Ej: Martín López" />
              </div>
            )}
            <div>
              <label className={label} htmlFor="insc-tel">WhatsApp</label>
              <input id="insc-tel" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={input} style={inputStyle} placeholder="Ej: 3446 123456" />
              <p className="text-[11px] mt-1 text-teal-500">
                {phone && !normalizedPhone ? <span className="text-amber-400">Con característica, sin el 0 ni el 15. Ej: 11 2345 6789</span> : normalizedPhone ? `Te van a escribir al ${formatArPhone(normalizedPhone)}` : "Con característica, sin el 0 ni el 15."}
              </p>
            </div>

            {/* Honeypot: fuera de pantalla y fuera del orden de tabulación */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <label htmlFor="insc-web">No completar</label>
              <input id="insc-web" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>

            {((player1 && !validName(player1)) || (!individual && player2 && !validName(player2))) && (
              <p className="text-sm text-amber-400">Poné nombre y apellido de {individual ? "quien se inscribe" : "cada jugador"}.</p>
            )}
            {full && <p className="text-sm text-amber-400">El cupo de esta categoría ya está completo.</p>}
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

            <button type="submit" disabled={!ready || sending} className="w-full py-3.5 rounded-full font-semibold text-base disabled:opacity-40" style={{ backgroundColor: BRAND.lime, color: "#14181f" }}>
              {sending ? "Enviando…" : "Enviar inscripción"}
            </button>
            <p className="text-[11px] text-teal-600 text-center">Tu WhatsApp solo lo ve el organizador del torneo.</p>
          </form>
        )}
      </div>
    </div>
  );
}

/* Botón "Inscribirme" según el estado de las inscripciones del torneo (no se muestra si están cerradas) */
function RegisterButton({ tournament, onRegister, className = "", full = false }) {
  const status = registrationStatus(tournament);
  if (status === "cerrado") return null;
  const complete = status === "completo";
  return (
    <button
      type="button"
      disabled={complete}
      onClick={(e) => { e.stopPropagation(); onRegister(tournament); }}
      className={`${full ? "w-full" : ""} px-4 py-2.5 rounded-full text-sm font-semibold transition disabled:opacity-60 ${className}`}
      style={complete ? { ...F.body, border: "1px solid #475569", color: "#94a3b8" } : { ...F.body, backgroundColor: BRAND.lime, color: "#14181f", boxShadow: `0 0 14px ${BRAND.lime}55` }}
    >
      {complete ? "Cupo completo" : "Inscribirme"}
    </button>
  );
}

function OpenRegistrationsBadge({ tournament }) {
  if (registrationStatus(tournament) !== "abierto") return null;
  return (
    <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide" style={{ ...F.body, color: BRAND.lime, border: `1px solid ${BRAND.lime}80`, backgroundColor: BRAND.lime + "1a" }}>
      ● Inscripciones abiertas
    </span>
  );
}

/* Franja del inicio con los torneos que tienen inscripciones abiertas (no se muestra si no hay) */
function OpenRegistrationsStrip({ tournaments, organizers, onRegister }) {
  const open = tournaments.filter((t) => registrationStatus(t) !== "cerrado").sort((a, b) => (a.date < b.date ? -1 : 1));
  if (open.length === 0) return null;
  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-6" aria-labelledby="insc-abiertas">
      <h2 id="insc-abiertas" className="text-sm uppercase tracking-wide mb-3 flex items-center gap-2" style={{ ...F.display, color: BRAND.lime }}>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: BRAND.lime, boxShadow: `0 0 8px ${BRAND.lime}` }} /> Inscripciones abiertas
      </h2>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1" style={{ scrollbarWidth: "none" }}>
        {open.map((t, i) => {
          const organizer = organizers.find((o) => o.id === t.organizerId);
          const color = i % 2 === 0 ? BRAND.lime : BRAND.cyan;
          return (
            <div key={t.id} className="snap-start shrink-0 w-[85%] sm:w-[48%] lg:w-[32%] rounded-2xl p-4 flex gap-3 items-center" style={{ ...neonStyle(color), backgroundColor: "rgba(8,18,24,0.75)" }}>
              <OrganizerAvatar organizer={organizer} size={52} color={color} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate" style={{ ...F.body, color: BRAND.ink }}>{t.name}</p>
                <p className="text-xs text-teal-300 truncate" style={F.body}>{organizer?.name || "Organizador"}</p>
                <p className="text-xs text-teal-400" style={F.body}>📅 {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "short" })}</p>
                <div className="mt-1"><TournamentTypeTag tournament={t} /></div>
              </div>
              <RegisterButton tournament={t} onRegister={onRegister} className="shrink-0" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* "Cartel" inclinado estilo cancha/vidriera, para títulos de sección con más pegada visual
   (ej: "ZONA A", "CANCHA 1", la fecha). Envuelve el contenido dos veces para poder inclinar
   el fondo sin inclinar el texto de adentro. */
function SkewPill({ color, textColor = "#14181f", className = "", children }) {
  return (
    <span className={`inline-block ${className}`} style={{ transform: "skewX(-8deg)" }}>
      <span
        className="inline-block px-3 py-1.5 rounded font-extrabold uppercase tracking-wide text-sm"
        style={{ backgroundColor: color, color: textColor, transform: "skewX(8deg)" }}
      >
        {children}
      </span>
    </span>
  );
}

function Badge({ status }) {
  const styles = {
    [STATUS.PROXIMO]: { backgroundColor: "#164e63", color: "#a5f3fc" },
    [STATUS.EN_CURSO]: { backgroundColor: "#9fe022", color: "#14181f" },
    [STATUS.FINALIZADO]: { backgroundColor: "#334155", color: "#cbd5e1" },
  };
  return (
    <span className="px-3 py-1 rounded-full text-xs font-semibold" style={{ ...F.body, ...styles[status] }}>
      {status === STATUS.EN_CURSO ? "● EN VIVO" : status}
    </span>
  );
}

function PairName({ id, pairsById }) {
  if (id === null) return <span className="italic opacity-50">Libre (bye)</span>;
  if (!id) return <span className="italic opacity-50">A definir</span>;
  return <span>{pairsById[id]?.name || "—"}</span>;
}

/* Igual que PairName, pero para partidos de GRUPO: ahí "null" nunca es un bye (eso solo existe
   en la llave final), sino un cruce de ganadores/perdedores que todavía no tiene pareja asignada. */
function GroupPairName({ id, pairsById }) {
  if (!id) return <span className="italic opacity-50">A definir</span>;
  return <span>{pairsById[id]?.name || "—"}</span>;
}

/* Muestra el resultado set por set en modo solo lectura, ej: "6-4 · 3-6 · 10-7".
   Si se pasa winnerIsA=false, invierte cada set para que el número de la pareja ganadora
   aparezca siempre primero, así el criterio de lectura es siempre el mismo (ganador-perdedor). */
function SetsSummary({ sets, winnerIsA }) {
  const played = (sets || []).filter((s) => s && s.a != null && s.b != null);
  if (played.length === 0) return <span className="opacity-50">vs</span>;
  return (
    <span>
      {played.map((s) => (winnerIsA === false ? `${s.b}-${s.a}` : `${s.a}-${s.b}`)).join(" · ")}
    </span>
  );
}

/* Resultado de un partido en modo lectura: "WO" si fue por walkover, o el resultado set a set (ganador primero) */
function MatchResultLabel({ match, winnerIsA }) {
  if (match && match.walkover) return <span className="text-amber-400 font-semibold">WO</span>;
  return <SetsSummary sets={match.sets} winnerIsA={winnerIsA} />;
}

/* Tilde que marca a la pareja ganadora de un partido, para que se vea de un vistazo sin tener que leer el resultado */
function WinnerCheck() {
  return <span className="text-lime-400 shrink-0" aria-label="Ganador" style={{ fontWeight: 900 }}>✓</span>;
}

/* Etiqueta de estado de un partido en la tabla de horarios: Finalizado (auto), En curso (manual) o Pendiente */
function MatchStatusBadge({ status }) {
  const map = {
    finalizado: { label: "Finalizado", color: "#9fe022" },
    en_curso: { label: "En curso", color: "#fb923c" },
    pendiente: { label: "Pendiente", color: "#64748b" },
  };
  const s = map[status] || map.pendiente;
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ backgroundColor: s.color + "22", color: s.color }}
    >
      {s.label}
    </span>
  );
}

/* Tabla de posiciones completa de un grupo: PJ, PG, PP, sets a favor/en contra y diferencia,
   games a favor/en contra y diferencia, super tie-breaks ganados, y puntos */
const GROUP_COLORS = ["#9fe022", "#38bdf8", "#fb923c", "#e879f9", "#22d3ee", "#fbbf24", "#f87171", "#a78bfa"];

function StandingsTable({ group, pairsById, format, accentColor = "#9fe022", highlightCount = 2 }) {
  const table = computeStandings(group, pairsById, format);
  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: accentColor + "40" }}>
      {table.map((row, i) => {
        const qualifies = i < highlightCount;
        const ds = row.setsF - row.setsC;
        const dg = row.gamesF - row.gamesC;
        return (
          <div
            key={row.pairId}
            className="px-3 py-2"
            style={{
              backgroundColor: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.03)",
              borderLeft: qualifies ? `3px solid ${accentColor}` : "3px solid transparent",
              borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-extrabold shrink-0"
                  style={qualifies ? { backgroundColor: accentColor, color: "#14181f" } : { backgroundColor: "#ffffff14", color: "#94a3b8" }}
                >
                  {i + 1}
                </span>
                <span className={`text-sm ${qualifies ? "font-semibold" : ""}`} style={qualifies ? { color: accentColor } : undefined}>
                  <PairName id={row.pairId} pairsById={pairsById} />
                </span>
              </div>
              <span className="text-sm font-semibold shrink-0" style={{ color: accentColor }}>{row.pts} pts</span>
            </div>
            <div className="text-[11px] text-teal-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={F.body}>
              <span>PJ {row.pj}</span>
              <span>PG {row.pg}</span>
              <span>PP {row.pp}</span>
              <span>Sets {row.setsF}-{row.setsC} ({ds >= 0 ? "+" : ""}{ds})</span>
              <span>Games {row.gamesF}-{row.gamesC} ({dg >= 0 ? "+" : ""}{dg})</span>
              {row.stb > 0 && <span>STB {row.stb}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Referencia chica de qué significa cada abreviatura de la tabla de posiciones */
function StandingsLegend() {
  const items = [
    ["PJ", "Partidos Jugados"], ["PG", "Partidos Ganados"], ["PP", "Partidos Perdidos"],
    ["STB", "Super Tie-Breaks Ganados"],
  ];
  return (
    <p className="text-[11px] text-teal-600 mt-4" style={F.body}>
      {items.map(([abbr, full], i) => (
        <span key={abbr}>
          <span className="text-teal-500">{abbr}</span> = {full}{i < items.length - 1 ? " · " : ""}
        </span>
      ))}
    </p>
  );
}

/* Muestra día, hora y cancha de un partido si ya tiene horario asignado */
function ScheduleLabel({ schedule }) {
  if (!schedule) return null;
  return (
    <span className="text-[11px] text-teal-500 whitespace-nowrap" style={F.body}>
      {formatDateShort(schedule.date)} · {schedule.time}hs · Cancha {schedule.court}
    </span>
  );
}

/* En un grupo de 4 (sorteo + cruce de ganadores/perdedores), indica de qué instancia es cada partido */
function groupMatchStageLabel(group, match) {
  if (group.format !== "bracket4") return null;
  const idx = group.matches.findIndex((m) => m.id === match.id);
  if (idx === 0) return "Partido 1";
  if (idx === 1) return "Partido 2";
  if (match.stage === "ganadores") return "Cruce de ganadores";
  if (match.stage === "perdedores") return "Cruce de perdedores";
  return null;
}

/* Editor de resultado set por set para un partido, según el formato configurado del torneo */
function MatchSetsEditor({ sets, format, onSetScore }) {
  const total = format?.setsToPlay ?? DEFAULT_MATCH_FORMAT.setsToPlay;
  const rows = Array.from({ length: total }, (_, i) => (sets && sets[i]) || { a: null, b: null });
  // En los formatos de set único (Americano, Súper 8) se avisa si el set cargado no puede ser un
  // resultado final, y se marca cuando se definió en tie break
  const singleSet = isSingleSetFormat(format);
  const { a: setA, b: setB } = rows[0];
  const singleSetLoaded = singleSet && setA != null && setB != null;
  const singleSetInvalid = singleSetLoaded && !singleSetIsValid(setA, setB, format.gamesPerSet);
  const tieAt = format?.gamesPerSet - 1;
  const singleSetNote = !singleSetLoaded ? null
    : singleSetInvalid ? `Revisá el resultado: el set termina cuando alguien llega a ${format.gamesPerSet} (en ${tieAt}-${tieAt} se juega tie break y queda ${format.gamesPerSet}-${tieAt}).`
    : Math.min(setA, setB) === tieAt ? "Definido en tie break" : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-2">
        {rows.map((s, i) => {
          const isTiebreak = format?.finalSuperTiebreak && i === total - 1;
          return (
            <div key={i} className="flex flex-col items-center">
              <span className="text-[10px] text-teal-500 mb-0.5" style={F.body}>
                {isTiebreak ? "STB a 10" : singleSet ? `Set a ${format.gamesPerSet}` : `Set ${i + 1}`}
              </span>
              <div className="flex items-center gap-1">
                <input
                  type="number" inputMode="numeric" pattern="[0-9]*" min="0" max={isTiebreak ? undefined : 9}
                  maxLength={isTiebreak ? 2 : 1}
                  className="w-12 h-10 px-1 rounded border text-center text-base"
                  style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                  value={s.a ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const limit = isTiebreak ? 2 : 1;
                    if (raw.length > limit) return;
                    onSetScore(i, "a", raw === "" ? null : Number(raw));
                  }}
                />
                <span className="text-xs text-teal-500">-</span>
                <input
                  type="number" inputMode="numeric" pattern="[0-9]*" min="0" max={isTiebreak ? undefined : 9}
                  maxLength={isTiebreak ? 2 : 1}
                  className="w-12 h-10 px-1 rounded border text-center text-base"
                  style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                  value={s.b ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const limit = isTiebreak ? 2 : 1;
                    if (raw.length > limit) return;
                    onSetScore(i, "b", raw === "" ? null : Number(raw));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {singleSetNote && (
        <span className={`text-[10px] text-right ${singleSetInvalid ? "text-amber-400" : "text-teal-500"}`} style={F.body}>{singleSetNote}</span>
      )}
    </div>
  );
}

/* Opción grande de elección múltiple (tipo de torneo, Individual/Por Parejas, games) */
function ChoiceCard({ selected, onClick, title, description, compact = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`text-left rounded-lg border transition ${compact ? "px-4 py-2" : "px-4 py-3"} ${selected ? "border-lime-400" : "border-teal-800 hover:border-teal-500"}`}
      style={{ backgroundColor: selected ? "rgba(159,224,34,0.1)" : "transparent", ...F.body }}
    >
      <span className={`block font-semibold ${compact ? "text-sm" : ""} ${selected ? "text-lime-400" : ""}`}>{title}</span>
      {description && <span className="block text-xs text-teal-400 mt-0.5">{description}</span>}
    </button>
  );
}

const TOURNAMENT_TYPE_DESCRIPTION = {
  clasico: "Zonas + llave final, partidos por sets y grilla de horarios.",
  super8: "8 jugadores u 8 parejas por categoría, a un solo set. Termina en tabla de posiciones.",
  americano: "Zonas + llave final en un solo día, con un set único a 7 o a 9 games.",
};

/* Paso 1: elegir el tipo de torneo. Al cambiar de tipo se limpian las opciones del anterior. */
function TournamentTypeChoice({ config, onChange }) {
  return (
    <div className="grid gap-2">
      {Object.keys(TOURNAMENT_TYPE_LABEL).map((type) => (
        <ChoiceCard
          key={type}
          selected={config.type === type}
          onClick={() => { if (config.type !== type) onChange({ type, super8Mode: null, games: null }); }}
          title={TOURNAMENT_TYPE_LABEL[type]}
          description={TOURNAMENT_TYPE_DESCRIPTION[type]}
        />
      ))}
    </div>
  );
}

/* Paso 2: las preguntas propias de cada tipo (el Clásico no tiene ninguna acá) */
function TournamentTypeOptions({ config, onChange }) {
  const label = "block text-xs text-teal-400 mb-2";
  const gamesChoice = (options, format) => (
    <div className="flex flex-wrap gap-2">
      {options.map((g) => (
        <ChoiceCard key={g} compact selected={config.games === g} onClick={() => onChange({ ...config, games: g })} title={format(g)} />
      ))}
    </div>
  );
  const tiebreakNote = config.games && (
    <p className="text-[11px] text-teal-500 mt-2" style={F.body}>
      En {config.games - 1}-{config.games - 1} se define con tie break a 7 puntos (diferencia de 2) y el set queda {config.games}-{config.games - 1}.
    </p>
  );

  if (config.type === "super8") {
    return (
      <div>
        <p className="text-sm font-semibold mb-3 px-3 py-2 rounded border border-lime-400 text-lime-400" style={{ backgroundColor: "rgba(159,224,34,0.08)", ...F.body }}>
          El Súper 8 se juega a un solo set.
        </p>
        <p className={label} style={F.body}>¿Individual o por parejas?</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-4">
          <ChoiceCard selected={config.super8Mode === "individual"} onClick={() => onChange({ ...config, super8Mode: "individual" })} title="Individual" description="8 jugadores sueltos: cada uno juega una vez con cada otro como compañero." />
          <ChoiceCard selected={config.super8Mode === "parejas"} onClick={() => onChange({ ...config, super8Mode: "parejas" })} title="Por Parejas" description="8 parejas armadas, todas contra todas." />
        </div>
        {config.super8Mode && (
          <div>
            <p className={label} style={F.body}>¿A cuántos games se juega cada partido?</p>
            {gamesChoice(SUPER8_GAMES_OPTIONS, (g) => `${g} games`)}
            {tiebreakNote}
          </div>
        )}
      </div>
    );
  }
  if (config.type === "americano") {
    return (
      <div>
        <p className={label} style={F.body}>¿A cuántos games se juega cada partido?</p>
        {gamesChoice(AMERICANO_GAMES_OPTIONS, (g) => `A${g}`)}
        {tiebreakNote}
      </div>
    );
  }
  return null;
}

/* Formato de partido del Clásico: sets, games por set y tie breaks */
function ClassicMatchFormatFields({ format, onChange }) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const [gamesText, setGamesText] = useState(String(f.gamesPerSet));
  return (
    <div className="flex flex-wrap gap-4 items-end">
      <div>
        <label className="block text-xs text-teal-400 mb-1" style={F.body}>Sets</label>
        <select
          value={f.setsToPlay}
          onChange={(e) => onChange({ ...f, setsToPlay: Number(e.target.value) })}
          className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
        >
          <option value={2}>2 sets directos</option>
          <option value={3}>Al mejor de 3</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-teal-400 mb-1" style={F.body}>Games por set</label>
        <input
          type="number" min="1" inputMode="numeric"
          value={gamesText}
          onChange={(e) => setGamesText(e.target.value)}
          onBlur={() => {
            const n = Number(gamesText);
            const valid = gamesText.trim() !== "" && n >= 1;
            const final = valid ? n : f.gamesPerSet;
            setGamesText(String(final));
            if (final !== f.gamesPerSet) onChange({ ...f, gamesPerSet: final });
          }}
          className="w-20 px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
        />
      </div>
      <label className="flex items-center gap-2 text-sm" style={F.body}>
        <input type="checkbox" checked={f.setTiebreak} onChange={(e) => onChange({ ...f, setTiebreak: e.target.checked })} />
        Tie break a 7 puntos dentro del set
      </label>
      <label className="flex items-center gap-2 text-sm" style={F.body}>
        <input type="checkbox" checked={f.finalSuperTiebreak} onChange={(e) => onChange({ ...f, finalSuperTiebreak: e.target.checked })} />
        Super tie-break a 10 en el set decisivo
      </label>
    </div>
  );
}

/* Nombre del tipo de torneo: "Clásico", "Súper 8 Individual", "Americano"... */
function tournamentTypeName(t) {
  const { type, super8Mode } = tournamentConfig(t);
  return type === "super8" && super8Mode ? `${TOURNAMENT_TYPE_LABEL.super8} ${SUPER8_MODE_LABEL[super8Mode]}` : TOURNAMENT_TYPE_LABEL[type];
}

/* Etiqueta con el tipo de torneo para las tarjetas: "Clásico", "Súper 8 Individual · 6 games",
   "Americano · A7". Cada tipo tiene su color. */
const TOURNAMENT_TYPE_COLOR = { clasico: "#38bdf8", super8: "#e879f9", americano: "#fb923c" };

function TournamentTypeTag({ tournament }) {
  const { type, games } = tournamentConfig(tournament);
  const color = TOURNAMENT_TYPE_COLOR[type];
  const detail = type === "americano" && games ? ` · A${games}` : type === "super8" && games ? ` · ${games} games` : "";
  return (
    <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide" style={{ ...F.body, color, border: `1px solid ${color}80`, backgroundColor: color + "1a" }}>
      {tournamentTypeName(tournament)}{detail}
    </span>
  );
}

/* Tipo de torneo en una línea: "Súper 8 Individual · un solo set a 6 games · ..." */
function tournamentTypeSummary(t) {
  return `${tournamentTypeName(t)} · ${formatSummary(t.matchFormat)}`;
}

/* Panel para ver y cambiar el tipo de torneo y su configuración después de creado. Los cambios se
   preparan en un borrador y se aplican con "Guardar". */
function TournamentTypeEditor({ tournament, update }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(() => tournamentConfig(tournament));
  const [classicFormat, setClassicFormat] = useState(() => (isSingleSetFormat(tournament.matchFormat) ? { ...DEFAULT_MATCH_FORMAT } : tournament.matchFormat || { ...DEFAULT_MATCH_FORMAT }));
  const blocked = tournamentConfigChangeBlocked(tournament, config);
  const hasResults = tournamentProgress(tournament).played > 0;

  const start = () => {
    setConfig(tournamentConfig(tournament));
    setClassicFormat(isSingleSetFormat(tournament.matchFormat) ? { ...DEFAULT_MATCH_FORMAT } : tournament.matchFormat || { ...DEFAULT_MATCH_FORMAT });
    setOpen(true);
  };
  const save = () => {
    if (!tournamentConfigIsComplete(config) || blocked) return;
    const next = withTournamentConfig(tournament, config);
    update(config.type === "clasico" ? { ...next, matchFormat: classicFormat } : next);
    setOpen(false);
  };

  return (
    <div className="border border-teal-800 rounded-lg p-4 mb-6">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <p className="text-sm font-semibold" style={F.body}>Tipo de torneo</p>
          <p className="text-xs text-teal-400" style={F.body}>{tournamentTypeSummary(tournament)}</p>
        </div>
        <button type="button" onClick={() => (open ? setOpen(false) : start())} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>
          {open ? "Cancelar" : "Editar"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <TournamentTypeChoice config={config} onChange={setConfig} />
          <TournamentTypeOptions config={config} onChange={setConfig} />
          {config.type === "clasico" && <ClassicMatchFormatFields format={classicFormat} onChange={setClassicFormat} />}
          {blocked && (
            <p className="text-xs text-amber-400" style={F.body}>
              Hay categorías con partidos ya armados en otro formato. Para este cambio, primero reiniciá sus grupos o partidos.
            </p>
          )}
          {!blocked && hasResults && (
            <p className="text-[11px] text-amber-400" style={F.body}>
              Ya hay resultados cargados: si cambiás el formato, esos resultados se van a leer con el formato nuevo.
            </p>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!tournamentConfigIsComplete(config) || blocked}
            className="px-4 py-2 rounded font-semibold text-sm disabled:opacity-40" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
          >
            Guardar
          </button>
        </div>
      )}
    </div>
  );
}

/* Interruptor sí/no */
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none" style={F.body}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative w-11 h-6 rounded-full shrink-0 mt-0.5 transition"
        style={{ backgroundColor: checked ? BRAND.lime : "#1e3a45", boxShadow: checked ? `0 0 10px ${BRAND.lime}66` : "none" }}
      >
        <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ left: checked ? "1.375rem" : "0.125rem" }} />
      </button>
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {description && <span className="block text-xs text-teal-400">{description}</span>}
      </span>
    </label>
  );
}

/* Inscripciones online de un torneo: el interruptor y el cupo de cada categoría (vacío = sin límite;
   el Súper 8 es siempre de 8). rows: [{ key, name, fixed, value }] */
function RegistrationSettings({ open, onOpenChange, rows, onCupoChange }) {
  return (
    <div className="rounded-lg border border-teal-800 p-3 space-y-3">
      <Toggle
        checked={open}
        onChange={onOpenChange}
        label="Inscripciones abiertas"
        description="Los jugadores se anotan solos desde la página pública y vos aceptás o rechazás cada inscripción."
      />
      {open && rows.length > 0 && (
        <div>
          <p className="text-xs text-teal-400 mb-2" style={F.body}>Cupo por categoría (cuentan todas las parejas anotadas; vacío = sin límite)</p>
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-3 text-sm" style={F.body}>
                <span className="truncate">{r.name}</span>
                {r.fixed ? (
                  <span className="text-xs text-teal-500">{r.fixed}</span>
                ) : (
                  <input
                    type="number" min="1" inputMode="numeric"
                    value={r.value}
                    onChange={(e) => onCupoChange(r.key, e.target.value)}
                    placeholder="Sin límite"
                    className="w-28 px-2 py-1.5 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* Texto del campo de cupo → número entero positivo, o null (sin límite) */
function parseCupo(text) {
  const n = Number(text);
  return String(text).trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

/* Ventana emergente centrada sobre la pantalla */
function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" style={{ backgroundColor: "rgba(0,0,0,0.7)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-xl border border-teal-800 p-5 sm:p-6 my-4"
        style={{ backgroundColor: "#1b2027", color: "#e2e8f0" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-3 mb-4">
          <h2 className="text-lg" style={F.display}>{title}</h2>
          <button type="button" onClick={onClose} className="text-teal-400 hover:text-lime-400 text-lg leading-none" aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* Creación de torneo paso a paso:
   1. Tipo de torneo (Clásico, Súper 8 o Americano).
   2. Nombre, fecha y circuito, más las preguntas propias del tipo elegido.
   3. Categorías que va a tener el torneo (después se pueden agregar o quitar desde el torneo). */
function CreateTournamentWizard({ circuits, onCreate, onClose }) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState({ type: null, super8Mode: null, games: null });
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [circuitId, setCircuitId] = useState("");
  const [categoryNames, setCategoryNames] = useState([]);
  const [categoryText, setCategoryText] = useState("");
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [cupos, setCupos] = useState({}); // { [nombre de categoría]: texto del cupo }
  // Americano: se juega en un solo día, así que la grilla se arma con estos tres datos
  const [courtsText, setCourtsText] = useState("2");
  const [startTime, setStartTime] = useState("09:00");
  const [intervalText, setIntervalText] = useState("40");
  const super8 = config.type === "super8";
  const americano = config.type === "americano";
  const courts = Number(courtsText), interval = Number(intervalText);
  const scheduleReady = !americano || (Number.isInteger(courts) && courts >= 1 && startTime && Number.isInteger(interval) && interval >= 10);

  const addCategoryName = () => {
    const n = categoryText.trim();
    if (!n) return;
    if (!categoryNames.some((c) => c.toLowerCase() === n.toLowerCase())) setCategoryNames([...categoryNames, n]);
    setCategoryText("");
  };
  const step2Ready = name.trim() && date && tournamentConfigIsComplete(config) && scheduleReady;
  // Si quedó un nombre escrito sin tocar "Agregar", también se crea
  const pending = categoryText.trim();
  const finalNames = pending && !categoryNames.some((c) => c.toLowerCase() === pending.toLowerCase()) ? [...categoryNames, pending] : categoryNames;
  const create = () => {
    if (!step2Ready || finalNames.length === 0) return;
    const schedule = americano ? { courtsCount: courts, matchDurationMinutes: interval, playDates: [{ date, from: startTime, to: "23:59" }] } : null;
    onCreate({
      name: name.trim(), date, circuitId: config.type === "clasico" ? circuitId || null : null, config, schedule,
      categories: finalNames.map((n) => ({ name: n, cupo: super8 ? null : parseCupo(cupos[n] ?? "") })),
      inscripcionesAbiertas: registrationOpen,
    });
    onClose();
  };

  const input = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };
  const primary = "px-4 py-2 rounded font-semibold text-sm disabled:opacity-40";
  const primaryStyle = { backgroundColor: "#9fe022", color: "#14181f", ...F.body };
  const back = (to) => <button type="button" onClick={() => setStep(to)} className="text-sm text-teal-400 hover:text-lime-400" style={F.body}>← Atrás</button>;

  return (
    <Modal title={`Nuevo torneo · Paso ${step} de 3`} onClose={onClose}>
      {step === 1 && (
        <div>
          <p className="text-sm text-teal-300 mb-3" style={F.body}>¿Qué tipo de torneo vas a organizar?</p>
          <TournamentTypeChoice config={config} onChange={setConfig} />
          <div className="flex justify-end mt-5">
            <button type="button" disabled={!config.type} onClick={() => setStep(2)} className={primary} style={primaryStyle}>Siguiente</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="text-xs text-lime-400 mb-3 font-semibold" style={F.body}>{TOURNAMENT_TYPE_LABEL[config.type]}</p>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del torneo</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full mb-3 px-3 py-2 rounded border outline-none focus:border-lime-400" style={input} />
          <div className="flex flex-wrap gap-3 mb-4">
            <div>
              <label className="block text-xs text-teal-400 mb-1" style={F.body}>Fecha</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={input} />
            </div>
            {config.type === "clasico" && (
              <div>
                <label className="block text-xs text-teal-400 mb-1" style={F.body}>Circuito (opcional)</label>
                <select value={circuitId} onChange={(e) => setCircuitId(e.target.value)} className="px-3 py-2 rounded border text-sm" style={input}>
                  <option value="">Sin circuito (torneo independiente)</option>
                  {circuits.map((c) => <option key={c.id} value={c.id}>{c.name} {c.year}</option>)}
                </select>
              </div>
            )}
          </div>
          <TournamentTypeOptions config={config} onChange={setConfig} />
          {americano && (
            <div className="mt-4">
              <p className="block text-xs text-teal-400 mb-2" style={F.body}>Horarios del día</p>
              <div className="flex flex-wrap gap-3">
                <div>
                  <label className="block text-[11px] text-teal-500 mb-1" style={F.body}>Canchas</label>
                  <input type="number" min="1" inputMode="numeric" value={courtsText} onChange={(e) => setCourtsText(e.target.value)} className="w-20 px-3 py-2 rounded border outline-none focus:border-lime-400" style={input} />
                </div>
                <div>
                  <label className="block text-[11px] text-teal-500 mb-1" style={F.body}>Horario de arranque</label>
                  <input type="time" lang="es-AR" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={input} />
                </div>
                <div>
                  <label className="block text-[11px] text-teal-500 mb-1" style={F.body}>Tiempo entre partidos (min)</label>
                  <input type="number" min="10" step="5" inputMode="numeric" value={intervalText} onChange={(e) => setIntervalText(e.target.value)} className="w-24 px-3 py-2 rounded border outline-none focus:border-lime-400" style={input} />
                </div>
              </div>
              <p className="text-[11px] text-teal-600 mt-2" style={F.body}>Cada cancha arranca un partido nuevo cada {interval >= 10 ? interval : "…"} minutos. Se puede ajustar después en Horarios.</p>
            </div>
          )}
          <div className="flex justify-between items-center mt-5">
            {back(1)}
            <button type="button" disabled={!step2Ready} onClick={() => setStep(3)} className={primary} style={primaryStyle}>Siguiente</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <p className="text-sm text-teal-300 mb-1" style={F.body}>¿Qué categorías va a tener el torneo?</p>
          <p className="text-xs text-teal-500 mb-3" style={F.body}>
            {super8
              ? `Cada categoría admite exactamente 8 ${config.super8Mode === "individual" ? "jugadores" : "parejas"}. `
              : ""}
            {super8 ? "Los inscriptos" : "Las parejas"} se cargan después, a medida que se anotan. Más adelante también podés agregar o quitar categorías.
          </p>
          <div className="flex gap-2 mb-3">
            <input
              value={categoryText}
              onChange={(e) => setCategoryText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addCategoryName(); }}
              placeholder="Ej: 4ta Caballeros"
              autoFocus
              className="flex-1 min-w-0 px-3 py-2 rounded border outline-none focus:border-lime-400" style={input}
            />
            <button type="button" onClick={addCategoryName} className="px-4 py-2 rounded font-semibold text-sm" style={primaryStyle}>Agregar</button>
          </div>
          <div className="flex flex-wrap gap-2 min-h-[2rem]">
            {categoryNames.map((c, i) => {
              const color = GROUP_COLORS[i % GROUP_COLORS.length];
              return (
                <span key={c} className="flex items-center gap-2 px-3 py-1 rounded-full text-sm border" style={{ backgroundColor: color + "14", color, borderColor: color + "40", ...F.body }}>
                  {c}
                  <button type="button" onClick={() => setCategoryNames(categoryNames.filter((x) => x !== c))} aria-label={`Quitar ${c}`} className="opacity-70 hover:opacity-100">✕</button>
                </span>
              );
            })}
            {categoryNames.length === 0 && <p className="text-xs opacity-60" style={F.body}>Agregá al menos una categoría.</p>}
          </div>
          <div className="mt-4">
            <RegistrationSettings
              open={registrationOpen}
              onOpenChange={setRegistrationOpen}
              rows={categoryNames.map((n) => ({ key: n, name: n, fixed: super8 ? "8 (Súper 8)" : null, value: cupos[n] ?? "" }))}
              onCupoChange={(key, text) => setCupos({ ...cupos, [key]: text })}
            />
          </div>
          <div className="flex justify-between items-center mt-5">
            {back(2)}
            <button type="button" disabled={finalNames.length === 0} onClick={create} className={primary} style={primaryStyle}>Crear torneo</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* Panel de canchas disponibles y fechas puntuales en que se juega el torneo */
function CourtsAndDatesEditor({ tournament, onChange }) {
  const [newDate, setNewDate] = useState("");
  const [newFrom, setNewFrom] = useState("09:00");
  const [newTo, setNewTo] = useState("22:00");
  const [courtsText, setCourtsText] = useState(String(tournament.courtsCount ?? 4));
  const [durationText, setDurationText] = useState(String(tournament.matchDurationMinutes ?? 90));
  const dates = tournament.playDates || [];
  const singleDay = tournamentType(tournament) === "americano"; // el Americano se juega en un solo día

  const addDate = () => {
    if (!newDate || dates.some((d) => d.date === newDate)) return;
    const next = [...dates, { date: newDate, from: newFrom, to: newTo }].sort((a, b) => (a.date < b.date ? -1 : 1));
    onChange({ ...tournament, playDates: next });
    setNewDate("");
  };
  const removeDate = (date) => onChange({ ...tournament, playDates: dates.filter((d) => d.date !== date) });
  const updateDateRange = (date, side, value) => {
    onChange({ ...tournament, playDates: dates.map((d) => (d.date === date ? { ...d, [side]: value } : d)) });
  };

  return (
    <div className="border border-teal-800 rounded-lg p-4 mb-6">
      <p className="text-sm font-semibold mb-3" style={F.body}>{singleDay ? "Canchas y horario del día" : "Canchas y fechas del torneo"}</p>
      <div className="flex flex-wrap gap-4 items-end mb-4">
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Cantidad de canchas</label>
          <input
            type="number" min="1" inputMode="numeric"
            value={courtsText}
            onChange={(e) => setCourtsText(e.target.value)}
            onBlur={() => {
              const n = Number(courtsText);
              const valid = courtsText.trim() !== "" && n >= 1;
              const final = valid ? n : (tournament.courtsCount ?? 4);
              setCourtsText(String(final));
              if (final !== tournament.courtsCount) onChange({ ...tournament, courtsCount: final });
            }}
            className="w-20 px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
          />
        </div>
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>{singleDay ? "Tiempo entre partidos (min)" : "Duración de partido (min)"}</label>
          <input
            type="number" min="10" step="5" inputMode="numeric"
            value={durationText}
            onChange={(e) => setDurationText(e.target.value)}
            onBlur={() => {
              const n = Number(durationText);
              const valid = durationText.trim() !== "" && n >= 10;
              const final = valid ? n : (tournament.matchDurationMinutes ?? 90);
              setDurationText(String(final));
              if (final !== tournament.matchDurationMinutes) onChange({ ...tournament, matchDurationMinutes: final });
            }}
            className="w-24 px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
          />
        </div>
      </div>
      <label className="block text-xs text-teal-400 mb-1" style={F.body}>{singleDay ? "Día y horario en que se juega" : "Fechas y horario en que se juega cada una"}</label>
      <div className="space-y-2 mb-4">
        {dates.map((d) => (
          <div key={d.date} className="border border-teal-800 rounded-lg px-3 py-3 text-sm" style={F.body}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-teal-200 font-medium">{formatDateShort(d.date)}</span>
              <button type="button" onClick={() => removeDate(d.date)} className="text-red-400 text-xs">Quitar ✕</button>
            </div>
            <div className="flex items-center gap-2">
              <input type="time" lang="es-AR" value={d.from} onChange={(e) => updateDateRange(d.date, "from", e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
              <span className="text-xs text-teal-500 shrink-0">a</span>
              <input type="time" lang="es-AR" value={d.to} onChange={(e) => updateDateRange(d.date, "to", e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
            </div>
          </div>
        ))}
        {dates.length === 0 && <p className="text-xs opacity-60" style={F.body}>Todavía no agregaste fechas.</p>}
      </div>
      {!(singleDay && dates.length > 0) && <div className="border-t border-teal-800 pt-3 space-y-2">
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Fecha nueva</label>
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="w-full px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Desde</label>
            <input type="time" lang="es-AR" value={newFrom} onChange={(e) => setNewFrom(e.target.value)} className="w-full px-2 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Hasta</label>
            <input type="time" lang="es-AR" value={newTo} onChange={(e) => setNewTo(e.target.value)} className="w-full px-2 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          </div>
        </div>
        <button type="button" onClick={addDate} className="w-full px-3 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
          Agregar fecha
        </button>
      </div>}
    </div>
  );
}

/* Disponibilidad de una pareja: qué fechas del torneo puede jugar y en qué rango horario cada una */
function PairAvailabilityEditor({ pair, playDates, onChange }) {
  const [open, setOpen] = useState(false);
  const availByDate = Object.fromEntries((pair.availability || []).map((a) => [a.date, a]));

  const toggleDate = (d) => {
    const current = pair.availability || [];
    if (availByDate[d.date]) {
      onChange(current.filter((a) => a.date !== d.date));
    } else {
      onChange([...current, { date: d.date, from: d.from, to: d.to }]);
    }
  };
  const updateRange = (date, side, value) => {
    onChange((pair.availability || []).map((a) => (a.date === date ? { ...a, [side]: value } : a)));
  };

  if (playDates.length === 0) {
    return <p className="text-xs opacity-50 mt-1" style={F.body}>Cargá fechas del torneo (pestaña Horarios) para definir disponibilidad.</p>;
  }

  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-teal-400 hover:text-lime-400" style={F.body}>
        {open ? "Ocultar disponibilidad" : `Disponibilidad (${(pair.availability || []).length}/${playDates.length} días)`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-teal-600" style={F.body}>
            Esta disponibilidad solo se usa para agendar los partidos de grupos. La cancha la asigna el sistema; solo elegís día y horario.
            Si no marcás ningún día, se toma como disponible todos los días del torneo.
          </p>
          {playDates.map((d) => {
            const a = availByDate[d.date];
            return (
              <div key={d.date} className="flex items-center gap-2 flex-wrap text-sm" style={F.body}>
                <label className="flex items-center gap-1 w-24">
                  <input type="checkbox" checked={!!a} onChange={() => toggleDate(d)} />
                  {formatDateShort(d.date)}
                </label>
                {a && (
                  <>
                    <input type="time" lang="es-AR" value={a.from} onChange={(e) => updateRange(d.date, "from", e.target.value)} className="px-2 py-1 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
                    <span className="text-xs text-teal-500">a</span>
                    <input type="time" lang="es-AR" value={a.to} onChange={(e) => updateRange(d.date, "to", e.target.value)} className="px-2 py-1 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Una fila editable (se usa solo para los partidos SIN horario todavía, en la bandeja de abajo de
   la planilla): permite asignar fecha, hora y cancha a mano, y también se puede arrastrar directo
   a una celda libre de la planilla. */
function ScheduleRow({ m, pairsById, playDates, courtsCount, onEdit, onClear, onToggleLive, draggable, onDragStart }) {
  const s = m.schedule;
  const hasResult = matchIsPlayed(m);
  const w = hasResult ? matchWinnerId(m) : null;
  const winnerIsA = w == null ? null : w === m.pairA;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className="flex items-center justify-between gap-3 flex-wrap border border-teal-800 rounded px-3 py-2 text-sm"
      style={{ ...F.body, cursor: draggable ? "grab" : "default" }}
    >
      <div className="min-w-[200px] max-w-full">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs text-teal-500">{m.categoryName} · {m.label}</span>
          {!m.placeholder && <MatchStatusBadge status={matchDisplayStatus(m)} />}
          {m.draft && <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ backgroundColor: "#a78bfa22", color: "#a78bfa" }}>Borrador</span>}
        </div>
        {m.placeholder ? (
          <span className="italic opacity-70">{m.placeholder}</span>
        ) : (
          <div className="leading-snug">
            <div className="flex items-center gap-1">{w === m.pairA && <WinnerCheck />}<PairName id={m.pairA} pairsById={pairsById} /></div>
            <div className="text-[11px] opacity-50 flex items-center gap-2">
              <span>vs</span>
              {hasResult && (
                <span className="font-mono not-italic opacity-100 text-teal-300"><MatchResultLabel match={m} winnerIsA={winnerIsA} /></span>
              )}
            </div>
            <div className="flex items-center gap-1">{w === m.pairB && <WinnerCheck />}<PairName id={m.pairB} pairsById={pairsById} /></div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {!m.placeholder && !hasResult && (
          <button
            type="button"
            onClick={() => onToggleLive(m.liveStatus === "en_curso" ? null : "en_curso")}
            className="text-xs px-2 py-1 rounded border"
            style={m.liveStatus === "en_curso" ? { borderColor: "#fb923c", color: "#fb923c" } : { borderColor: "#94a3b8", color: "#94a3b8" }}
          >
            {m.liveStatus === "en_curso" ? "Quitar \"en curso\"" : "Marcar en curso"}
          </button>
        )}
        <select
          value={s?.date || ""}
          onChange={(e) => onEdit({ date: e.target.value, time: s?.time || "09:00", court: s?.court || 1 })}
          className="px-2 py-1 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
        >
          <option value="">Sin asignar</option>
          {playDates.map((d) => <option key={d.date} value={d.date}>{formatDateShort(d.date)}</option>)}
        </select>
        {s?.date && (
          <>
            <input
              type="time" lang="es-AR" value={s.time}
              onChange={(e) => onEdit({ ...s, time: e.target.value })}
              className="px-2 py-1 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
            />
            <select
              value={s.court}
              onChange={(e) => onEdit({ ...s, court: Number(e.target.value) })}
              className="px-2 py-1 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
            >
              {Array.from({ length: courtsCount }, (_, i) => i + 1).map((c) => <option key={c} value={c}>Cancha {c}</option>)}
            </select>
            <button type="button" onClick={onClear} className="text-xs text-red-400">Quitar</button>
          </>
        )}
      </div>
    </div>
  );
}

/* Tarjeta chica de un partido dentro de una celda de la planilla (canchas x horarios). Arrastrable
   para moverla a otra celda; el color/borde cambia según esté finalizada, en borrador o en choque. */
function GridMatchCard({ m, pairsById, conflict, onDragStart, onClear, onResult, onMove }) {
  const status = m.placeholder ? "pendiente" : matchDisplayStatus(m);
  const finished = status === "finalizado";
  const border = conflict ? "#f87171" : m.draft ? "#a78bfa" : finished ? "#9fe022" : "#38bdf8";
  const bg = conflict ? "#f8717122" : m.draft ? "#a78bfa1a" : finished ? "#9fe0221a" : "#38bdf81a";
  return (
    <div
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      className="rounded-md px-2 py-1.5 mb-1 text-[11px] leading-tight relative"
      style={{ ...F.body, border: `1.5px ${m.draft ? "dashed" : "solid"} ${border}`, backgroundColor: bg, cursor: onDragStart ? "grab" : "default" }}
      title={conflict ? "Choque: hay más de un partido en este horario y cancha" : undefined}
    >
      <button
        type="button"
        onClick={onClear}
        className="absolute top-0.5 right-1 text-[10px] opacity-50 hover:opacity-100"
        title="Quitar horario"
      >✕</button>
      <div className="flex items-center gap-1 flex-wrap pr-3">
        <span className="text-teal-500 truncate">{m.categoryName}{m.label ? ` · ${m.label}` : ""}</span>
        {conflict && <span className="text-[9px] font-bold" style={{ color: "#f87171" }}>⚠ CHOQUE</span>}
        {m.draft && <span className="text-[9px] font-bold" style={{ color: "#a78bfa" }}>BORRADOR</span>}
        {finished && <span className="text-[9px] font-bold" style={{ color: "#9fe022" }}>✓</span>}
      </div>
      {m.placeholder ? (
        <p className="italic opacity-70 truncate">{m.placeholder}</p>
      ) : (
        <>
          <p className="truncate"><PairName id={m.pairA} pairsById={pairsById} /></p>
          <p className="truncate opacity-60">vs <PairName id={m.pairB} pairsById={pairsById} /></p>
          {onResult && (
            <button type="button" onClick={onResult} className="mt-0.5 text-[10px] underline text-teal-300 hover:text-lime-400">
              {finished ? <span className="font-mono"><MatchResultLabel match={m} winnerIsA={matchWinnerId(m) === m.pairA} /> ✎</span> : "+ Resultado"}
            </button>
          )}
        </>
      )}
      {onMove && !finished && (
        <button type="button" onClick={onMove} className="mt-0.5 ml-2 text-[10px] underline text-teal-300 hover:text-lime-400">⇄ Mover</button>
      )}
    </div>
  );
}

/* Mover un partido sin arrastrar (en el celular arrastrar no funciona): se elige día, horario y
   cancha. Si ese lugar ya tiene un partido, los dos se intercambian de lugar. */
function MoveMatchModal({ m, tournament, matches, pairsById, update, onClose }) {
  const playDates = tournament.playDates || [];
  const duration = tournament.matchDurationMinutes || 90;
  const courtsCount = tournament.courtsCount || 4;
  const [date, setDate] = useState(m.schedule?.date || playDates[0]?.date || "");
  const dateInfo = playDates.find((d) => d.date === date);
  const times = dateInfo ? dayTimeSlots(dateInfo, duration) : [];
  const [time, setTime] = useState(m.schedule?.time && times.includes(m.schedule.time) ? m.schedule.time : times[0] || "");
  const [court, setCourt] = useState(m.schedule?.court || 1);
  const occupantAt = (c) => matches.find((x) => x.key !== m.key && x.schedule && x.schedule.date === date && x.schedule.time === time && x.schedule.court === c);
  const occupant = occupantAt(court);
  const same = m.schedule && m.schedule.date === date && m.schedule.time === time && m.schedule.court === court;
  const describe = (x) => (x.placeholder ? x.placeholder : `${pairsById[x.pairA]?.name || "—"} vs ${pairsById[x.pairB]?.name || "—"}`);
  const input = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const move = () => {
    if (!date || !time || same) return;
    const target = { date, time, court };
    let next = tournament;
    if (occupant) next = withMatchSchedule(next, occupant.categoryId, occupant.location, occupant.matchId, m.schedule || null);
    next = withMatchSchedule(next, m.categoryId, m.location, m.matchId, target);
    update(next);
    onClose();
  };
  const unschedule = () => { update(withMatchSchedule(tournament, m.categoryId, m.location, m.matchId, null)); onClose(); };

  return (
    <Modal title="Mover partido" onClose={onClose}>
      <p className="text-xs text-teal-500 mb-1" style={F.body}>{m.categoryName}{m.label ? ` · ${m.label}` : ""}</p>
      <p className="text-sm mb-4" style={F.body}>{describe(m)}</p>
      {playDates.length === 0 ? (
        <p className="text-sm text-amber-400" style={F.body}>Primero cargá el día y horario del torneo en Horarios.</p>
      ) : (
        <div className="space-y-3">
          {playDates.length > 1 && (
            <div>
              <label className="block text-xs text-teal-400 mb-1" style={F.body}>Día</label>
              <select value={date} onChange={(e) => { setDate(e.target.value); const d = playDates.find((x) => x.date === e.target.value); setTime(d ? dayTimeSlots(d, duration)[0] || "" : ""); }} className="w-full px-3 py-2.5 rounded border text-base" style={input}>
                {playDates.map((d) => <option key={d.date} value={d.date}>{formatDateShort(d.date)}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Horario</label>
            <select value={time} onChange={(e) => setTime(e.target.value)} className="w-full px-3 py-2.5 rounded border text-base" style={input}>
              {times.map((t) => <option key={t} value={t}>{t}hs</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Cancha</label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {Array.from({ length: courtsCount }, (_, i) => i + 1).map((c) => (
                <ChoiceCard key={c} compact selected={court === c} onClick={() => setCourt(c)} title={`Cancha ${c}`} description={occupantAt(c) ? "Ocupada" : "Libre"} />
              ))}
            </div>
          </div>
          {occupant && !same && (
            <p className="text-xs text-amber-400" style={F.body}>
              Ahí está {describe(occupant)}: {m.schedule ? `se intercambian de lugar (ese pasa a las ${m.schedule.time}hs, Cancha ${m.schedule.court}).` : "queda sin horario."}
            </p>
          )}
          <div className="flex gap-2 flex-wrap pt-1">
            <button type="button" disabled={!time || same} onClick={move} className="flex-1 px-4 py-2.5 rounded font-semibold text-sm disabled:opacity-40" style={{ backgroundColor: "#9fe022", color: "#14181f", ...F.body }}>
              {occupant && !same ? "Intercambiar" : "Mover acá"}
            </button>
            {m.schedule && (
              <button type="button" onClick={unschedule} className="px-4 py-2.5 rounded text-sm border border-red-400 text-red-400" style={F.body}>Quitar horario</button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* Ventanita para cargar el resultado de un partido desde la grilla de horarios */
function MatchResultModal({ m, pairsById, format, onSetScore, onWalkover, onClose }) {
  const nameA = pairsById[m.pairA]?.name || "—", nameB = pairsById[m.pairB]?.name || "—";
  return (
    <Modal title="Resultado" onClose={onClose}>
      <p className="text-xs text-teal-500 mb-2" style={F.body}>{m.categoryName}{m.label ? ` · ${m.label}` : ""}</p>
      <p className="text-sm mb-4" style={F.body}>{nameA} <span className="text-teal-500">vs</span> {nameB}</p>
      {m.walkover ? (
        <p className="text-sm text-amber-400 mb-3" style={F.body}>WO: no se presentó {m.walkover === m.pairA ? nameA : nameB}.</p>
      ) : (
        <div className="flex justify-start mb-3"><MatchSetsEditor sets={m.sets} format={format} onSetScore={onSetScore} /></div>
      )}
      <div className="flex gap-3 flex-wrap text-xs mb-5" style={F.body}>
        {m.walkover ? (
          <button type="button" onClick={() => onWalkover(null)} className="text-teal-400 underline">Deshacer WO</button>
        ) : (
          <>
            <button type="button" onClick={() => onWalkover(m.pairA)} className="text-amber-400 underline">WO {nameA}</button>
            <button type="button" onClick={() => onWalkover(m.pairB)} className="text-amber-400 underline">WO {nameB}</button>
          </>
        )}
      </div>
      <button type="button" onClick={onClose} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f", ...F.body }}>Listo</button>
    </Modal>
  );
}

/* Resultado, WO y "en curso" de un partido de la grilla, y ventanas de resultado y mover: lo que
   comparten la grilla de horarios y la pantalla "En cancha". */
function useMatchActions(tournament, update) {
  const pairsById = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c) => Object.assign(map, categoryEntitiesById(c)));
    return map;
  }, [tournament.categories]);
  const matches = useMemo(() => collectScheduleableMatches(tournament), [tournament]);
  const [resultKey, setResultKey] = useState(null);
  const [moveKey, setMoveKey] = useState(null);
  const resultMatch = resultKey ? matches.find((m) => m.key === resultKey) : null;
  const moveMatch = moveKey ? matches.find((m) => m.key === moveKey) : null;

  const change = (m, fn) => update(withMatchResult(tournament, m.categoryId, m.location, m.matchId, fn));
  const setLive = (m, liveStatus) => update(withMatchLiveStatus(tournament, m.categoryId, m.location, m.matchId, liveStatus));

  const modals = (
    <>
      {resultMatch && !resultMatch.placeholder && (
        <MatchResultModal
          m={resultMatch}
          pairsById={pairsById}
          format={tournament.matchFormat}
          onSetScore={(setIndex, side, value) => change(resultMatch, (x) => ({ ...x, sets: withSetScore(x.sets, setIndex, side, value) }))}
          onWalkover={(pairId) => change(resultMatch, (x) => ({ ...x, walkover: pairId, sets: pairId ? [] : x.sets, liveStatus: null }))}
          onClose={() => setResultKey(null)}
        />
      )}
      {moveMatch && <MoveMatchModal m={moveMatch} tournament={tournament} matches={matches} pairsById={pairsById} update={update} onClose={() => setMoveKey(null)} />}
    </>
  );
  return { pairsById, matches, openResult: (m) => setResultKey(m.key), openMove: (m) => setMoveKey(m.key), setLive, modals };
}

/* Pantalla "En cancha", pensada para usar desde el celular durante el torneo: lo que se está
   jugando ahora, los próximos partidos en orden y los terminados, con botones grandes para
   marcar "en curso", cargar el resultado o mover el partido de horario/cancha. */
function OnCourtView({ tournament, update }) {
  const { pairsById, matches, openResult, openMove, setLive, modals } = useMatchActions(tournament, update);
  const [showAllNext, setShowAllNext] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const real = matches.filter((m) => !m.draft || m.schedule);
  const done = real.filter((m) => !m.placeholder && matchIsPlayed(m)).filter((m) => m.schedule).sort(compareBySchedule).reverse();
  const live = real.filter((m) => !m.placeholder && !matchIsPlayed(m) && m.liveStatus === "en_curso")
    .sort((a, b) => (a.schedule?.court || 99) - (b.schedule?.court || 99));
  const upcoming = real.filter((m) => m.schedule && !matchIsPlayed(m) && m.liveStatus !== "en_curso").sort(compareBySchedule);
  const unscheduled = real.filter((m) => !m.schedule && !m.placeholder && !matchIsPlayed(m));
  const shownNext = showAllNext ? upcoming : upcoming.slice(0, 8);

  const card = (m, kind) => {
    const hasResult = !m.placeholder && matchIsPlayed(m);
    const w = hasResult ? matchWinnerId(m) : null;
    const name = (id) => <span className={w === id ? "text-lime-400 font-semibold" : ""}>{pairsById[id]?.name || "—"}</span>;
    const accent = kind === "live" ? "#fb923c" : kind === "done" ? "#9fe022" : "#38bdf8";
    const btn = "flex-1 min-w-[6.5rem] px-3 py-2.5 rounded-lg text-sm font-semibold";
    return (
      <div key={m.key} className="rounded-xl p-3" style={{ backgroundColor: accent + "0f", border: `1px solid ${accent}40`, borderLeft: `4px solid ${accent}`, ...F.body }}>
        <div className="flex items-center gap-2 text-xs mb-1 flex-wrap">
          {m.schedule
            ? <span className="font-bold" style={{ color: accent }}>{m.schedule.time}hs · Cancha {m.schedule.court}</span>
            : <span className="font-bold text-amber-400">Sin horario</span>}
          <span className="text-teal-500 truncate">{m.categoryName}{m.label ? ` · ${m.label}` : ""}</span>
          {m.schedule && (tournament.playDates || []).length > 1 && <span className="text-teal-600">{formatDateShort(m.schedule.date)}</span>}
        </div>
        {m.placeholder ? (
          <p className="italic opacity-70 text-sm mb-2">{m.placeholder}</p>
        ) : (
          <p className="text-base leading-snug mb-2">{name(m.pairA)} <span className="text-xs text-teal-500">vs</span> {name(m.pairB)}</p>
        )}
        {hasResult && <p className="font-mono text-sm text-teal-300 mb-2"><MatchResultLabel match={m} winnerIsA={w === m.pairA} /></p>}
        <div className="flex gap-2 flex-wrap">
          {!m.placeholder && !hasResult && (kind === "live" ? (
            <button type="button" onClick={() => setLive(m, null)} className={`${btn} border border-orange-400 text-orange-300`}>Quitar en curso</button>
          ) : (
            <button type="button" onClick={() => setLive(m, "en_curso")} className={`${btn} border border-orange-400 text-orange-300`}>En curso</button>
          ))}
          {!m.placeholder && (
            <button type="button" onClick={() => openResult(m)} className={btn} style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
              {hasResult ? "Editar resultado" : "Cargar resultado"}
            </button>
          )}
          {!hasResult && <button type="button" onClick={() => openMove(m)} className={`${btn} border border-teal-600 text-teal-300`}>Mover</button>}
        </div>
      </div>
    );
  };

  const section = (title, count, color) => (
    <h3 className="text-xs uppercase tracking-wide font-bold mb-2 mt-6 first:mt-0" style={{ color, ...F.body }}>{title} ({count})</h3>
  );

  if (real.length === 0) {
    return <p className="opacity-60 text-sm" style={F.body}>Todavía no hay partidos armados. Cargá los grupos en cada categoría.</p>;
  }

  return (
    <div>
      {modals}
      {section("Jugando ahora", live.length, "#fb923c")}
      {live.length === 0
        ? <p className="text-sm opacity-60" style={F.body}>Ningún partido marcado "en curso".</p>
        : <div className="space-y-3">{live.map((m) => card(m, "live"))}</div>}

      {section("Próximos", upcoming.length, "#38bdf8")}
      {upcoming.length === 0
        ? <p className="text-sm opacity-60" style={F.body}>No quedan partidos con horario por jugar.</p>
        : <div className="space-y-3">{shownNext.map((m) => card(m, "next"))}</div>}
      {upcoming.length > shownNext.length && (
        <button type="button" onClick={() => setShowAllNext(true)} className="mt-3 text-sm text-teal-300 underline" style={F.body}>Ver los {upcoming.length} próximos</button>
      )}

      {unscheduled.length > 0 && (
        <>
          {section("Sin horario", unscheduled.length, "#fbbf24")}
          <div className="space-y-3">{unscheduled.map((m) => card(m, "next"))}</div>
        </>
      )}

      {section("Terminados", done.length, "#9fe022")}
      {done.length > 0 && (
        showDone
          ? <div className="space-y-3">{done.map((m) => card(m, "done"))}</div>
          : <button type="button" onClick={() => setShowDone(true)} className="text-sm text-teal-300 underline" style={F.body}>Ver terminados</button>
      )}
    </div>
  );
}

/* Grilla completa de horarios (admin): planilla tipo canchas x horarios con arrastrar y soltar.
   Reemplaza la vieja lista: bloquea/reubica automáticamente los choques de cancha y marca visualmente
   los partidos finalizados, ya que no queda un orden lineal como en una lista. */
function ScheduleAdminView({ tournament, update }) {
  const [notice, setNotice] = useState(null);
  // Resultado y mover se hacen en ventanitas (sirven también en el celular, donde arrastrar no anda)
  const { pairsById, matches, openResult, openMove, modals } = useMatchActions(tournament, update);
  const scheduled = matches.filter((m) => m.schedule);
  const unscheduled = matches.filter((m) => !m.schedule);
  const duration = tournament.matchDurationMinutes || 90;
  const courtsCount = tournament.courtsCount || 4;
  const playDates = tournament.playDates || [];

  const editSchedule = (m, schedule) => { update(withMatchSchedule(tournament, m.categoryId, m.location, m.matchId, schedule)); };
  const clearSchedule = (m) => { update(withMatchSchedule(tournament, m.categoryId, m.location, m.matchId, null)); setNotice(null); };
  const toggleLiveStatus = (m, liveStatus) => update(withMatchLiveStatus(tournament, m.categoryId, m.location, m.matchId, liveStatus));

  const [confirmingReschedule, setConfirmingReschedule] = useState(false);
  const reschedule = () => { update(rescheduleTournament(tournament)); setConfirmingReschedule(false); setNotice(null); };

  // Partidos con un horario que ya no entra en la grilla (por ejemplo porque cambió el horario de
  // arranque, la duración o la cantidad de canchas): no se ven en ninguna celda
  const gridSlots = new Set();
  playDates.forEach((d) => {
    dayTimeSlots(d, duration).forEach((time) => {
      for (let c = 1; c <= courtsCount; c++) gridSlots.add(`${d.date}|${time}|${c}`);
    });
  });
  const offGrid = scheduled.filter((m) => !matchIsPlayed(m) && m.liveStatus !== "en_curso" && !gridSlots.has(`${m.schedule.date}|${m.schedule.time}|${m.schedule.court}`));

  const draftCategories = tournament.categories.filter((c) => c.bracket && !c.bracketPublished && (c.bracket || []).some((round) => round.some((m) => m.pairA && m.pairB && m.schedule)));

  const onDragStartMatch = (key) => (e) => { e.dataTransfer.setData("text/plain", key); };

  const onDropOnCell = (dateInfo, time, court) => (e) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/plain");
    const m = matches.find((mm) => mm.key === key);
    if (!m) return;
    const occupants = matchesAtSlot(scheduled, dateInfo.date, time, court, key);
    if (occupants.length > 0) {
      const nextTime = minutesToTime(timeToMinutes(time) + duration);
      const free = findNextFreeSlotOnCourt(scheduled, dateInfo, court, nextTime, duration, key);
      if (free) {
        editSchedule(m, free);
        setNotice(`Ese horario ya estaba ocupado en Cancha ${court}. Ubiqué el partido en ${formatDateShort(free.date)} · ${free.time}hs · Cancha ${free.court}.`);
      } else {
        setNotice(`Cancha ${court} ya está ocupada a esa hora y no quedan horarios libres en esa cancha para ese día. No se movió el partido.`);
      }
    } else {
      editSchedule(m, { date: dateInfo.date, time, court });
      setNotice(null);
    }
  };

  const onDropOnTray = (e) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/plain");
    const m = matches.find((mm) => mm.key === key);
    if (m) clearSchedule(m);
  };

  return (
    <div>
      {modals}
      <CourtsAndDatesEditor tournament={tournament} onChange={update} />

      {matches.length === 0 ? (
        <p className="opacity-60 text-sm" style={F.body}>Todavía no hay partidos con ambas parejas definidas (cargá grupos o llave en alguna categoría).</p>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              type="button"
              onClick={() => update(autoSchedule(tournament))}
              disabled={playDates.length === 0}
              className="px-4 py-2 rounded font-semibold text-sm disabled:opacity-40" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
            >
              Generar horarios automáticamente
            </button>
            {scheduled.length > 0 && (confirmingReschedule ? (
              <span className="text-xs" style={F.body}>
                <span className="text-teal-300 mr-2">Se borran los horarios de los partidos que no se jugaron y se vuelven a asignar. ¿Confirmás?</span>
                <button type="button" onClick={reschedule} className="text-lime-400 font-semibold mr-2">Sí, rearmar</button>
                <button type="button" onClick={() => setConfirmingReschedule(false)} className="text-teal-400">Cancelar</button>
              </span>
            ) : (
              <button type="button" disabled={playDates.length === 0} onClick={() => setConfirmingReschedule(true)} className="px-4 py-2 rounded font-semibold text-sm border border-lime-400 text-lime-400 disabled:opacity-40" style={F.body}>
                Rearmar horarios
              </button>
            ))}
          </div>
          <p className="text-xs text-teal-500 mt-2 mb-3" style={F.body}>
            "Generar" solo completa los partidos de grupos sin horario (y se repite solo apenas se cierra un grupo). "Rearmar" vuelve a ubicar desde cero todos los que todavía no se jugaron, incluida la llave: usalo si cambiaste el horario de arranque, las canchas o el tiempo entre partidos. Arrastrá las tarjetas para reubicarlas.
          </p>
          {offGrid.length > 0 && (
            <div className="mb-4 px-3 py-2 rounded text-xs border" style={{ ...F.body, borderColor: "#fb923c60", backgroundColor: "#fb923c14", color: "#fb923c" }}>
              {offGrid.length === 1 ? "Hay 1 partido" : `Hay ${offGrid.length} partidos`} con un horario que ya no entra en la grilla (cambió el horario, las canchas o la duración). Tocá "Rearmar horarios" para volver a ubicarlos.
            </div>
          )}

          {draftCategories.length > 0 && (
            <div className="mb-4 flex flex-col gap-2">
              {draftCategories.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 rounded border" style={{ borderColor: "#a78bfa60", backgroundColor: "#a78bfa14" }}>
                  <span className="text-xs" style={{ ...F.body, color: "#a78bfa" }}>
                    La llave de <strong>{c.name}</strong> tiene horarios en borrador, todavía no visibles para los jugadores.
                  </span>
                  <button
                    type="button"
                    onClick={() => update(publishBracketSchedule(tournament, c.id))}
                    className="text-xs font-semibold px-3 py-1.5 rounded"
                    style={{ backgroundColor: "#a78bfa", color: "#14181f" }}
                  >
                    Publicar horarios de la llave
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-3 mb-4 text-[11px]" style={F.body}>
            {[["#38bdf8", "Fase de grupos", false], ["#a78bfa", "Llave (borrador)", true], ["#9fe022", "Finalizado", false], ["#f87171", "Choque", false]].map(([color, label, dashed]) => (
              <span key={label} className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`, backgroundColor: color + "22" }} />
                {label}
              </span>
            ))}
          </div>

          {notice && (
            <div className="mb-4 px-3 py-2 rounded text-xs border" style={{ ...F.body, borderColor: "#fb923c60", backgroundColor: "#fb923c14", color: "#fb923c" }}>
              {notice}
            </div>
          )}

          {playDates.length === 0 ? (
            <p className="opacity-60 text-sm mb-6" style={F.body}>Cargá al menos una fecha arriba para poder armar la planilla.</p>
          ) : (
            playDates.map((dateInfo, di) => {
              const dateColor = GROUP_COLORS[di % GROUP_COLORS.length];
              const times = dayTimeSlots(dateInfo, duration);
              const courts = Array.from({ length: courtsCount }, (_, i) => i + 1);
              return (
                <div key={dateInfo.date} className="mb-8">
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <SkewPill color={dateColor}>{formatDateShort(dateInfo.date)}</SkewPill>
                  </div>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="border-collapse w-full min-w-[560px]">
                      <thead>
                        <tr>
                          <th className="text-left text-[11px] text-teal-500 pb-1 pr-2 w-16" style={F.body}>Hora</th>
                          {courts.map((court) => (
                            <th key={court} className="text-center text-[11px] font-extrabold uppercase tracking-wide px-1 pb-1" style={{ ...F.body, color: dateColor }}>
                              Cancha {court}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {times.map((time) => (
                          <tr key={time}>
                            <td className="text-[11px] text-teal-500 align-top pt-2 pr-2 whitespace-nowrap" style={F.body}>{time}</td>
                            {courts.map((court) => {
                              const cellMatches = matchesAtSlot(scheduled, dateInfo.date, time, court, null);
                              const conflict = cellMatches.length > 1;
                              return (
                                <td
                                  key={court}
                                  onDragOver={(e) => e.preventDefault()}
                                  onDrop={onDropOnCell(dateInfo, time, court)}
                                  className="align-top p-1 border"
                                  style={{ borderColor: dateColor + "22", minWidth: 130 }}
                                >
                                  {cellMatches.length === 0 ? (
                                    <select
                                      value=""
                                      onChange={(e) => { const m = unscheduled.find((u) => u.key === e.target.value); if (m) editSchedule(m, { date: dateInfo.date, time, court }); }}
                                      className="w-full text-[10px] px-1 py-1.5 rounded border border-dashed opacity-60"
                                      style={{ backgroundColor: "transparent", borderColor: dateColor + "60", color: "#94a3b8" }}
                                    >
                                      <option value="">+ Asignar partido</option>
                                      {unscheduled.map((u) => <option key={u.key} value={u.key}>{u.categoryName} · {u.label}</option>)}
                                    </select>
                                  ) : (
                                    cellMatches.map((m) => (
                                      <GridMatchCard key={m.key} m={m} pairsById={pairsById} conflict={conflict} onDragStart={onDragStartMatch(m.key)} onClear={() => clearSchedule(m)} onResult={() => openResult(m)} onMove={() => openMove(m)} />
                                    ))
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* En el celular: cancha por cancha, en una columna (la tabla no entra a lo ancho) */}
                  <div className="sm:hidden space-y-4">
                    {courts.map((court) => {
                      const courtMatches = scheduled.filter((m) => m.schedule.date === dateInfo.date && m.schedule.court === court).sort(compareBySchedule);
                      return (
                        <div key={court} className="rounded-xl border p-3" style={{ borderColor: dateColor + "40" }}>
                          <p className="text-xs font-extrabold uppercase tracking-wide mb-2" style={{ ...F.body, color: dateColor }}>Cancha {court}</p>
                          {courtMatches.length === 0 && <p className="text-xs opacity-60 mb-2" style={F.body}>Sin partidos.</p>}
                          {courtMatches.map((m) => (
                            <div key={m.key} className="flex gap-2 items-start">
                              <span className="text-xs font-bold w-11 shrink-0 pt-1.5" style={{ ...F.body, color: dateColor }}>{m.schedule.time}</span>
                              <div className="flex-1 min-w-0">
                                <GridMatchCard m={m} pairsById={pairsById} conflict={matchesAtSlot(scheduled, m.schedule.date, m.schedule.time, court, null).length > 1} onClear={() => clearSchedule(m)} onResult={() => openResult(m)} onMove={() => openMove(m)} />
                              </div>
                            </div>
                          ))}
                          {unscheduled.length > 0 && (
                            <select
                              value=""
                              onChange={(e) => {
                                const m = unscheduled.find((u) => u.key === e.target.value);
                                const free = m && findNextFreeSlotOnCourt(scheduled, dateInfo, court, dateInfo.from, duration, null);
                                if (free) editSchedule(m, free);
                                else if (m) setNotice(`Cancha ${court} no tiene horarios libres ese día.`);
                              }}
                              className="w-full mt-1 text-sm px-2 py-2 rounded border border-dashed"
                              style={{ backgroundColor: "transparent", borderColor: dateColor + "60", color: "#94a3b8" }}
                            >
                              <option value="">+ Agregar partido en el primer horario libre</option>
                              {unscheduled.map((u) => <option key={u.key} value={u.key}>{u.categoryName} · {u.label}</option>)}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}

          {unscheduled.length > 0 && (
            <div onDragOver={(e) => e.preventDefault()} onDrop={onDropOnTray}>
              <h3 className="text-sm font-semibold text-teal-300 mb-2" style={F.body}>Sin horario asignado ({unscheduled.length}) · arrastrá una celda libre de arriba, o soltá acá una tarjeta para quitarle el horario</h3>
              <div className="space-y-2">
                {unscheduled.map((m) => (
                  <ScheduleRow key={m.key} m={m} pairsById={pairsById} playDates={playDates} courtsCount={courtsCount}
                    draggable onDragStart={onDragStartMatch(m.key)}
                    onEdit={(s) => editSchedule(m, s)} onClear={() => clearSchedule(m)} onToggleLive={(ls) => toggleLiveStatus(m, ls)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Horarios en modo lectura para la vista pública: una lista compacta por día y horario, dos
   renglones por partido ("C1 · Gómez - Ibáñez vs Rossi - Peralta · 6-3 6-3" y debajo la
   categoría), con un botón "Ahora" que lleva al horario que se está jugando. */
function SchedulePublicView({ tournament }) {
  const pairsById = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c) => Object.assign(map, categoryEntitiesById(c)));
    return map;
  }, [tournament.categories]);

  const categoryColor = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c, ci) => { map[c.id] = GROUP_COLORS[ci % GROUP_COLORS.length]; });
    return map;
  }, [tournament.categories]);

  const scheduled = useMemo(() => collectScheduleableMatches(tournament).filter((m) => m.schedule && !m.draft).sort(compareBySchedule), [tournament]);

  if (scheduled.length === 0) {
    return <p className="opacity-60 text-sm" style={F.body}>Todavía no hay horarios publicados para este torneo.</p>;
  }

  const slotId = (m) => `slot-${m.schedule.date}-${m.schedule.time.replace(":", "")}`;
  // "Ahora": el horario de un partido en curso; si no hay, el primero sin terminar de hoy (o de más adelante)
  const today = todayISO();
  const pending = scheduled.filter((m) => !m.placeholder && !matchIsPlayed(m));
  const nowMatch = scheduled.find((m) => m.liveStatus === "en_curso" && !matchIsPlayed(m))
    || pending.find((m) => m.schedule.date >= today)
    || pending[0];
  const goToNow = () => { if (nowMatch) document.getElementById(slotId(nowMatch))?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  const byDate = {};
  scheduled.forEach((m) => { (byDate[m.schedule.date] = byDate[m.schedule.date] || []).push(m); });

  return (
    <div>
      {nowMatch && (
        <button type="button" onClick={goToNow} className="mb-4 px-4 py-2 rounded-full text-sm font-semibold" style={{ backgroundColor: "#fb923c", color: "#14181f", ...F.body }}>
          ● Ahora
        </button>
      )}
      {Object.keys(byDate).sort().map((date, di) => {
        const dateColor = GROUP_COLORS[di % GROUP_COLORS.length];
        const byTime = {};
        byDate[date].forEach((m) => { (byTime[m.schedule.time] = byTime[m.schedule.time] || []).push(m); });
        return (
          <div key={date} className="mb-6">
            <div className="mb-2"><SkewPill color={dateColor}>{formatDateShort(date)}</SkewPill></div>
            <div className="rounded-xl border divide-y min-w-0" style={{ borderColor: dateColor + "40" }}>
              {Object.keys(byTime).sort().map((time) => (
                <div key={time} id={slotId(byTime[time][0])} className="flex gap-3 px-3 py-2 scroll-mt-4" style={{ borderColor: dateColor + "22" }}>
                  <span className="text-sm font-extrabold w-11 shrink-0 pt-0.5" style={{ color: dateColor, ...F.body }}>{time}</span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {byTime[time].map((m) => {
                      const hasResult = !m.placeholder && matchIsPlayed(m);
                      const w = hasResult ? matchWinnerId(m) : null;
                      const live = !hasResult && m.liveStatus === "en_curso";
                      const name = (id) => <span className={w === id ? "text-lime-400 font-semibold" : ""}>{pairsById[id]?.name || "—"}</span>;
                      return (
                        <div key={m.key} className="text-sm min-w-0" style={F.body}>
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="text-[11px] font-bold shrink-0" style={{ color: dateColor }}>C{m.schedule.court}</span>
                            {m.placeholder
                              ? <span className="italic opacity-70 truncate">{m.placeholder}</span>
                              : <span className="min-w-0">{name(m.pairA)} <span className="text-xs text-teal-500">vs</span> {name(m.pairB)}</span>}
                            {hasResult && <span className="font-mono text-xs text-teal-300 shrink-0 ml-auto"><MatchResultLabel match={m} winnerIsA={w === m.pairA} /></span>}
                            {live && <span className="text-[10px] font-bold shrink-0 ml-auto" style={{ color: "#fb923c" }}>● EN CURSO</span>}
                          </div>
                          <div className="text-[10px] truncate pl-7" style={{ color: categoryColor[m.categoryId] }}>
                            {m.categoryName}{m.label ? <span className="text-teal-500"> · {m.label}</span> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Vista pública: lista de torneos ---------- */

/* Tabla pública de un circuito: pestañas por categoría con el ranking de jugadores */
function CircuitPublicCard({ circuit, tournaments, accentColor = "#9fe022" }) {
  const [cat, setCat] = useState(circuit.categoryNames[0] || "");
  const standings = useMemo(() => computeCircuitStandings(circuit, tournaments), [circuit, tournaments]);
  const fechas = tournaments.filter((t) => t.circuitId === circuit.id).length;

  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: accentColor + "0d", border: `1px solid ${accentColor}33`, borderTop: `3px solid ${accentColor}` }}>
      <p className="font-semibold" style={F.body}>🏆 {circuit.name} <span className="text-teal-500 text-sm font-normal">· {circuit.year}</span></p>
      <p className="text-xs text-teal-500 mb-3" style={F.body}>{fechas} fecha{fechas !== 1 ? "s" : ""} disputada{fechas !== 1 ? "s" : ""}</p>

      {circuit.categoryNames.length > 1 && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {circuit.categoryNames.map((cn, cni) => {
            const color = GROUP_COLORS[cni % GROUP_COLORS.length];
            return (
              <button
                key={cn}
                onClick={() => setCat(cn)}
                className="px-3 py-1 rounded-full text-xs border font-medium"
                style={cat === cn ? { backgroundColor: color, color: "#14181f", borderColor: color } : { backgroundColor: color + "14", color, borderColor: color + "40" }}
              >
                {cn}
              </button>
            );
          })}
        </div>
      )}

      {(standings[cat] || []).length === 0 ? (
        <p className="text-xs opacity-60" style={F.body}>Todavía no hay puntos cargados en esta categoría.</p>
      ) : (
        <table className="w-full text-sm" style={F.body}>
          <thead><tr className="text-left" style={{ color: accentColor }}><th className="py-1">#</th><th>Jugador</th><th>Fechas</th><th>Pts</th></tr></thead>
          <tbody>
            {standings[cat].map((row, i) => (
              <tr key={row.name} style={{ backgroundColor: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.03)", borderLeft: i < 3 ? `3px solid ${accentColor}` : "3px solid transparent" }}>
                <td className="py-1 pl-1">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</td>
                <td className={i < 3 ? "font-semibold" : ""}>{row.name}</td><td>{row.fechas}</td><td className="font-semibold">{row.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* Todos los circuitos activos, agrupados por el organizador que los creó */
function CircuitsPublicView({ circuits, tournaments, organizers, ads }) {
  const byOrganizer = {};
  circuits.forEach((c) => { (byOrganizer[c.organizerId] = byOrganizer[c.organizerId] || []).push(c); });

  if (circuits.length === 0) {
    return (
      <div className="px-6 pb-10">
        <p className="opacity-60 text-sm" style={F.body}>Todavía no hay circuitos cargados.</p>
      </div>
    );
  }

  return (
    <div className="px-6 pb-10 space-y-8">
      {Object.entries(byOrganizer).map(([organizerId, list]) => {
        const organizer = organizers.find((o) => o.id === organizerId);
        return (
          <div key={organizerId}>
            <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>{organizer?.name || "Organizador"}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((c, ci) => <CircuitPublicCard key={c.id} circuit={c} tournaments={tournaments} accentColor={GROUP_COLORS[ci % GROUP_COLORS.length]} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Pantalla de inicio ---------- */

function PeopleIcon({ size = 18, color = BRAND.lime }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <circle cx="12" cy="7.5" r="3.5" /><circle cx="5" cy="9" r="2.5" /><circle cx="19" cy="9" r="2.5" />
      <path d="M12 12.5c-3.6 0-6 2-6 4.5V19h12v-2c0-2.5-2.4-4.5-6-4.5zM5 13c-2.4 0-4 1.4-4 3.3V18h3.5v-1c0-1.5.6-2.9 1.7-3.9A5 5 0 0 0 5 13zm14 0c-.4 0-.8 0-1.2.1a5.3 5.3 0 0 1 1.7 3.9v1H23v-1.7C23 14.4 21.4 13 19 13z" />
    </svg>
  );
}

function TrophyIcon({ size = 16, color = BRAND.lime }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V17h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V5h3V3zm0 4H6v1a2 2 0 0 0 1 1.7V7zm10 0v2.7A2 2 0 0 0 18 8V7h-1z" />
    </svg>
  );
}

function ChevronCircle({ color }) {
  return (
    <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ ...neonStyle(color), backgroundColor: "rgba(8,18,24,0.6)" }} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
    </span>
  );
}

/* Encabezado de la app: logo grande y el acceso de organizadores con borde de neón */
function SiteHeader({ onGoLogin }) {
  return (
    <header className="px-4 sm:px-6 py-4 flex items-center justify-between gap-3 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 min-w-0">
        <Logo size={38} />
        <div className="min-w-0">
          <p className="leading-none text-[15px] sm:text-xl whitespace-nowrap" style={{ ...F.display, color: BRAND.logoLime }}>SMASH POINT</p>
          <p className="text-[8px] sm:text-[10px] mt-1 whitespace-nowrap tracking-[2px] sm:tracking-[3px]" style={{ ...F.body, color: BRAND.logoLime }}>EVENTOS DE PADEL</p>
        </div>
      </div>
      <button
        onClick={onGoLogin}
        className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-full text-xs sm:text-sm font-semibold shrink-0 transition hover:brightness-125"
        style={{ ...F.body, ...neonStyle(BRAND.cyan), backgroundColor: "rgba(8,18,24,0.7)", color: BRAND.ink }}
      >
        <PeopleIcon /> Organizadores
      </button>
    </header>
  );
}

/* Números de la portada, calculados con los datos reales: torneos que no terminaron, jugadores
   anotados en ellos y partidos con horario para hoy */
function homeStats(tournaments) {
  const active = tournaments.filter((t) => t.status !== STATUS.FINALIZADO);
  const players = active.reduce((sum, t) => sum + t.categories.reduce((s, c) => s + c.pairs.length * (c.format === "super8_individual" ? 1 : 2), 0), 0);
  const today = todayISO();
  const matchesToday = tournaments.reduce((sum, t) => sum + collectScheduleableMatches(t).filter((m) => m.schedule && m.schedule.date === today && !m.draft).length, 0);
  return { active: active.length, players, matchesToday };
}

function HomeHero({ tournaments }) {
  const stats = useMemo(() => homeStats(tournaments), [tournaments]);
  const items = [
    [<TrophyIcon size={22} />, stats.active, stats.active === 1 ? "Torneo activo" : "Torneos activos"],
    [<PeopleIcon size={22} />, stats.players, "Jugadores"],
    [<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={BRAND.lime} strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M5.5 6.5c3 2.5 3 8.5 0 11M18.5 6.5c-3 2.5-3 8.5 0 11" /></svg>, stats.matchesToday, "Partidos hoy"],
  ];
  return (
    <section className="relative overflow-hidden" style={{ borderTop: `1px solid ${BRAND.cyan}33`, borderBottom: `1px solid ${BRAND.cyan}33` }}>
      {/* El jugador está a la izquierda de la foto y abajo a la izquierda trae texto propio: en el
          celular el texto va abajo (tapando ese texto) y en la compu va a la derecha, sobre la reja */}
      <img src={portadaUrl} alt="" className="absolute inset-0 w-full h-full object-cover object-[25%_15%] sm:object-[20%_30%]" />
      <div className="absolute inset-0 sm:hidden" style={{ background: "linear-gradient(0deg, rgba(8,18,24,1) 0%, rgba(8,18,24,0.96) 34%, rgba(8,18,24,0.35) 58%, rgba(8,18,24,0.15) 80%, rgba(8,18,24,0.55) 100%)" }} />
      <div className="absolute inset-0 hidden sm:block" style={{ background: "linear-gradient(270deg, rgba(8,18,24,0.95) 0%, rgba(8,18,24,0.8) 42%, rgba(8,18,24,0.1) 70%), linear-gradient(0deg, rgba(8,18,24,0.97) 0%, rgba(8,18,24,0.6) 22%, transparent 45%)" }} />
      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-5 pb-6 sm:py-14 flex flex-col-reverse sm:flex-row sm:items-center justify-between sm:justify-end gap-4 sm:gap-8 min-h-[420px] sm:min-h-[380px]">
        <div className="min-w-0 max-w-md sm:text-right mt-auto sm:mt-0">
          <div className="flex items-center gap-2 mb-3 sm:justify-end">
            <Logo size={56} />
            <span className="leading-[0.85] text-3xl sm:text-5xl" style={{ ...F.display, color: BRAND.ink, fontStyle: "italic" }}>SMASH<br />POINT</span>
          </div>
          <p className="text-lg sm:text-2xl leading-snug" style={{ ...F.body, color: BRAND.ink }}>
            Elegí un organizador para ver sus torneos, resultados y llaves <span className="font-bold" style={{ color: BRAND.lime }}>en vivo.</span>
          </p>
        </div>
        <div className="shrink-0 self-end sm:self-auto rounded-xl px-3 py-2 w-[8.5rem] sm:w-44 divide-y" style={{ ...neonStyle(BRAND.cyan), backgroundColor: "rgba(8,18,24,0.72)", backdropFilter: "blur(6px)", borderColor: BRAND.cyan + "66" }}>
          {items.map(([icon, value, label]) => (
            <div key={label} className="flex items-center gap-2 py-2" style={{ borderColor: BRAND.cyan + "33" }}>
              <span className="shrink-0">{icon}</span>
              <div className="min-w-0">
                <p className="text-xl sm:text-2xl font-bold leading-none" style={{ ...F.body, color: BRAND.ink }}>{value}</p>
                <p className="text-[10px] sm:text-xs text-teal-300 leading-tight mt-0.5" style={F.body}>{label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* Tarjeta de organizador: su foto de portada de fondo (o una cancha genérica), el logo en un
   círculo con aro de neón, el nombre, la cantidad de torneos y la flecha para entrar */
function OrganizerCard({ organizer, count, color, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="relative text-left rounded-2xl overflow-hidden min-h-[15rem] sm:min-h-[17rem] flex flex-col justify-end transition hover:brightness-110"
      style={neonStyle(color)}
    >
      {organizer.coverUrl
        ? <img src={organizer.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        : <div className="absolute inset-0" style={{ background: COURT_FALLBACK_BACKGROUND }} />}
      <div className="absolute inset-0" style={{ background: "linear-gradient(0deg, rgba(8,18,24,0.95) 0%, rgba(8,18,24,0.55) 45%, rgba(8,18,24,0.2) 100%)" }} />
      <div className="relative flex justify-center pt-5">
        {organizer.logoUrl ? (
          <img src={organizer.logoUrl} alt="" className="w-24 h-24 sm:w-28 sm:h-28 rounded-full object-cover" style={{ ...neonStyle(color, true), backgroundColor: "#081218" }} />
        ) : (
          <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full flex items-center justify-center text-4xl" style={{ ...neonStyle(color, true), ...F.display, backgroundColor: "#081218", color }}>
            {organizer.name.trim().charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className="relative p-3 sm:p-4 mt-auto">
        <p className="text-base sm:text-xl leading-tight uppercase mb-2 break-words" style={{ ...F.display, color: BRAND.ink }}>{organizer.name}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] sm:text-sm whitespace-nowrap min-w-0" style={{ ...F.body, border: `1px solid ${color}66`, backgroundColor: "rgba(8,18,24,0.7)", color: BRAND.ink }}>
            <TrophyIcon size={14} color={color} /> {count} torneo{count !== 1 ? "s" : ""}
          </span>
          <ChevronCircle color={color} />
        </div>
      </div>
    </button>
  );
}

function OrganizerSelectScreen({ organizers, tournaments, ads, onSelect, onGoLogin, onRegister }) {
  const visible = organizers.filter((o) => o.role !== "creador");

  return (
    <div>
      <SiteHeader onGoLogin={onGoLogin} />
      <HomeHero tournaments={tournaments} />
      <OpenRegistrationsStrip tournaments={tournaments} organizers={organizers} onRegister={onRegister} />
      <AdBanner ads={ads} className="max-w-5xl mx-auto px-4 sm:px-6 pt-6" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-10">
        {visible.length === 0 ? (
          <p className="opacity-60" style={F.body}>Todavía no hay organizadores con torneos cargados.</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
            {visible.map((o, i) => (
              <OrganizerCard
                key={o.id}
                organizer={o}
                count={tournaments.filter((t) => t.organizerId === o.id).length}
                color={(Math.floor(i / 2) + i) % 2 === 0 ? BRAND.lime : BRAND.cyan}
                onSelect={() => onSelect(o.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function PublicHome({ tournaments, ads, circuits, organizers, onOpen, onGoLogin }) {
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [section, setSection] = useState("torneos"); // torneos | circuitos
  const [filter, setFilter] = useState(STATUS.EN_CURSO); // todos | Próximo | En curso | Finalizado
  const [registeringId, setRegisteringId] = useState(null);
  const registering = tournaments.find((t) => t.id === registeringId);
  const registrationSheet = registering && (
    <RegistrationSheet tournament={registering} organizer={organizers.find((o) => o.id === registering.organizerId)} onClose={() => setRegisteringId(null)} />
  );
  const onRegister = (t) => setRegisteringId(t.id);

  if (!selectedOrgId) {
    return (
      <>
        <OrganizerSelectScreen
          organizers={organizers}
          tournaments={tournaments}
          ads={ads}
          onSelect={setSelectedOrgId}
          onGoLogin={onGoLogin}
          onRegister={onRegister}
        />
        {registrationSheet}
      </>
    );
  }

  const selectedOrg = organizers.find((o) => o.id === selectedOrgId);
  const orgTournaments = tournaments.filter((t) => t.organizerId === selectedOrgId);
  const orgCircuits = circuits.filter((c) => c.organizerId === selectedOrgId);

  const filtered = filter === "todos" ? orgTournaments : orgTournaments.filter((t) => t.status === filter);
  const bigCards = filter === STATUS.EN_CURSO || filter === STATUS.PROXIMO;
  const counts = {
    todos: orgTournaments.length,
    [STATUS.EN_CURSO]: orgTournaments.filter((t) => t.status === STATUS.EN_CURSO).length,
    [STATUS.PROXIMO]: orgTournaments.filter((t) => t.status === STATUS.PROXIMO).length,
    [STATUS.FINALIZADO]: orgTournaments.filter((t) => t.status === STATUS.FINALIZADO).length,
  };

  return (
    <div>
      <SiteHeader onGoLogin={onGoLogin} />
      <header className="px-6 pt-2 pb-8 border-b border-teal-900">
        <button onClick={() => setSelectedOrgId(null)} className="text-sm text-teal-400 hover:text-lime-400 flex items-center gap-1" style={F.body}>
          ← Todos los organizadores
        </button>
        <div className="flex items-center gap-3 mt-6">
          {selectedOrg?.logoUrl ? (
            <img src={selectedOrg.logoUrl} alt="" className="w-12 h-12 rounded-full object-cover border border-teal-700" />
          ) : (
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-semibold" style={{ backgroundColor: "#115e59", color: "#9fe022" }}>
              {(selectedOrg?.name || "?").trim().charAt(0).toUpperCase()}
            </div>
          )}
          <h1 className="text-xl" style={F.display}>{(selectedOrg?.name || "").toUpperCase()}</h1>
        </div>

        <div className="flex gap-2 mt-6">
          {[["torneos", "Torneos"], ["circuitos", "Circuitos"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={`px-4 py-2 rounded text-sm border ${section === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
              style={F.body}
            >
              {label}
            </button>
          ))}
        </div>

        {section === "torneos" && (
          <div className="flex gap-2 mt-4 flex-wrap">
            {[[STATUS.EN_CURSO, "En curso"], [STATUS.PROXIMO, "Próximos"], [STATUS.FINALIZADO, "Finalizados"], ["todos", "Todos"]].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className="px-3 py-1.5 rounded-full text-sm border transition"
                style={
                  filter === key
                    ? { backgroundColor: "#9fe022", color: "#14181f", borderColor: "#9fe022" }
                    : { backgroundColor: "transparent", color: "#5eead4", borderColor: "#115e59" }
                }
              >
                {label} ({counts[key] ?? 0})
              </button>
            ))}
          </div>
        )}
      </header>

      {section === "circuitos" ? (
        <div className="pt-8">
          <CircuitsPublicView circuits={orgCircuits} tournaments={tournaments} organizers={organizers} ads={ads} />
        </div>
      ) : (
      <>
      <main className={`px-6 py-8 grid gap-5 ${bigCards ? "grid-cols-2" : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"}`}>
        {filtered.length === 0 && (
          <p className="opacity-60" style={F.body}>
            {orgTournaments.length === 0 ? "Todavía no hay torneos cargados." : "No hay torneos en este estado."}
          </p>
        )}
        {filtered.map((t) => {
          const accent = { [STATUS.EN_CURSO]: "#9fe022", [STATUS.PROXIMO]: "#38bdf8", [STATUS.FINALIZADO]: "#64748b" }[t.status];
          const progress = tournamentProgress(t);
          return (
          // Es un contenedor tocable y no un <button> porque adentro va el botón "Inscribirme"
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(t.id)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(t.id); } }}
            className="text-left rounded-lg transition overflow-hidden cursor-pointer"
            style={{ backgroundColor: accent + "0d", border: `1px solid ${accent}33`, borderTop: `3px solid ${accent}` }}
          >
            {bigCards ? (
              <>
                <h2 className="text-sm sm:text-lg font-semibold text-center py-2 border-b" style={{ ...F.body, color: accent, borderColor: accent + "33" }}>
                  {t.name}
                </h2>
                {t.coverImageUrl && (
                  <img src={t.coverImageUrl} alt="" className="w-full object-cover aspect-[3/4]" />
                )}
                <div className="p-3 sm:p-4 text-center">
                  <div className="mb-2"><TournamentTypeTag tournament={t} /></div>
                  <p className="text-[11px] sm:text-sm text-teal-300" style={F.body}>
                    <span className="text-teal-500">Fecha: </span>
                    {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" })}
                  </p>
                  {t.venue && (
                    <p className="text-[11px] sm:text-sm text-teal-300 mt-0.5" style={F.body}>
                      <span className="text-teal-500">Localidad: </span>{t.venue} <span style={{ color: accent }}>[SEDE]</span>
                    </p>
                  )}
                  <p className="text-xs sm:text-base font-bold mt-2" style={{ ...F.body, color: accent }}>
                    {t.status === STATUS.EN_CURSO ? "● EN CURSO" : t.status.toUpperCase()}
                  </p>
                  {progress.total > 0 && (
                    <>
                      <p className="text-[11px] sm:text-sm text-teal-400 mt-1" style={F.body}>
                        Avance: {progress.played} / {progress.total}
                      </p>
                      <p className="text-xs sm:text-base font-bold" style={F.body}>{progress.pct.toFixed(2)} %</p>
                    </>
                  )}
                  <div className="mt-2 space-y-2">
                    <OpenRegistrationsBadge tournament={t} />
                    <RegisterButton tournament={t} onRegister={onRegister} full className="text-xs sm:text-sm" />
                  </div>
                </div>
              </>
            ) : (
              <>
                {t.coverImageUrl && (
                  <img src={t.coverImageUrl} alt="" className="w-full h-32 object-cover" />
                )}
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-lg font-semibold" style={F.body}>{t.name}</h2>
                    <Badge status={t.status} />
                  </div>
                  <div className="mt-2"><TournamentTypeTag tournament={t} /></div>
                  <p className="mt-2 text-sm text-teal-300" style={F.body}>
                    {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" })}
                    {t.venue ? ` · ${t.venue}` : ""}
                  </p>
                  <p className="mt-3 text-sm text-teal-400" style={F.body}>
                    {t.categories.length} categoría{t.categories.length !== 1 ? "s" : ""} · {t.categories.reduce((sum, c) => sum + c.pairs.length, 0)} parejas anotadas
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
                    <OpenRegistrationsBadge tournament={t} />
                    <RegisterButton tournament={t} onRegister={onRegister} />
                  </div>
                </div>
              </>
            )}
          </div>
          );
        })}
      </main>
      </>
      )}
      <div className="px-6 pb-10">
        <AdBanner ads={ads} />
      </div>
      {registrationSheet}
    </div>
  );
}

/* ---------- Vista pública: detalle de torneo ---------- */

/* Súper 8: lista simple de todos los partidos, uno por renglón y en orden de juego
   ("Elías - Martín vs Juan - Negro"), y debajo la tabla de posiciones (se recalcula sola con cada
   resultado). Con onSetScore/onWalkover muestra la carga de resultados para el organizador; sin
   ellos es la vista de solo lectura para el público. */
function Super8View({ category, format, onSetScore, onWalkover }) {
  const pairsById = useMemo(() => categoryEntitiesById(category), [category]);
  const group = category.groups[0];
  if (!group) return null;
  const editable = !!onSetScore;
  const individual = category.format === "super8_individual";
  const standingsGroup = individual ? super8IndividualStandingsGroup(category, group) : group;
  const nameOf = (id) => pairsById[id]?.name || "—";

  return (
    <div>
      <div className="rounded-xl border border-teal-800 divide-y divide-teal-900 min-w-0">
        {group.matches.map((m, i) => {
          const hasResult = matchIsPlayed(m);
          const w = hasResult ? matchWinnerId(m) : null;
          const side = (id) => <span className={w === id ? "text-lime-400 font-semibold" : ""}>{nameOf(id)}</span>;
          return (
            <div key={m.id} className="flex items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm flex-wrap" style={F.body}>
              <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                <span className="text-[11px] text-teal-600 w-5 shrink-0 text-right">{i + 1}.</span>
                {side(m.pairA)}
                <span className="text-xs text-teal-500">vs</span>
                {side(m.pairB)}
                {!editable && hasResult && <span className="font-mono text-xs text-teal-300"><MatchResultLabel match={m} winnerIsA={w == null ? null : w === m.pairA} /></span>}
              </div>
              {editable && (
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <MatchSetsEditor sets={m.sets} format={format} onSetScore={(setIndex, s, value) => onSetScore(group.id, m.id, setIndex, s, value)} />
                  <div className="flex flex-col gap-0.5 text-[10px]">
                    {m.walkover ? (
                      <button type="button" onClick={() => onWalkover(group.id, m.id, null)} className="text-teal-400 underline">Deshacer WO</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => onWalkover(group.id, m.id, m.pairA)} className="text-amber-400 underline text-left" title={`WO de ${nameOf(m.pairA)}`}>WO izq.</button>
                        <button type="button" onClick={() => onWalkover(group.id, m.id, m.pairB)} className="text-amber-400 underline text-left" title={`WO de ${nameOf(m.pairB)}`}>WO der.</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <h3 className="text-sm uppercase tracking-wide text-teal-400 mt-8 mb-2" style={F.body}>Tabla de posiciones</h3>
      <StandingsTable group={standingsGroup} pairsById={pairsById} format={format} highlightCount={3} />
      <StandingsLegend />
    </div>
  );
}

function CategoryGroupsPublicView({ category, format }) {
  const pairsById = useMemo(() => Object.fromEntries(category.pairs.map((p) => [p.id, p])), [category.pairs]);

  return (
    <section className="mt-6">
      {category.groups.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no se armaron los grupos.</p>}
      <div className="grid gap-6 md:grid-cols-2 min-w-0">
        {category.groups.map((g, gi) => {
          const color = GROUP_COLORS[gi % GROUP_COLORS.length];
          return (
            <div key={g.id} className="rounded-xl p-4 min-w-0" style={{ backgroundColor: color + "0d", border: `1px solid ${color}33` }}>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <SkewPill color={color}>{g.name}</SkewPill>
                <span className="text-[11px] text-teal-500" style={F.body}>Clasifican {groupQualifiersCount(g)}</span>
              </div>
              <StandingsTable group={g} pairsById={pairsById} format={format} accentColor={color} highlightCount={groupQualifiersCount(g)} />
              <div className="mt-3 space-y-2">
                {g.matches.map((m) => {
                  const hasResult = matchIsPlayed(m);
                  const pending = !m.pairA || !m.pairB;
                  const w = hasResult ? matchWinnerId(m) : null;
                  const winnerIsA = w == null ? null : w === m.pairA;
                  return (
                    <div key={m.id} className="text-sm" style={F.body}>
                      {groupMatchStageLabel(g, m) && <span className="text-[10px] text-teal-500 block">{g.name} · {groupMatchStageLabel(g, m)}</span>}
                      {pending ? (
                        <div className="flex justify-between items-baseline gap-3">
                          <span className="italic opacity-70 min-w-0">
                            {m.stage === "ganadores" ? "Ganador Partido 1 vs Ganador Partido 2" : m.stage === "perdedores" ? "Perdedor Partido 1 vs Perdedor Partido 2" : "A definir"}
                          </span>
                          <span className="text-right"><ScheduleLabel schedule={m.schedule} /></span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1 min-w-0">
                            {w === m.pairA && <WinnerCheck />}
                            <GroupPairName id={m.pairA} pairsById={pairsById} />
                          </div>
                          <div className="flex items-center gap-1 min-w-0">
                            {w === m.pairB && <WinnerCheck />}
                            <GroupPairName id={m.pairB} pairsById={pairsById} />
                          </div>
                          <div className="flex justify-between items-baseline gap-3 mt-0.5">
                            <span className="font-mono text-xs text-teal-300">{hasResult && <MatchResultLabel match={m} winnerIsA={winnerIsA} />}</span>
                            <span className="text-right"><ScheduleLabel schedule={m.schedule} /></span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {category.groups.length > 0 && <StandingsLegend />}
    </section>
  );
}

function CategoryBracketPublicView({ category }) {
  const pairsById = useMemo(() => Object.fromEntries(category.pairs.map((p) => [p.id, p])), [category.pairs]);

  return (
    <section className="mt-6">
      {!category.bracket && <p className="opacity-60 text-sm" style={F.body}>La llave todavía no se generó.</p>}
      {category.bracket && (
        <div className="flex gap-8 overflow-x-auto pb-4">
          {category.bracket.map((round, ri) => {
            const isFinal = ri === category.bracket.length - 1;
            const color = GROUP_COLORS[(category.bracket.length - 1 - ri) % GROUP_COLORS.length];
            return (
              <div key={ri} className="flex flex-col justify-around gap-4 min-w-[220px]">
                <span
                  className="self-start px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide"
                  style={{ backgroundColor: color, color: "#14181f" }}
                >
                  {isFinal ? "🏆 " : ""}{roundStageLabel(category.bracket.length, ri)}
                </span>
                {round.map((m) => {
                  const w = winnerOf(m);
                  const { a: setsA, b: setsB } = setsWon(m);
                  const winnerIsA = w == null ? null : w === m.pairA;
                  return (
                    <div key={m.id} className="rounded-lg p-3 text-sm" style={{ ...F.body, backgroundColor: color + "0d", border: `1px solid ${color}40` }}>
                      <ScheduleLabel schedule={m.schedule} />
                      <div className={`flex justify-between mt-1 ${w && w === m.pairA ? "font-semibold" : ""}`} style={w && w === m.pairA ? { color } : undefined}>
                        <span className="flex items-center gap-1">{w === m.pairA && <WinnerCheck />}<PairName id={m.pairA} pairsById={pairsById} /></span>
                        <span>{m.walkover ? "" : matchIsPlayed(m) ? setsA : ""}</span>
                      </div>
                      <div className={`flex justify-between mt-1 ${w && w === m.pairB ? "font-semibold" : ""}`} style={w && w === m.pairB ? { color } : undefined}>
                        <span className="flex items-center gap-1">{w === m.pairB && <WinnerCheck />}<PairName id={m.pairB} pairsById={pairsById} /></span>
                        <span>{m.walkover ? "" : matchIsPlayed(m) ? setsB : ""}</span>
                      </div>
                      {matchIsPlayed(m) && (
                        <p className="text-[10px] text-teal-500 mt-1"><MatchResultLabel match={m} winnerIsA={winnerIsA} /></p>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}


function PublicTournament({ tournament, ads, organizers, onBack }) {
  const format = tournament.matchFormat || DEFAULT_MATCH_FORMAT;
  const usesSchedule = tournamentUsesSchedule(tournament);
  const super8Tournament = tournamentType(tournament) === "super8";
  const [view, setView] = useState(usesSchedule ? "horarios" : "grupos"); // horarios | grupos | llaves
  const viewTabs = super8Tournament
    ? [["grupos", "Partidos y posiciones"]]
    : [...(usesSchedule ? [["horarios", "Horarios"]] : []), ["grupos", "Grupos"], ["llaves", "Llaves finales"]];
  const [categoryId, setCategoryId] = useState(tournament.categories[0]?.id || null);
  const category = tournament.categories.find((c) => c.id === categoryId) || tournament.categories[0] || null;
  const organizer = (organizers || []).find((o) => o.id === tournament.organizerId);
  const organizerName = organizer?.name;
  const [registering, setRegistering] = useState(false);
  const showRegister = registrationStatus(tournament) !== "cerrado";

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto">
      {/* Inscripción: botón fijo abajo, por encima de la barra del celular (safe area) */}
      {showRegister && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pt-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)", background: "linear-gradient(0deg, rgba(8,18,24,0.98) 60%, rgba(8,18,24,0))" }}>
          <div className="max-w-md mx-auto">
            <RegisterButton tournament={tournament} onRegister={() => setRegistering(true)} full className="py-3.5 text-base" />
          </div>
        </div>
      )}
      {registering && <RegistrationSheet tournament={tournament} organizer={organizer} onClose={() => setRegistering(false)} />}
      <button onClick={onBack} className="text-sm text-teal-300 hover:text-lime-400 mb-4" style={F.body}>← Todos los torneos</button>
      {tournament.coverImageUrl && (
        <img src={tournament.coverImageUrl} alt="" className="w-full h-40 sm:h-56 object-cover rounded-lg border border-teal-800 mb-4" />
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl" style={F.display}>{tournament.name.toUpperCase()}</h1>
        <Badge status={tournament.status} />
      </div>
      <p className="text-xs text-teal-500 mt-2" style={F.body}>
        {tournamentTypeSummary(tournament)}
        {tournament.venue ? ` · Sede: ${tournament.venue}` : ""}
      </p>
      {organizerName && <p className="text-xs text-teal-600 mt-1" style={F.body}>Organiza: {organizerName}</p>}

      <div className="flex gap-2 mt-4 overflow-x-auto">
        {viewTabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-sm border ${view === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
            style={F.body}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "horarios" ? (
        <div className="mt-6"><SchedulePublicView tournament={tournament} /></div>
      ) : tournament.categories.length === 0 ? (
        <p className="opacity-60 text-sm mt-8" style={F.body}>Todavía no se cargaron categorías para este torneo.</p>
      ) : (
        <>
          <div className="flex gap-2 mt-6 overflow-x-auto pb-1 sm:flex-wrap">
            {tournament.categories.map((c, ci) => {
              const color = GROUP_COLORS[ci % GROUP_COLORS.length];
              const active = c.id === category?.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setCategoryId(c.id)}
                  className="shrink-0 whitespace-nowrap px-4 py-2 rounded-full text-sm border transition font-medium"
                  style={
                    active
                      ? { backgroundColor: color, color: "#14181f", borderColor: color }
                      : { backgroundColor: color + "14", color, borderColor: color + "40" }
                  }
                >
                  {c.name}
                </button>
              );
            })}
          </div>
          {category && isSuper8(category) ? (
            view === "grupos" ? (
              <section className="mt-6">
                <p className="text-xs text-teal-500 mb-4" style={F.body}>{CATEGORY_FORMAT_LABEL[category.format]}</p>
                {category.groups.length > 0
                  ? <Super8View category={category} format={format} />
                  : <p className="opacity-60 text-sm" style={F.body}>Todavía no se generaron los partidos.</p>}
              </section>
            ) : (
              <p className="opacity-60 text-sm mt-6" style={F.body}>Esta categoría se juega en formato {CATEGORY_FORMAT_LABEL[category.format]}: no tiene llave final. Los partidos y la tabla de posiciones están en la pestaña Grupos.</p>
            )
          ) : (
            <>
              {category && view === "grupos" && <CategoryGroupsPublicView category={category} format={format} />}
              {category && view === "llaves" && <CategoryBracketPublicView category={category} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
function Login({ onLogin, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("login"); // login | recuperar
  const [recoverMsg, setRecoverMsg] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) { setError("Completá email y contraseña."); return; }
    setError("");
    setLoading(true);
    try {
      const auth = await supabaseSignIn(email.trim(), password);
      const orgs = await fetchOrganizers();
      const profile = orgs.find((o) => o.id === auth.user.id);
      if (!profile) { setError("Tu cuenta no tiene un perfil de organizador asociado."); setLoading(false); return; }
      onLogin({ ...profile, accessToken: auth.access_token });
    } catch (e) {
      setError(e.message || "Usuario o contraseña incorrectos.");
    }
    setLoading(false);
  };

  const submitRecover = async () => {
    if (!email.trim()) { setRecoverMsg("Ingresá tu email."); return; }
    setRecoverMsg("");
    setLoading(true);
    try {
      await supabaseRequestPasswordReset(email.trim());
      setRecoverMsg("Si el email existe, te enviamos un correo para restablecer la contraseña.");
    } catch (e) {
      setRecoverMsg(e.message || "No pudimos enviar el correo de recuperación.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-[75vh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo size={72} withWordmark />
        </div>

        <div className="border border-teal-800 rounded-xl p-7 bg-teal-950/40">
          {mode === "login" ? (
            <div>
              <h1 className="text-lg font-semibold mb-1" style={F.body}>Acceso al panel</h1>
              <p className="text-sm text-teal-400 mb-6" style={F.body}>Para organizadores y administración de la plataforma.</p>

              <label className="block text-sm mb-1 text-teal-300" style={F.body}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                className="w-full mb-4 px-3 py-2 rounded-md border outline-none focus:border-lime-400 transition" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
              />

              <label className="block text-sm mb-1 text-teal-300" style={F.body}>Contraseña</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                className="w-full mb-2 px-3 py-2 rounded-md border outline-none focus:border-lime-400 transition" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
              />

              {error && <p className="text-sm text-red-400 mb-2" style={F.body}>{error}</p>}

              <button type="button" onClick={() => { setMode("recuperar"); setRecoverMsg(""); }} className="text-xs text-teal-400 hover:text-lime-400 mb-5 block" style={F.body}>
                ¿Olvidaste tu contraseña?
              </button>

              <button type="button" disabled={loading} onClick={submit} className="w-full py-2.5 rounded-md font-semibold transition" style={{ backgroundColor: "#9fe022", color: "#14181f", opacity: loading ? 0.6 : 1, ...F.body }}>{loading ? "Ingresando…" : "Ingresar"}</button>
              <button type="button" onClick={onBack} className="w-full mt-4 text-sm text-teal-400 hover:text-lime-400" style={F.body}>← Volver al sitio público</button>
            </div>
          ) : (
            <div>
              <h1 className="text-lg font-semibold mb-1" style={F.body}>Recuperar acceso</h1>
              <p className="text-sm text-teal-400 mb-6" style={F.body}>Ingresá tu email y te mandamos un link para restablecer la contraseña.</p>
              <label className="block text-sm mb-1 text-teal-300" style={F.body}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitRecover(); }}
                className="w-full mb-4 px-3 py-2 rounded-md border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
              />
              {recoverMsg && <p className="text-sm text-lime-400 mb-3" style={F.body}>{recoverMsg}</p>}
              <button type="button" disabled={loading} onClick={submitRecover} className="w-full py-2.5 rounded-md font-semibold" style={{ backgroundColor: "#9fe022", color: "#14181f", opacity: loading ? 0.6 : 1, ...F.body }}>{loading ? "Enviando…" : "Enviar solicitud"}</button>
              <button type="button" onClick={() => setMode("login")} className="w-full mt-4 text-sm text-teal-400 hover:text-lime-400" style={F.body}>← Volver a ingresar</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Panel organizador ---------- */

/* Campo de imagen: permite elegir un archivo desde la compu o la galería del celular
   (el input type="file" con accept="image/*" abre la cámara/galería en mobile automáticamente),
   lo sube a Supabase Storage y guarda la URL pública resultante mediante onChange. */
function ImageUploadField({ label, value, onChange, accessToken, folder }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const url = await uploadImageToSupabase(file, accessToken, folder);
      onChange(url);
    } catch (err) {
      setError(err.message || "No se pudo subir la imagen.");
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div>
      {label && <label className="block text-xs text-teal-400 mb-1" style={F.body}>{label}</label>}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={handleFile}
          className="text-xs text-teal-300"
          style={F.body}
        />
        {uploading && <span className="text-xs text-teal-400" style={F.body}>Subiendo…</span>}
        {value && !uploading && (
          <button type="button" onClick={() => onChange("")} className="text-xs text-teal-500 hover:text-red-400 underline" style={F.body}>
            Quitar imagen
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400 mt-1" style={F.body}>{error}</p>}
      {value && (
        <img src={value} alt="" className="mt-2 w-16 h-16 rounded object-cover border border-teal-700" />
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="…o pegá una URL (https://...)"
        className="mt-2 w-full px-3 py-2 rounded border outline-none focus:border-lime-400 text-xs"
        style={inputStyle}
      />
    </div>
  );
}

/* Formulario para crear una cuenta de organizador real (usuario + fila en la tabla organizers) */
function NewOrganizerForm({ onCreate }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const submit = async () => {
    if (!name.trim() || !username.trim() || !email.trim() || password.length < 6) {
      setError("Completá todos los campos (la contraseña necesita al menos 6 caracteres).");
      return;
    }
    setSaving(true);
    setError("");
    setOkMsg("");
    try {
      await onCreate({ name: name.trim(), username: username.trim(), email: email.trim(), password });
      setOkMsg(`Cuenta creada para ${name.trim()}. Pasale el email y la contraseña.`);
      setName(""); setUsername(""); setEmail(""); setPassword("");
    } catch (e) {
      setError(e.message || "No se pudo crear la cuenta.");
    }
    setSaving(false);
  };

  return (
    <div className="border border-teal-800 rounded-lg p-4 mb-8">
      <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Nueva cuenta de organizador</h2>
      <div className="grid gap-3 sm:grid-cols-2 mb-3">
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del organizador</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="Ej: Club Los Sauces" />
        </div>
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Usuario (para mostrar)</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="clublossauces" />
        </div>
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Email de acceso</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="organizador@email.com" />
        </div>
        <div>
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Contraseña inicial</label>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="Mínimo 6 caracteres" />
        </div>
      </div>
      <button type="button" disabled={saving} onClick={submit} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f", opacity: saving ? 0.6 : 1 }}>
        {saving ? "Creando…" : "Crear organizador"}
      </button>
      {error && <p className="text-xs text-red-400 mt-2" style={F.body}>{error}</p>}
      {okMsg && <p className="text-xs text-lime-400 mt-2" style={F.body}>{okMsg}</p>}
      <p className="text-[11px] text-teal-600 mt-2" style={F.body}>Pasale ese email y esa contraseña al organizador para que inicie sesión; después la puede cambiar con "¿Olvidaste tu contraseña?" en el login.</p>
    </div>
  );
}

function OrganizerRow({ o, count, onUpdateOrganizer, onDeleteOrganizer, accessToken }) {
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState(o.name);
  const [profileLogo, setProfileLogo] = useState(o.logoUrl || "");
  const [profileCover, setProfileCover] = useState(o.coverUrl || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const saveProfile = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await onUpdateOrganizer(o.id, { name: profileName.trim() || o.name, logoUrl: profileLogo.trim(), coverUrl: profileCover.trim() });
      setEditingProfile(false);
    } catch (e) {
      setSaveError(e.message || "No se pudo guardar.");
    }
    setSaving(false);
  };

  const doDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await onDeleteOrganizer(o.id);
    } catch (e) {
      setDeleteError(e.message || "No se pudo eliminar.");
      setDeleting(false);
    }
  };

  return (
    <div className="border border-teal-800 rounded px-4 py-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {o.logoUrl ? (
            <img src={o.logoUrl} alt="" className="w-9 h-9 rounded-full object-cover border border-teal-700" />
          ) : (
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0" style={{ backgroundColor: "#115e59", color: "#9fe022" }}>
              {o.name.trim().charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <p style={F.body} className="font-medium">{o.name}</p>
            <p className="text-xs text-teal-400" style={F.body}>@{o.username} · {count} torneo{count !== 1 ? "s" : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setEditingProfile((v) => !v)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>
            Nombre y logo
          </button>
          {!confirmingDelete ? (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
          ) : (
            <span className="text-sm whitespace-nowrap">
              <button type="button" disabled={deleting} onClick={doDelete} className="text-red-400 font-semibold mr-2" style={F.body}>{deleting ? "Eliminando…" : "Confirmar"}</button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
            </span>
          )}
        </div>
      </div>
      {confirmingDelete && (
        <p className="text-xs text-teal-500 mt-2" style={F.body}>Se borra la cuenta de acceso; sus torneos ya cargados van a quedar en la plataforma pero sin organizador asignado.</p>
      )}
      {deleteError && <p className="text-xs text-red-400 mt-1" style={F.body}>{deleteError}</p>}
      {editingProfile && (
        <div className="flex flex-wrap gap-3 items-end mt-3 pt-3 border-t border-teal-900">
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del organizador</label>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          </div>
          <div className="min-w-[220px]">
            <ImageUploadField label="Logo" value={profileLogo} onChange={setProfileLogo} accessToken={accessToken} folder="logos" />
          </div>
          <div className="min-w-[220px]">
            <ImageUploadField label="Foto de portada" value={profileCover} onChange={setProfileCover} accessToken={accessToken} folder="covers" />
          </div>
          <button type="button" disabled={saving} onClick={saveProfile} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {saveError && <p className="text-xs text-red-400 w-full" style={F.body}>{saveError}</p>}
        </div>
      )}
    </div>
  );
}

function AdRow({ ad, onUpdate, onDelete, accessToken }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ad.name);
  const [imageUrl, setImageUrl] = useState(ad.imageUrl);
  const [linkUrl, setLinkUrl] = useState(ad.linkUrl);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  if (editing) {
    return (
      <div className="border border-lime-400 rounded-lg p-4 space-y-2">
        <label className="block text-xs text-teal-400" style={F.body}>Nombre / anunciante</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} />
        <label className="block text-xs text-teal-400" style={F.body}>Imagen</label>
        <ImageUploadField value={imageUrl} onChange={setImageUrl} accessToken={accessToken} folder="ads" />
        <label className="block text-xs text-teal-400" style={F.body}>URL de destino (a dónde va si lo tocan)</label>
        <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="https://..." />
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => { if (name.trim() && imageUrl.trim()) { onUpdate({ ...ad, name: name.trim(), imageUrl: imageUrl.trim(), linkUrl: linkUrl.trim() }); setEditing(false); } }}
            className="px-3 py-1.5 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
          >
            Guardar
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-sm text-teal-400" style={F.body}>Cancelar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-teal-800 rounded-lg p-3 flex gap-3 items-center">
      {ad.imageUrl ? (
        <img src={ad.imageUrl} alt={ad.name} className="w-24 h-14 object-cover rounded border border-teal-800" />
      ) : (
        <div className="w-24 h-14 rounded border border-teal-800 flex items-center justify-center text-[10px] text-teal-500">Sin imagen</div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate" style={F.body}>{ad.name}</p>
        <p className="text-xs text-teal-500 truncate" style={F.body}>{ad.linkUrl || "Sin link de destino"}</p>
      </div>
      <label className="flex items-center gap-1 text-xs text-teal-300" style={F.body}>
        <input type="checkbox" checked={ad.active} onChange={(e) => onUpdate({ ...ad, active: e.target.checked })} />
        Activo
      </label>
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>Editar</button>
      {!confirmingDelete ? (
        <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
      ) : (
        <span className="text-sm whitespace-nowrap">
          <button type="button" onClick={() => onDelete(ad.id)} className="text-red-400 font-semibold mr-2" style={F.body}>Confirmar</button>
          <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
        </span>
      )}
    </div>
  );
}

function AdManager({ ads, onAdd, onUpdate, onDelete, accessToken }) {
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const submit = () => {
    if (!name.trim() || !imageUrl.trim()) return;
    onAdd({ name: name.trim(), imageUrl: imageUrl.trim(), linkUrl: linkUrl.trim(), active: true });
    setName(""); setImageUrl(""); setLinkUrl("");
  };

  return (
    <div>
      <div className="border border-teal-800 rounded-lg p-4 mb-6">
        <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Nuevo anuncio</h2>
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre / anunciante</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="Ej: Wilson Padel" />
          </div>
          <div>
            <ImageUploadField label="Imagen" value={imageUrl} onChange={setImageUrl} accessToken={accessToken} folder="ads" />
          </div>
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>URL de destino</label>
            <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="https://..." />
          </div>
        </div>
        <button type="button" onClick={submit} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>Agregar anuncio</button>
        <p className="text-[11px] text-teal-600 mt-2" style={F.body}>La imagen se muestra en la home pública y dentro de cada torneo, rotando junto con el resto de los anuncios activos.</p>
      </div>

      <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Anuncios cargados</h2>
      <div className="space-y-3">
        {ads.map((ad) => <AdRow key={ad.id} ad={ad} onUpdate={onUpdate} onDelete={onDelete} accessToken={accessToken} />)}
        {ads.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no cargaste ningún anuncio.</p>}
      </div>
    </div>
  );
}

/* Fila de torneo en el panel del creador: solo lectura + eliminar (la edición es tarea del organizador) */
function CreatorTournamentRow({ t, organizerName, onDelete }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const totalPairs = t.categories.reduce((sum, c) => sum + c.pairs.length, 0);
  return (
    <div className="border border-teal-800 rounded-lg p-3 flex justify-between items-center flex-wrap gap-2">
      <div>
        <p className="font-medium" style={F.body}>{t.name}</p>
        <p className="text-xs text-teal-500" style={F.body}>
          {organizerName} · {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" })} · {t.categories.length} categoría{t.categories.length !== 1 ? "s" : ""} · {totalPairs} pareja{totalPairs !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Badge status={t.status} />
        {!confirmingDelete ? (
          <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
        ) : (
          <span className="text-sm whitespace-nowrap">
            <button type="button" onClick={() => onDelete(t.id)} className="text-red-400 font-semibold mr-2" style={F.body}>Confirmar</button>
            <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
          </span>
        )}
      </div>
    </div>
  );
}

/* Fila de circuito en el panel del creador: solo lectura + eliminar */
function CreatorCircuitRow({ circuit, organizerName, tournaments, onDelete }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fechas = tournaments.filter((t) => t.circuitId === circuit.id).length;
  return (
    <div className="border border-teal-800 rounded-lg p-3 flex justify-between items-center flex-wrap gap-2">
      <div>
        <p className="font-medium" style={F.body}>{circuit.name} <span className="text-teal-500 text-sm">· {circuit.year}</span></p>
        <p className="text-xs text-teal-500" style={F.body}>{organizerName} · {circuit.categoryNames.join(", ")} · {fechas} fecha{fechas !== 1 ? "s" : ""}</p>
      </div>
      {!confirmingDelete ? (
        <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
      ) : (
        <span className="text-sm whitespace-nowrap">
          <button type="button" onClick={() => onDelete(circuit.id)} className="text-red-400 font-semibold mr-2" style={F.body}>Confirmar</button>
          <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
        </span>
      )}
    </div>
  );
}

function BackupManager({ organizers, tournaments, circuits, ads, onRestore }) {
  const [importError, setImportError] = useState("");
  const [pendingData, setPendingData] = useState(null);
  const [pickedFileName, setPickedFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const downloadBackup = () => {
    const data = { organizers, tournaments, circuits, ads, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smash-point-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const parseAndValidate = (text) => {
    const data = JSON.parse(text);
    if (!Array.isArray(data.tournaments) || !Array.isArray(data.organizers)) {
      throw new Error("El texto no tiene el formato esperado de un respaldo de Smash Point (faltan 'tournaments' u 'organizers').");
    }
    return data;
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    setImportError("");
    setPendingData(null);
    if (!file) { setPickedFileName(""); return; }
    setPickedFileName(`${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`);
    setReading(true);
    const reader = new FileReader();
    reader.onerror = () => {
      setReading(false);
      setImportError("No se pudo leer el archivo desde el celular/navegador (falló la lectura). Probá con la opción de pegar el texto, más abajo.");
    };
    reader.onload = () => {
      setReading(false);
      try {
        setPendingData(parseAndValidate(reader.result));
        setImportError("");
      } catch (err) {
        setImportError(`No se pudo interpretar el archivo como JSON válido (${err.message}). ¿Es el .json que descargaste desde acá, sin modificar?`);
      }
    };
    reader.readAsText(file);
  };

  const handlePasteImport = () => {
    if (!pasteText.trim()) { setImportError("Pegá primero el contenido del archivo .json en el cuadro."); return; }
    try {
      setPendingData(parseAndValidate(pasteText));
      setImportError("");
    } catch (err) {
      setImportError(`No se pudo interpretar el texto como JSON válido (${err.message}). Asegurate de pegar el contenido completo del archivo, sin recortar.`);
    }
  };

  const confirmRestore = () => {
    onRestore(pendingData);
    setPendingData(null);
    setPasteText("");
  };

  return (
    <div className="space-y-6">
      <div className="border border-teal-800 rounded-lg p-4">
        <p className="text-sm font-semibold mb-1" style={F.body}>Descargar respaldo</p>
        <p className="text-xs text-teal-400 mb-3" style={F.body}>
          Baja un archivo con todos los organizadores, torneos, circuitos y anuncios cargados hasta ahora. Guardalo en tu celular o computadora.
        </p>
        <button type="button" onClick={downloadBackup} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
          Descargar respaldo (.json)
        </button>
      </div>

      <div className="border border-teal-800 rounded-lg p-4">
        <p className="text-sm font-semibold mb-1" style={F.body}>Restaurar desde un respaldo</p>
        <p className="text-xs text-teal-400 mb-3" style={F.body}>
          Si algún día la app vuelve a los datos de ejemplo, subí acá el último archivo que hayas descargado para recuperar todo.
        </p>
        <input type="file" accept=".json,application/json,text/plain" onChange={handleFile} className="text-sm" style={F.body} />
        {pickedFileName && <p className="text-xs text-teal-500 mt-2" style={F.body}>Archivo elegido: {pickedFileName}</p>}
        {reading && <p className="text-xs text-teal-400 mt-1" style={F.body}>Leyendo archivo…</p>}

        <div className="mt-4 pt-4 border-t border-teal-900">
          <p className="text-xs text-teal-400 mb-2" style={F.body}>
            ¿No se abre el selector de archivos? Abrí el .json descargado (con el Explorador de archivos, o "Archivos" en el celular), copiá todo su contenido y pegalo acá:
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='Pegá acá el contenido, ej: {"organizers": [...], "tournaments": [...], ...}'
            rows={4}
            className="w-full px-2 py-1.5 rounded border text-xs font-mono"
            style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
          />
          <button type="button" onClick={handlePasteImport} className="mt-2 px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
            Usar este texto
          </button>
        </div>

        {importError && <p className="text-sm text-red-400 mt-3" style={F.body}>{importError}</p>}
        {pendingData && (
          <div className="mt-3 text-sm" style={F.body}>
            <p className="text-amber-400 mb-2">
              ⚠ Esto reemplaza TODO lo que hay cargado ahora ({tournaments.length} torneo{tournaments.length !== 1 ? "s" : ""} actuales) por lo del archivo
              ({pendingData.tournaments.length} torneo{pendingData.tournaments.length !== 1 ? "s" : ""}, exportado el {pendingData.exportedAt ? new Date(pendingData.exportedAt).toLocaleString("es-AR") : "?"}). ¿Confirmás?
            </p>
            <button type="button" onClick={confirmRestore} className="text-red-400 font-semibold mr-3">Sí, restaurar</button>
            <button type="button" onClick={() => setPendingData(null)} className="text-teal-400">Cancelar</button>
          </div>
        )}
      </div>
    </div>
  );
}

function CreatorHome({ creator, organizers, tournaments, circuits, ads, onUpdateOrganizer, onCreateOrganizer, onDeleteOrganizer, onDeleteTournament, onDeleteCircuit, onAddAd, onUpdateAd, onDeleteAd, onRestoreBackup, onLogout }) {
  const [tab, setTab] = useState("organizadores"); // organizadores | publicidad | torneos | circuitos | respaldo

  const staff = organizers.filter((o) => o.role !== "creador");
  const organizerName = (id) => organizers.find((o) => o.id === id)?.name || "Organizador";

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl" style={F.display}>ADMINISTRACIÓN — {creator.name.toUpperCase()}</h1>
        <button onClick={onLogout} className="text-sm text-teal-400 hover:text-lime-400" style={F.body}>Cerrar sesión</button>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {[["organizadores", "Organizadores"], ["publicidad", "Publicidad"], ["torneos", "Torneos"], ["circuitos", "Circuitos"], ["respaldo", "Respaldo"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded text-sm border ${tab === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
            style={F.body}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "publicidad" ? (
        <AdManager ads={ads} onAdd={onAddAd} onUpdate={onUpdateAd} onDelete={onDeleteAd} accessToken={creator.accessToken} />
      ) : tab === "respaldo" ? (
        <BackupManager organizers={organizers} tournaments={tournaments} circuits={circuits} ads={ads} onRestore={onRestoreBackup} />
      ) : tab === "torneos" ? (
        <div>
          <p className="text-sm text-teal-400 mb-4" style={F.body}>Todos los torneos de la plataforma, de cualquier organizador. Podés eliminarlos si hace falta; editarlos sigue siendo tarea de cada organizador.</p>
          <div className="space-y-2">
            {tournaments.map((t) => (
              <CreatorTournamentRow key={t.id} t={t} organizerName={organizerName(t.organizerId)} onDelete={onDeleteTournament} />
            ))}
            {tournaments.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no hay torneos cargados.</p>}
          </div>
        </div>
      ) : tab === "circuitos" ? (
        <div>
          <p className="text-sm text-teal-400 mb-4" style={F.body}>Todos los circuitos de la plataforma, de cualquier organizador.</p>
          <div className="space-y-2">
            {circuits.map((c) => (
              <CreatorCircuitRow key={c.id} circuit={c} organizerName={organizerName(c.organizerId)} tournaments={tournaments} onDelete={onDeleteCircuit} />
            ))}
            {circuits.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no hay circuitos cargados.</p>}
          </div>
        </div>
      ) : (
        <>
          <NewOrganizerForm onCreate={onCreateOrganizer} />

          <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Organizadores</h2>
          <div className="space-y-2">
            {staff.map((o) => (
              <OrganizerRow
                key={o.id}
                o={o}
                count={tournaments.filter((t) => t.organizerId === o.id).length}
                onUpdateOrganizer={onUpdateOrganizer}
                onDeleteOrganizer={onDeleteOrganizer}
                accessToken={creator.accessToken}
              />
            ))}
            {staff.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no creaste cuentas de organizador.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function TournamentRow({ t, circuits, onOpen, onUpdate, onDelete, accessToken, pendingCount = 0 }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [date, setDate] = useState(t.date);
  const [venue, setVenue] = useState(t.venue || "");
  const [coverImageUrl, setCoverImageUrl] = useState(t.coverImageUrl || "");
  const [circuitId, setCircuitId] = useState(t.circuitId || "");
  const [registrationOpen, setRegistrationOpen] = useState(!!t.inscripcionesAbiertas);
  const [cupoTexts, setCupoTexts] = useState({}); // { [categoryId]: texto del cupo }
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const clasico = tournamentType(t) === "clasico";

  const startEditing = () => {
    setRegistrationOpen(!!t.inscripcionesAbiertas);
    setCupoTexts(Object.fromEntries(t.categories.map((c) => [c.id, c.cupo ? String(c.cupo) : ""])));
    setEditing(true);
  };

  if (editing) {
    return (
      <div className="p-4 rounded border border-lime-400">
        <p className="text-xs text-teal-400 mb-2" style={F.body}>Nombre, fecha, sede, imagen y circuito del torneo</p>
        <div className="flex flex-wrap gap-2 items-end mb-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          {clasico && (
            <select value={circuitId} onChange={(e) => setCircuitId(e.target.value)} className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
              <option value="">Sin circuito (torneo independiente)</option>
              {(circuits || []).map((c) => <option key={c.id} value={c.id}>{c.name} {c.year}</option>)}
            </select>
          )}
        </div>
        <label className="block text-xs text-teal-400 mb-1" style={F.body}>Sede (club / complejo donde se juega)</label>
        <input
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          placeholder="Ej: Complejo Los Sauces, Gualeguaychú"
          className="w-full mb-3 px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
        />
        <label className="block text-xs text-teal-400 mb-1" style={F.body}>Imagen de portada (se ve en la tarjeta pública)</label>
        <ImageUploadField value={coverImageUrl} onChange={setCoverImageUrl} accessToken={accessToken} folder="tournaments" />
        <div className="mt-3">
          <RegistrationSettings
            open={registrationOpen}
            onOpenChange={setRegistrationOpen}
            rows={t.categories.map((c) => ({ key: c.id, name: c.name, fixed: isSuper8(c) ? "8 (Súper 8)" : null, value: cupoTexts[c.id] ?? "" }))}
            onCupoChange={(key, text) => setCupoTexts({ ...cupoTexts, [key]: text })}
          />
        </div>
        <div className="flex flex-wrap gap-2 items-end mt-3">
          <button
            type="button"
            onClick={() => {
              if (!name.trim() || !date) return;
              // El Americano se juega en un solo día: si cambia la fecha del torneo, se mueve su día de juego
              const playDates = tournamentType(t) === "americano" && (t.playDates || []).length === 1 ? [{ ...t.playDates[0], date }] : t.playDates;
              const categories = t.categories.map((c) => {
                if (isSuper8(c)) return c;
                const { cupo, ...rest } = c;
                const next = parseCupo(cupoTexts[c.id] ?? "");
                return next ? { ...rest, cupo: next } : rest;
              });
              onUpdate({ ...t, name: name.trim(), date, venue: venue.trim(), coverImageUrl: coverImageUrl.trim(), circuitId: clasico ? circuitId || null : null, playDates, categories, inscripcionesAbiertas: registrationOpen });
              setEditing(false);
            }}
            className="px-3 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
          >
            Guardar
          </button>
          <button type="button" onClick={() => { setName(t.name); setDate(t.date); setVenue(t.venue || ""); setCoverImageUrl(t.coverImageUrl || ""); setCircuitId(t.circuitId || ""); setEditing(false); }} className="text-sm text-teal-400" style={F.body}>Cancelar</button>
        </div>
      </div>
    );
  }

  const totalPairs = t.categories.reduce((sum, c) => sum + c.pairs.length, 0);
  const bracketsGenerated = t.categories.filter((c) => c.bracket).length;
  const circuit = (circuits || []).find((c) => c.id === t.circuitId);
  const accent = { [STATUS.EN_CURSO]: "#9fe022", [STATUS.PROXIMO]: "#38bdf8", [STATUS.FINALIZADO]: "#64748b" }[t.status];

  return (
    <div className="p-4 rounded-lg transition" style={{ backgroundColor: accent + "0d", border: `1px solid ${accent}33`, borderLeft: `3px solid ${accent}` }}>
      <div className="flex justify-between items-start flex-wrap gap-3 mb-3">
        <div className="flex gap-3">
          {t.coverImageUrl && (
            <img src={t.coverImageUrl} alt="" className="w-16 h-16 object-cover rounded border border-teal-800 flex-shrink-0" />
          )}
          <div>
            <span style={F.body} className="block font-medium">{t.name}</span>
            <span className="text-xs text-teal-500" style={F.body}>
              {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" })}
              {" · "}{t.categories.length} categoría{t.categories.length !== 1 ? "s" : ""}
              {" · "}{totalPairs} pareja{totalPairs !== 1 ? "s" : ""}
              {bracketsGenerated > 0 ? ` · ${bracketsGenerated} llave${bracketsGenerated !== 1 ? "s" : ""} generada${bracketsGenerated !== 1 ? "s" : ""}` : ""}
              {t.venue ? ` · ${t.venue}` : ""}
            </span>
            <span className="inline-block mt-1 mr-1"><TournamentTypeTag tournament={t} /></span>
            {t.inscripcionesAbiertas && <span className="inline-block mt-1 mr-1"><OpenRegistrationsBadge tournament={t} /></span>}
            {pendingCount > 0 && (
              <span className="inline-block mt-1 mr-1 px-2.5 py-0.5 rounded-full text-[10px] sm:text-xs font-bold" style={{ ...F.body, backgroundColor: "#fb923c", color: "#14181f" }}>
                {pendingCount} {pendingCount === 1 ? "nueva" : "nuevas"}
              </span>
            )}
            {circuit && <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full border border-lime-800 text-lime-400" style={F.body}>Fecha de: {circuit.name}</span>}
          </div>
        </div>
        <Badge status={t.status} />
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <button
          type="button"
          onClick={() => onOpen(t.id)}
          className="px-4 py-2 rounded font-semibold text-sm"
          style={{ backgroundColor: "#9fe022", color: "#14181f" }}
        >
          Cargar parejas y grupos →
        </button>
        <div className="flex gap-3 items-center">
          <button type="button" onClick={startEditing} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>Editar datos e inscripciones</button>
          {!confirmingDelete ? (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
          ) : (
            <span className="text-sm">
              <button type="button" onClick={() => onDelete(t.id)} className="text-red-400 font-semibold mr-2" style={F.body}>Confirmar</button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* Editor de la escala de puntos por instancia (campeón, finalista, etc.) de un circuito */
function PointsScaleEditor({ scale, onChange }) {
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };
  const [texts, setTexts] = useState(() => Object.fromEntries(CIRCUIT_TIER_ORDER.map((t) => [t, String(scale[t])])));
  return (
    <div>
      <label className="block text-xs text-teal-400 mb-1" style={F.body}>Puntos que reparte por instancia</label>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {CIRCUIT_TIER_ORDER.map((tier) => (
          <div key={tier}>
            <label className="block text-[11px] text-teal-500 mb-0.5" style={F.body}>{CIRCUIT_TIER_LABEL[tier]}</label>
            <input
              type="number" min="0" inputMode="numeric"
              value={texts[tier] ?? scale[tier]}
              onChange={(e) => setTexts((t) => ({ ...t, [tier]: e.target.value }))}
              onBlur={() => {
                const raw = texts[tier];
                const n = Number(raw);
                const valid = raw !== undefined && raw.trim() !== "" && n >= 0;
                const final = valid ? n : scale[tier];
                setTexts((t) => ({ ...t, [tier]: String(final) }));
                if (final !== scale[tier]) onChange({ ...scale, [tier]: final });
              }}
              className="w-full px-2 py-1.5 rounded border text-sm" style={inputStyle}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function CircuitRow({ circuit, tournaments, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(circuit.name);
  const [year, setYear] = useState(circuit.year);
  const [categoriesText, setCategoriesText] = useState(circuit.categoryNames.join(", "));
  const [pointsScale, setPointsScale] = useState(circuit.pointsScale || DEFAULT_CIRCUIT_POINTS);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const fechas = tournaments.filter((t) => t.circuitId === circuit.id);
  const standings = useMemo(() => computeCircuitStandings(circuit, tournaments), [circuit, tournaments]);

  if (editing) {
    return (
      <div className="border border-lime-400 rounded-lg p-4 space-y-3">
        <div>
          <label className="block text-xs text-teal-400" style={F.body}>Nombre del circuito</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="block text-xs text-teal-400" style={F.body}>Temporada / año</label>
          <input value={year} onChange={(e) => setYear(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="2026" />
        </div>
        <div>
          <label className="block text-xs text-teal-400" style={F.body}>Categorías que suman puntos (separadas por coma)</label>
          <input value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="4ta Caballeros, 5ta Damas" />
          <p className="text-[11px] text-teal-600 mt-1" style={F.body}>Tiene que coincidir exactamente con el nombre de la categoría en cada torneo/fecha.</p>
        </div>
        <PointsScaleEditor scale={pointsScale} onChange={setPointsScale} />
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              const categoryNames = categoriesText.split(",").map((s) => s.trim()).filter(Boolean);
              if (name.trim() && categoryNames.length > 0) { onUpdate({ ...circuit, name: name.trim(), year: year.trim(), categoryNames, pointsScale }); setEditing(false); }
            }}
            className="px-3 py-1.5 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
          >
            Guardar
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-sm text-teal-400" style={F.body}>Cancelar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-teal-800 rounded-lg p-4">
      <div className="flex justify-between items-start flex-wrap gap-2">
        <div>
          <p className="font-medium" style={F.body}>{circuit.name} <span className="text-teal-500 text-sm">· {circuit.year}</span></p>
          <p className="text-xs text-teal-500" style={F.body}>{circuit.categoryNames.join(", ")} · {fechas.length} fecha{fechas.length !== 1 ? "s" : ""} cargada{fechas.length !== 1 ? "s" : ""}</p>
          <p className="text-[11px] text-teal-600 mt-1" style={F.body}>
            {CIRCUIT_TIER_ORDER.map((tier) => `${CIRCUIT_TIER_LABEL[tier]}: ${(circuit.pointsScale || DEFAULT_CIRCUIT_POINTS)[tier]}`).join(" · ")}
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <button type="button" onClick={() => setShowTable((v) => !v)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>{showTable ? "Ocultar tabla" : "Ver tabla"}</button>
          <button type="button" onClick={() => setEditing(true)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>Editar</button>
          {!confirmingDelete ? (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="text-sm text-red-400" style={F.body}>Eliminar</button>
          ) : (
            <span className="text-sm whitespace-nowrap">
              <button type="button" onClick={() => onDelete(circuit.id)} className="text-red-400 font-semibold mr-2" style={F.body}>Confirmar</button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="text-teal-400" style={F.body}>Cancelar</button>
            </span>
          )}
        </div>
      </div>

      {showTable && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {circuit.categoryNames.map((cn) => (
            <div key={cn}>
              <p className="text-xs uppercase tracking-wide text-teal-400 mb-1" style={F.body}>{cn}</p>
              {(standings[cn] || []).length === 0 ? (
                <p className="text-xs opacity-60" style={F.body}>Todavía sin puntos.</p>
              ) : (
                <table className="w-full text-sm" style={F.body}>
                  <thead><tr className="text-teal-500 text-left"><th>Jugador</th><th>Fechas</th><th>Pts</th></tr></thead>
                  <tbody>
                    {standings[cn].map((row, i) => (
                      <tr key={row.name} className="border-t border-teal-900">
                        <td className="py-1">{i + 1}. {row.name}</td><td>{row.fechas}</td><td className="font-semibold">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CircuitManager({ circuits, tournaments, onAdd, onUpdate, onDelete }) {
  const [name, setName] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [categoriesText, setCategoriesText] = useState("");
  const [pointsScale, setPointsScale] = useState(DEFAULT_CIRCUIT_POINTS);
  const inputStyle = { backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" };

  const submit = () => {
    const categoryNames = categoriesText.split(",").map((s) => s.trim()).filter(Boolean);
    if (!name.trim() || categoryNames.length === 0) return;
    onAdd({ name: name.trim(), year: year.trim(), categoryNames, pointsScale });
    setName(""); setCategoriesText(""); setPointsScale(DEFAULT_CIRCUIT_POINTS);
  };

  return (
    <div>
      <p className="text-sm text-teal-400 mb-4" style={F.body}>
        Un circuito agrupa varias fechas (torneos) que suman puntos individuales durante la temporada. Al crear o editar un torneo, elegís a qué circuito pertenece esa fecha (o "Sin circuito" si es independiente).
      </p>
      <div className="border border-teal-800 rounded-lg p-4 mb-6">
        <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Nuevo circuito</h2>
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="Circuito Entre Ríos" />
          </div>
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Temporada / año</label>
            <input value={year} onChange={(e) => setYear(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} />
          </div>
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Categorías (separadas por coma)</label>
            <input value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} className="w-full px-3 py-2 rounded border text-sm" style={inputStyle} placeholder="4ta Caballeros, 5ta Damas" />
          </div>
        </div>
        <div className="mb-3">
          <PointsScaleEditor scale={pointsScale} onChange={setPointsScale} />
        </div>
        <button type="button" onClick={submit} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>Crear circuito</button>
      </div>

      <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Mis circuitos</h2>
      <div className="space-y-3">
        {circuits.map((c) => <CircuitRow key={c.id} circuit={c} tournaments={tournaments} onUpdate={onUpdate} onDelete={onDelete} />)}
        {circuits.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no creaste ningún circuito.</p>}
      </div>
    </div>
  );
}

function AdminHome({ organizer, tournaments, circuits, onCreate, onOpen, onLogout, onUpdate, onDelete, onAddCircuit, onUpdateCircuit, onDeleteCircuit, onUpdateProfile, inscripciones }) {
  const [tab, setTab] = useState("torneos"); // torneos | circuitos
  const [creating, setCreating] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState(organizer.name);
  const [profileLogo, setProfileLogo] = useState(organizer.logoUrl || "");
  const [profileCover, setProfileCover] = useState(organizer.coverUrl || "");

  const saveProfile = () => {
    onUpdateProfile({ name: profileName.trim() || organizer.name, logoUrl: profileLogo.trim(), coverUrl: profileCover.trim() });
    setEditingProfile(false);
  };

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-3">
          {organizer.logoUrl && <img src={organizer.logoUrl} alt="" className="w-10 h-10 rounded-full object-cover border border-teal-700" />}
          <h1 className="text-xl" style={F.display}>PANEL — {organizer.name.toUpperCase()}</h1>
        </div>
        <button onClick={onLogout} className="text-sm text-teal-400 hover:text-lime-400" style={F.body}>Cerrar sesión</button>
      </div>

      <button type="button" onClick={() => setEditingProfile((v) => !v)} className="text-xs text-teal-400 hover:text-lime-400 mb-6" style={F.body}>
        {editingProfile ? "Ocultar" : "Editar nombre, logo y portada"}
      </button>

      {editingProfile && (
        <div className="border border-teal-800 rounded-lg p-4 mb-6 flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del organizador</label>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          </div>
          <div className="min-w-[220px]">
            <ImageUploadField label="Logo" value={profileLogo} onChange={setProfileLogo} accessToken={organizer.accessToken} folder="logos" />
          </div>
          <div className="min-w-[220px]">
            <ImageUploadField label="Foto de portada (fondo de tu tarjeta en el inicio)" value={profileCover} onChange={setProfileCover} accessToken={organizer.accessToken} folder="covers" />
          </div>
          <button type="button" onClick={saveProfile} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
            Guardar
          </button>
        </div>
      )}

      <div className="flex gap-2 mb-6">
        {[["torneos", "Torneos"], ["circuitos", "Circuitos"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded text-sm border ${tab === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
            style={F.body}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "circuitos" ? (
        <CircuitManager circuits={circuits} tournaments={tournaments} onAdd={onAddCircuit} onUpdate={onUpdateCircuit} onDelete={onDeleteCircuit} />
      ) : (
        <>
          <button type="button" onClick={() => setCreating(true)} className="px-4 py-2 rounded font-semibold mb-8" style={{ backgroundColor: "#9fe022", color: "#14181f", ...F.body }}>
            + Crear torneo
          </button>
          {creating && <CreateTournamentWizard circuits={circuits} onCreate={onCreate} onClose={() => setCreating(false)} />}

          <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Mis torneos</h2>
          <div className="space-y-2">
            {tournaments.map((t) => (
              <TournamentRow key={t.id} t={t} circuits={circuits} onOpen={onOpen} onUpdate={onUpdate} onDelete={onDelete} accessToken={organizer.accessToken} pendingCount={(inscripciones || []).filter((i) => i.torneo_id === t.id && i.estado === "pendiente").length} />
            ))}
            {tournaments.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no creaste torneos.</p>}
          </div>
        </>
      )}
    </div>
  );
}

/* Pestaña "Inscripciones" de un torneo: abrir/cerrar inscripciones y aceptar o rechazar las
   pendientes. Aceptar agrega la pareja a su categoría (lo hace el servidor, junto con marcarla como
   aceptada) y avisa antes si se pasa el cupo o si alguno de los jugadores ya juega otra categoría. */
function InscripcionesPanel({ tournament, update, inscripciones, onResolve }) {
  const [busyId, setBusyId] = useState(null);
  const [confirmRejectId, setConfirmRejectId] = useState(null);
  const [errors, setErrors] = useState({});
  const [showHistory, setShowHistory] = useState(false);
  const categoriesById = Object.fromEntries(tournament.categories.map((c) => [c.id, c]));
  const pending = inscripciones.filter((i) => i.estado === "pendiente").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const history = inscripciones.filter((i) => i.estado !== "pendiente");
  const when = (iso) => new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const names = (i) => (i.jugador2_nombre ? `${i.jugador1_nombre} / ${i.jugador2_nombre}` : i.jugador1_nombre);

  const resolve = async (i, accept) => {
    setBusyId(i.id);
    setErrors((e) => ({ ...e, [i.id]: null }));
    try {
      await onResolve(i, accept);
      setConfirmRejectId(null);
    } catch (err) {
      setErrors((e) => ({ ...e, [i.id]: inscripcionErrorText(err) }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={F.body}>
      <div className="mb-5">
        <Toggle
          checked={!!tournament.inscripcionesAbiertas}
          onChange={(v) => update({ ...tournament, inscripcionesAbiertas: v })}
          label="Inscripciones abiertas"
          description={tournament.inscripcionesAbiertas ? "El torneo aparece en la página pública con el botón \"Inscribirme\"." : "Nadie puede inscribirse desde la página pública."}
        />
        <p className="text-xs text-teal-500 mt-2">El cupo de cada categoría se cambia en "Editar datos e inscripciones", desde la lista de torneos.</p>
      </div>

      <h3 className="text-xs uppercase tracking-wide font-bold mb-2" style={{ color: "#fb923c" }}>Pendientes ({pending.length})</h3>
      {pending.length === 0 && <p className="text-sm opacity-60 mb-4">No hay inscripciones pendientes.</p>}
      <div className="space-y-3">
        {pending.map((i) => {
          const category = categoriesById[i.categoria_id];
          const left = category ? categorySpotsLeft(category) : null;
          const conflict = category ? findPlayerCategoryConflict(names(i), tournament, category.id) : null;
          const busy = busyId === i.id;
          return (
            <div key={i.id} className="rounded-xl p-3" style={{ ...neonStyle("#fb923c"), backgroundColor: "rgba(8,18,24,0.6)" }}>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <p className="text-base font-semibold">{names(i)}</p>
                <span className="text-[11px] text-teal-500">{when(i.created_at)}</span>
              </div>
              <p className="text-sm text-teal-300">{category ? category.name : <span className="text-amber-400">Categoría eliminada</span>}</p>
              <a href={`https://wa.me/${i.telefono}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-1 text-sm underline" style={{ color: BRAND.lime }}>
                WhatsApp {formatArPhone(i.telefono)}
              </a>
              {category && left === 0 && (
                <p className="text-xs text-amber-400 mt-2">
                  {isSuper8(category) ? "La categoría ya tiene sus 8 inscriptos: no se puede aceptar." : `Ojo: la categoría ya llegó al cupo (${categoryCupo(category)}). Si la aceptás, se supera.`}
                </p>
              )}
              {conflict && <p className="text-xs text-amber-400 mt-1">Uno de los jugadores ya está anotado en "{conflict}".</p>}
              {errors[i.id] && <p className="text-xs text-red-400 mt-1" role="alert">{errors[i.id]}</p>}
              <div className="flex gap-2 mt-3 flex-wrap">
                {confirmRejectId === i.id ? (
                  <>
                    <span className="text-sm text-teal-300 self-center mr-1">¿Rechazar esta inscripción?</span>
                    <button type="button" disabled={busy} onClick={() => resolve(i, false)} className="px-4 py-2 rounded-lg text-sm font-semibold border border-red-400 text-red-400 disabled:opacity-50">Sí, rechazar</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmRejectId(null)} className="px-4 py-2 rounded-lg text-sm text-teal-300">Cancelar</button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy || !category} onClick={() => resolve(i, true)} className="flex-1 min-w-[7rem] px-4 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50" style={{ backgroundColor: BRAND.lime, color: "#14181f" }}>
                      {busy ? "Guardando…" : "Aceptar"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirmRejectId(i.id)} className="flex-1 min-w-[7rem] px-4 py-2.5 rounded-lg text-sm font-semibold border border-red-400 text-red-400 disabled:opacity-50">
                      Rechazar
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {history.length > 0 && (
        <div className="mt-6">
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-sm text-teal-300 underline">
            {showHistory ? "Ocultar resueltas" : `Ver resueltas (${history.length})`}
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1 text-sm">
              {history.map((i) => (
                <li key={i.id} className="flex justify-between gap-2 border-b border-teal-900 py-1.5">
                  <span className="min-w-0 truncate">{names(i)} <span className="text-teal-500">· {categoriesById[i.categoria_id]?.name || "—"}</span></span>
                  <span className={`shrink-0 text-xs font-semibold ${i.estado === "aceptada" ? "text-lime-400" : "text-red-400"}`}>{i.estado === "aceptada" ? "Aceptada" : "Rechazada"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* Pestaña "Partidos y posiciones" de una categoría Súper 8: genera el cuadro fijo de partidos
   (numerando a los jugadores/parejas por orden de inscripción o por sorteo) y después muestra la
   carga de resultados ronda por ronda con la tabla de posiciones debajo. */
function Super8AdminPanel({ category, format, scheduled, onUpdateCategory, onGroupsLocked, onSetScore, onWalkover }) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const individual = category.format === "super8_individual";
  const entryWord = individual ? "jugadores" : "parejas";
  const group = category.groups[0];
  const pairsById = useMemo(() => categoryEntitiesById(category), [category]);
  const anyResult = !!group && group.matches.some((m) => matchIsPlayed(m));

  const generate = (shuffle) => {
    const ids = category.pairs.map((p) => p.id);
    if (shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
    const built = buildSuper8Group(category.format, ids);
    if (!built) return;
    // Igual que al cerrar los grupos: se dispara el armado automático de horarios del torneo
    (onGroupsLocked || onUpdateCategory)({ ...category, groups: [built.group], teams: built.teams, bracket: null });
  };

  const reset = () => {
    onUpdateCategory({ ...category, groups: [], teams: [] });
    setConfirmingReset(false);
  };

  if (!group) {
    const ready = category.pairs.length === SUPER8_SIZE;
    return (
      <div className="border border-lime-800 rounded-lg p-4" style={{ backgroundColor: "rgba(163,230,53,0.05)" }}>
        <p className="text-sm font-semibold mb-1" style={F.body}>Generar partidos</p>
        <p className="text-xs text-teal-400 mb-3" style={F.body}>
          Se numera a los {entryWord} del 1 al {SUPER8_SIZE} y se arma el cuadro fijo de {individual ? 14 : 28} partidos en 7 rondas.{scheduled ? " Si ya cargaste fechas y canchas, los horarios se asignan solos." : ""}
        </p>
        {!ready && (
          <p className="text-xs text-amber-400 mb-3" style={F.body}>
            Faltan {entryWord}: hay {category.pairs.length} de {SUPER8_SIZE}. Cargalos en la pestaña anterior.
          </p>
        )}
        <div className="flex gap-2 flex-wrap">
          <button type="button" disabled={!ready} onClick={() => generate(false)} className="px-4 py-2 rounded font-semibold text-sm disabled:opacity-40" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>
            Numerar por orden de inscripción
          </button>
          <button type="button" disabled={!ready} onClick={() => generate(true)} className="px-4 py-2 rounded font-semibold text-sm border border-lime-400 text-lime-400 disabled:opacity-40">
            Numerar al azar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-teal-800 rounded-lg p-4 mb-6">
        <p className="text-xs text-teal-400 mb-2" style={F.body}>Numeración</p>
        <ol className="flex flex-wrap gap-2 text-sm" style={F.body}>
          {group.pairIds.map((pid, i) => (
            <li key={pid} className="border border-teal-800 rounded px-2 py-1">
              <span className="text-lime-400 font-semibold mr-1">{i + 1}.</span>{pairsById[pid]?.name || "—"}
            </li>
          ))}
        </ol>
        {!anyResult && (
          <div className="mt-3 text-xs" style={F.body}>
            {confirmingReset ? (
              <span>
                <span className="text-teal-300 mr-2">Se borran los partidos y sus horarios. ¿Confirmás?</span>
                <button type="button" onClick={reset} className="text-red-400 font-semibold mr-2">Sí, reiniciar</button>
                <button type="button" onClick={() => setConfirmingReset(false)} className="text-teal-400">Cancelar</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmingReset(true)} className="text-red-400">Reiniciar partidos</button>
            )}
          </div>
        )}
      </div>
      <Super8View category={category} format={format} onSetScore={onSetScore} onWalkover={onWalkover} />
    </div>
  );
}

function CategoryAdminView({ category, format, playDates, tournament, onUpdateCategory, onGroupsLocked }) {
  const [tab, setTab] = useState("parejas");
  const [pairName, setPairName] = useState("");
  const [pairError, setPairError] = useState("");
  const [editingPairId, setEditingPairId] = useState(null);
  const [editPairName, setEditPairName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupSelection, setGroupSelection] = useState([]);
  const [confirmingAutoGroups, setConfirmingAutoGroups] = useState(false);
  const [groupWarnings, setGroupWarnings] = useState([]);
  const pairsById = useMemo(() => categoryEntitiesById(category), [category]);
  const assignedPairIds = useMemo(() => new Set(category.groups.flatMap((g) => g.pairIds)), [category.groups]);
  const super8 = isSuper8(category);
  const individual = category.format === "super8_individual";
  const super8Generated = super8 && category.groups.length > 0;
  const usesSchedule = tournamentUsesSchedule(tournament);

  const addPair = () => {
    if (!pairName.trim()) return;
    if (super8Generated) { setPairError("Los partidos del Súper 8 ya están generados. Para cambiar la lista, reiniciá los partidos primero."); return; }
    if (super8 && category.pairs.length >= SUPER8_SIZE) { setPairError(`El Súper 8 es para exactamente ${SUPER8_SIZE} ${individual ? "jugadores" : "parejas"}.`); return; }
    const conflict = findPlayerCategoryConflict(pairName, tournament, category.id);
    if (conflict) { setPairError(`Uno de los jugadores ya está anotado en la categoría "${conflict}". Una pareja/jugador solo puede jugar una categoría por torneo.`); return; }
    setPairError("");
    onUpdateCategory({ ...category, pairs: [...category.pairs, { id: uid(), name: pairName.trim(), availability: [] }] });
    setPairName("");
  };

  const updatePairAvailability = (pairId, availability) => {
    onUpdateCategory({ ...category, pairs: category.pairs.map((p) => (p.id === pairId ? { ...p, availability } : p)) });
  };

  const removePair = (id) => {
    onUpdateCategory({
      ...category,
      pairs: category.pairs.filter((p) => p.id !== id),
      groups: category.groups.map((g) => ({ ...g, pairIds: g.pairIds.filter((pid) => pid !== id) })),
    });
  };

  // La edición de nombre/jugadores de una pareja solo se permite mientras no haya jugado su primer partido
  const startEditPair = (p) => { setEditingPairId(p.id); setEditPairName(p.name); };
  const cancelEditPair = () => { setEditingPairId(null); setEditPairName(""); };
  const saveEditPair = (id) => {
    if (!editPairName.trim()) return;
    onUpdateCategory({ ...category, pairs: category.pairs.map((p) => (p.id === id ? { ...p, name: editPairName.trim() } : p)) });
    setEditingPairId(null);
    setEditPairName("");
  };

  const createGroup = () => {
    if (!groupName.trim() || groupSelection.length < 2) return;
    const built = buildGroupMatches(groupSelection);
    const group = { id: uid(), name: groupName.trim(), pairIds: groupSelection, format: built.format, matches: built.matches, qualifiersCount: 2 };
    (onGroupsLocked || onUpdateCategory)({ ...category, groups: [...category.groups, group] });
    setGroupName(""); setGroupSelection([]);
  };

  const runAutoGroups = () => {
    const { groups, warnings } = autoFormGroups(category.pairs, playDates);
    (onGroupsLocked || onUpdateCategory)({ ...category, groups: groups.map((g) => ({ ...g, qualifiersCount: 2 })), bracket: null });
    setGroupWarnings(warnings);
    setConfirmingAutoGroups(false);
  };

  const setGroupQualifiers = (groupId, count) => {
    onUpdateCategory({ ...category, groups: category.groups.map((g) => (g.id === groupId ? { ...g, qualifiersCount: count } : g)) });
  };

  const setMatchSetScore = (groupId, matchId, setIndex, side, value) => {
    onUpdateCategory({
      ...category,
      groups: category.groups.map((g) => {
        if (g.id !== groupId) return g;
        let matches = g.matches.map((m) => m.id === matchId ? { ...m, sets: withSetScore(m.sets, setIndex, side, value) } : m);
        // En grupos de 4, apenas se cargan los partidos 1 y 2 se arman solos los cruces de ganadores/perdedores
        if (g.format === "bracket4") matches = propagateGroupBracket4(matches);
        return { ...g, matches };
      }),
    });
  };

  const setGroupWalkover = (groupId, matchId, walkoverPairId) => {
    onUpdateCategory({
      ...category,
      groups: category.groups.map((g) => {
        if (g.id !== groupId) return g;
        let matches = g.matches.map((m) => (m.id === matchId ? { ...m, walkover: walkoverPairId, sets: walkoverPairId ? [] : m.sets, liveStatus: null } : m));
        if (g.format === "bracket4") matches = propagateGroupBracket4(matches);
        return { ...g, matches };
      }),
    });
  };

  const generateBracketFromPairs = (pairIds) => {
    const withBracket = { ...category, bracket: buildBracket(pairIds), bracketPublished: false };
    onUpdateCategory(autoScheduleBracket(tournament, withBracket));
  };

  // Si ya había un esqueleto precargado (bracketIsSkeleton) con horarios puestos a mano o por
  // autoScheduleBracket, los mismos horarios se copian al bracket real ronda por ronda / casillero
  // por casillero, para no perder lo ya programado.
  const carrySkeletonSchedules = (skeletonRounds, realRounds) => {
    if (!skeletonRounds) return realRounds;
    return realRounds.map((round, ri) => round.map((m, mi) => {
      const prev = skeletonRounds[ri]?.[mi];
      return prev?.schedule ? { ...m, schedule: prev.schedule } : m;
    }));
  };

  const generateBracketFromGroups = () => {
    const seeding = buildKnockoutSeeding(category.groups, pairsById, format);
    const realBracket = carrySkeletonSchedules(category.bracketIsSkeleton ? category.bracket : null, buildSeededBracket(seeding));
    const withBracket = { ...category, bracket: realBracket, bracketIsSkeleton: false, bracketPublished: category.bracketIsSkeleton ? category.bracketPublished : false };
    onUpdateCategory(autoScheduleBracket(tournament, withBracket));
  };

  // Precarga SOLO la estructura de la llave (fechas/horas/canchas) apenas se cierran los grupos,
  // sin esperar a saber qué pareja concreta clasifica a cada lugar. Usa placeholders tipo
  // "1° Grupo A vs 2° Grupo B". Cuando después se genera la llave real (generateBracketFromGroups),
  // los horarios ya cargados en este esqueleto se conservan.
  const generatePlaceholderBracket = () => {
    const skeleton = buildPlaceholderBracket(category.groups);
    if (!skeleton) return;
    const withBracket = { ...category, bracket: skeleton, bracketIsSkeleton: true, bracketPublished: false };
    onUpdateCategory(autoScheduleBracket(tournament, withBracket));
  };

  const [editingCrosses, setEditingCrosses] = useState(false);
  const [swapA, setSwapA] = useState("");
  const [swapB, setSwapB] = useState("");

  const [editingGroups, setEditingGroups] = useState(false);
  const [moveGroupPairId, setMoveGroupPairId] = useState("");
  const [moveGroupTargetId, setMoveGroupTargetId] = useState("");

  // Solo se puede editar la composición de los grupos mientras ningún partido de zona esté jugado.
  const anyGroupHasResults = category.groups.some((g) => g.matches.some((m) => matchIsPlayed(m)));

  const applyMoveGroupPair = () => {
    if (!moveGroupPairId || !moveGroupTargetId) return;
    const fromGroup = category.groups.find((g) => g.pairIds.includes(moveGroupPairId));
    if (!fromGroup || fromGroup.id === moveGroupTargetId) return;
    onUpdateCategory({ ...category, groups: moveGroupPair(category.groups, moveGroupPairId, fromGroup.id, moveGroupTargetId), bracket: null });
    setMoveGroupPairId(""); setMoveGroupTargetId("");
  };

  const round1HasResults = category.bracket && category.bracket[0].some((m) => matchIsPlayed(m));

  const applySwap = () => {
    if (!swapA || !swapB || swapA === swapB) return;
    onUpdateCategory({ ...category, bracket: swapBracketPairs(category.bracket, swapA, swapB) });
    setSwapA(""); setSwapB("");
  };

  const setBracketSetScore = (matchId, setIndex, side, value) => {
    const rounds = category.bracket.map((r) => r.map((m) => m.id === matchId ? { ...m, sets: withSetScore(m.sets, setIndex, side, value) } : m));
    onUpdateCategory({ ...category, bracket: propagateBracket(rounds) });
  };

  const setBracketWalkover = (matchId, walkoverPairId) => {
    const rounds = category.bracket.map((r) => r.map((m) => m.id === matchId ? { ...m, walkover: walkoverPairId, sets: walkoverPairId ? [] : m.sets, liveStatus: null } : m));
    onUpdateCategory({ ...category, bracket: propagateBracket(rounds) });
  };

  const categoryTabs = super8
    ? [["parejas", individual ? "1. Jugadores" : "1. Parejas"], ["super8", "2. Partidos y posiciones"]]
    : [["parejas", "1. Parejas"], ["grupos", "2. Grupos"], ["llave", "3. Llave final"]];

  return (
    <div>
      {super8 && (
        <p className="text-xs text-teal-400 mb-4" style={F.body}>
          Formato <span className="text-lime-400 font-semibold">{CATEGORY_FORMAT_LABEL[category.format]}</span>: {individual
            ? `${SUPER8_SIZE} jugadores sueltos. Cada uno juega una vez con cada otro como compañero y dos veces contra cada otro como rival.`
            : `${SUPER8_SIZE} parejas armadas, todas contra todas.`} No hay llave: termina en tabla de posiciones.
        </p>
      )}
      <div className="flex gap-2 mb-6 border-b border-teal-800">
        {categoryTabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-sm ${tab === key ? "border-b-2 border-lime-400 text-lime-400" : "text-teal-400"}`} style={F.body}>
            {label}
          </button>
        ))}
      </div>

      {tab === "parejas" && (
        <div>
          <div className="flex gap-2 mb-1">
            <input
              value={pairName}
              onChange={(e) => setPairName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addPair(); }}
              placeholder={individual ? "Ej: Pérez" : "Ej: Pérez / López"}
              className="flex-1 px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
            />
            <button type="button" onClick={addPair} className="px-4 py-2 rounded font-semibold" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>Agregar</button>
          </div>
          {pairError && <p className="text-xs text-red-400 mb-3" style={F.body}>{pairError}</p>}
          <p className="text-[11px] text-teal-600 mb-3" style={F.body}>Una pareja/jugador solo puede estar anotado en una categoría de este torneo.</p>
          <ul className="space-y-2">
            {category.pairs.map((p) => {
              const played = pairHasPlayed(category, p.id);
              const isEditing = editingPairId === p.id;
              return (
                <li key={p.id} className="border border-teal-800 rounded px-3 py-2">
                  <div className="flex justify-between items-center gap-2 flex-wrap">
                    {isEditing ? (
                      <input
                        value={editPairName}
                        onChange={(e) => setEditPairName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEditPair(p.id); }}
                        autoFocus
                        className="flex-1 min-w-[140px] px-2 py-1 rounded border text-sm outline-none focus:border-lime-400"
                        style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                      />
                    ) : (
                      <span style={F.body}>{p.name}</span>
                    )}
                    <div className="flex items-center gap-2 shrink-0">
                      {isEditing ? (
                        <>
                          <button type="button" onClick={() => saveEditPair(p.id)} className="text-sm text-lime-400">Guardar</button>
                          <button type="button" onClick={cancelEditPair} className="text-sm text-teal-400">Cancelar</button>
                        </>
                      ) : played ? (
                        <span className="text-[11px] text-teal-600 italic">Ya jugó · nombre bloqueado</span>
                      ) : (
                        <button type="button" onClick={() => startEditPair(p)} className="text-sm text-teal-300">Editar</button>
                      )}
                      {!super8Generated && <button type="button" onClick={() => removePair(p.id)} className="text-sm text-red-400">Quitar</button>}
                    </div>
                  </div>
                  {usesSchedule && <PairAvailabilityEditor pair={p} playDates={playDates || []} onChange={(availability) => updatePairAvailability(p.id, availability)} />}
                </li>
              );
            })}
            {category.pairs.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no hay {individual ? "jugadores" : "parejas"} en esta categoría.</p>}
          </ul>
          {super8 && (
            <p className="text-xs text-teal-500 mt-3" style={F.body}>
              {category.pairs.length} de {SUPER8_SIZE} {individual ? "jugadores anotados" : "parejas anotadas"}.
            </p>
          )}
        </div>
      )}

      {tab === "super8" && (
        <Super8AdminPanel
          category={category}
          format={format}
          scheduled={usesSchedule}
          onUpdateCategory={onUpdateCategory}
          onGroupsLocked={onGroupsLocked}
          onSetScore={setMatchSetScore}
          onWalkover={setGroupWalkover}
        />
      )}

      {tab === "grupos" && (
        <div>
          <div className="border border-lime-800 rounded-lg p-4 mb-6" style={{ backgroundColor: "rgba(163,230,53,0.05)" }}>
            <p className="text-sm font-semibold mb-1" style={F.body}>Armado automático (sorteo por disponibilidad)</p>
            <p className="text-xs text-teal-400 mb-3" style={F.body}>
              Arma grupos de 3 parejas (como se juega en pádel), dejando un grupo de 4 solo con la o las que sobran, priorizando juntar a quienes comparten fechas disponibles. Reemplaza los grupos actuales.
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              {!confirmingAutoGroups ? (
                <button
                  type="button"
                  disabled={category.pairs.length < 2}
                  onClick={() => setConfirmingAutoGroups(true)}
                  className="px-4 py-2 rounded font-semibold text-sm disabled:opacity-40"
                  style={{ backgroundColor: "#9fe022", color: "#14181f" }}
                >
                  Sortear grupos
                </button>
              ) : (
                <span className="text-sm">
                  <span className="text-teal-300 mr-2" style={F.body}>
                    {category.groups.length > 0 ? "Esto reemplaza los grupos y resultados actuales. " : ""}¿Confirmás el sorteo?
                  </span>
                  <button type="button" onClick={runAutoGroups} className="text-red-400 font-semibold mr-2" style={F.body}>Sí, sortear</button>
                  <button type="button" onClick={() => setConfirmingAutoGroups(false)} className="text-teal-400" style={F.body}>Cancelar</button>
                </span>
              )}
            </div>
            {groupWarnings.length > 0 && (
              <p className="text-xs text-amber-400 mt-3" style={F.body}>
                ⚠ No comparten ningún día disponible con el resto de su grupo, quedaron ubicadas igual porque no había otra opción: {groupWarnings.join(", ")}. Revisá su disponibilidad o ajustá el grupo a mano.
              </p>
            )}
          </div>

          <div className="border border-teal-800 rounded-lg p-4 mb-6">
            <p className="text-xs text-teal-400 mb-2" style={F.body}>O armá un grupo a mano:</p>
            <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del grupo</label>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} className="w-full mb-3 px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} placeholder="Grupo A" />
            <p className="text-xs text-teal-400 mb-2" style={F.body}>Elegí las parejas del grupo</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {category.pairs.filter((p) => !assignedPairIds.has(p.id)).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm border border-teal-800 rounded px-2 py-1">
                  <input type="checkbox" checked={groupSelection.includes(p.id)} onChange={(e) => {
                    setGroupSelection((sel) => e.target.checked ? [...sel, p.id] : sel.filter((id) => id !== p.id));
                  }} />
                  {p.name}
                </label>
              ))}
              {category.pairs.filter((p) => !assignedPairIds.has(p.id)).length === 0 && (
                <p className="text-xs opacity-60" style={F.body}>Todas las parejas ya están en un grupo.</p>
              )}
            </div>
            <button type="button" onClick={createGroup} className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}>Crear grupo (round robin automático)</button>
          </div>

          {category.groups.map((g, gi) => {
            const color = GROUP_COLORS[gi % GROUP_COLORS.length];
            return (
              <div key={g.id} className="rounded-xl p-4 mb-6 min-w-0" style={{ backgroundColor: color + "0d", border: `1px solid ${color}33` }}>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <SkewPill color={color}>{g.name}</SkewPill>
                  <label className="flex items-center gap-1 text-[11px] text-teal-500" style={F.body}>
                    Clasifican:
                    <select
                      value={g.qualifiersCount || 2}
                      onChange={(e) => setGroupQualifiers(g.id, parseInt(e.target.value, 10))}
                      className="px-1.5 py-0.5 rounded border outline-none text-[11px]"
                      style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                    >
                      {Array.from({ length: Math.max(g.pairIds.length - 1, 1) }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mb-4"><StandingsTable group={g} pairsById={pairsById} format={format} accentColor={color} highlightCount={groupQualifiersCount(g)} /></div>
                <div className="space-y-3">
                  {g.matches.map((m) => {
                    const stageLabel = groupMatchStageLabel(g, m);
                    const editable = m.pairA && m.pairB;
                    const hasResult = matchIsPlayed(m);
                    const w = hasResult ? matchWinnerId(m) : null;
                    const winnerIsA = w == null ? null : w === m.pairA;
                    return (
                      <div key={m.id} className="flex items-start justify-between gap-3 text-sm flex-wrap">
                        <div className="min-w-0">
                          {stageLabel && <span className="text-[10px] text-teal-500 block mb-1">{stageLabel}</span>}
                          <div className="flex items-center gap-1 flex-wrap" style={F.body}>
                            {w === m.pairA && <WinnerCheck />}
                            <GroupPairName id={m.pairA} pairsById={pairsById} />
                          </div>
                          <div className="flex items-center gap-1 flex-wrap" style={F.body}>
                            {w === m.pairB && <WinnerCheck />}
                            <GroupPairName id={m.pairB} pairsById={pairsById} />
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5" style={F.body}>
                            {hasResult && <span className="font-mono text-xs text-teal-300"><MatchResultLabel match={m} winnerIsA={winnerIsA} /></span>}
                            {m.schedule && <ScheduleLabel schedule={m.schedule} />}
                          </div>
                        </div>
                        {editable && (
                          <div className="flex flex-col items-end gap-1">
                            <MatchSetsEditor
                              sets={m.sets}
                              format={format}
                              onSetScore={(setIndex, side, value) => setMatchSetScore(g.id, m.id, setIndex, side, value)}
                            />
                            <div className="flex gap-2 flex-wrap justify-end text-[10px]">
                              {m.walkover ? (
                                <button type="button" onClick={() => setGroupWalkover(g.id, m.id, null)} className="text-teal-400 underline">Deshacer WO</button>
                              ) : (
                                <>
                                  <button type="button" onClick={() => setGroupWalkover(g.id, m.id, m.pairA)} className="text-amber-400 underline">WO {pairsById[m.pairA]?.name || "pareja 1"}</button>
                                  <button type="button" onClick={() => setGroupWalkover(g.id, m.id, m.pairB)} className="text-amber-400 underline">WO {pairsById[m.pairB]?.name || "pareja 2"}</button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {category.groups.length > 0 && <StandingsLegend />}
          {category.groups.length > 1 && !anyGroupHasResults && (
            <div className="border border-teal-800 rounded-lg p-4 mt-4">
              <button
                type="button"
                onClick={() => { setEditingGroups((v) => !v); setMoveGroupPairId(""); setMoveGroupTargetId(""); }}
                className="text-sm text-teal-300 hover:text-lime-400"
                style={F.body}
              >
                {editingGroups ? "Ocultar edición de grupos" : "Editar grupos manualmente"}
              </button>
              {editingGroups && (
                <div className="mt-3 flex flex-wrap gap-3 items-end">
                  <p className="w-full text-xs text-teal-500" style={F.body}>
                    Elegí una pareja y el grupo al que se quiere mover.
                  </p>
                  <select value={moveGroupPairId} onChange={(e) => setMoveGroupPairId(e.target.value)} className="px-3 py-2 rounded border outline-none" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
                    <option value="">Pareja…</option>
                    {category.groups.flatMap((g) => g.pairIds.map((pid) => ({ pid, gname: g.name }))).map(({ pid, gname }) => (
                      <option key={pid} value={pid}>{pairsById[pid]?.name || pid} ({gname})</option>
                    ))}
                  </select>
                  <select value={moveGroupTargetId} onChange={(e) => setMoveGroupTargetId(e.target.value)} className="px-3 py-2 rounded border outline-none" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
                    <option value="">Mover a grupo…</option>
                    {category.groups.filter((g) => !g.pairIds.includes(moveGroupPairId)).map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={applyMoveGroupPair}
                    disabled={!moveGroupPairId || !moveGroupTargetId}
                    className="px-4 py-2 rounded text-sm font-semibold disabled:opacity-40"
                    style={{ backgroundColor: "#a3e635", color: "#0f172a" }}
                  >
                    Mover pareja
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "llave" && (
        <div>
          {usesSchedule && !category.bracket && category.groups.length > 0 && (
            <div className="border border-purple-800 rounded-lg p-4 mb-4">
              <p className="text-sm mb-3" style={{ ...F.body, color: "#a78bfa" }}>
                Todavía no terminaron los grupos, pero ya podés precargar la estructura de la llave (fechas, horarios y canchas de octavos, cuartos, semis y final) usando "1°, 2°..." de cada grupo. Cuando se sepan las parejas clasificadas, se completan solas en los horarios que ya hayas cargado.
              </p>
              <button
                onClick={generatePlaceholderBracket}
                className="px-4 py-2 rounded font-semibold text-sm"
                style={{ backgroundColor: "#a78bfa", color: "#14181f" }}
              >
                Precargar estructura de la llave
              </button>
            </div>
          )}
          {!category.bracket && (
            <div className="border border-teal-800 rounded-lg p-4 mb-6">
              <p className="text-sm text-teal-300 mb-3" style={F.body}>
                Generá la llave final con los clasificados de cada grupo: pasan tantas parejas como elegiste en "Clasifican" de cada grupo (si no hay grupos, se usan todas las parejas). Los cruces se arman entre grupos distintos, para que un 1° nunca se enfrente con el 2° de su propio grupo en la primera ronda, y si la cantidad no cierra, los mejor ubicados pasan directo a la ronda siguiente.
              </p>
              <button
                onClick={() => {
                  if (category.groups.length > 0) {
                    generateBracketFromGroups();
                  } else {
                    generateBracketFromPairs(category.pairs.map((p) => p.id));
                  }
                }}
                className="px-4 py-2 rounded font-semibold text-sm"
                style={{ backgroundColor: "#9fe022", color: "#14181f" }}
              >
                Generar llave final
              </button>
            </div>
          )}
          {category.bracketIsSkeleton && category.bracket && (
            <div className="border border-purple-800 rounded-lg p-4 mb-6">
              <p className="text-sm mb-3" style={{ ...F.body, color: "#a78bfa" }}>
                Esta es la estructura precargada de la llave, todavía sin parejas confirmadas. Podés seguir ajustando los horarios en la grilla. Cuando los grupos terminen, generá la llave final desde la pestaña de grupos para completar las parejas.
              </p>
              {category.groups.length > 0 && category.groups.every((g) => g.matches.every((m) => matchIsPlayed(m))) && (
                <button
                  onClick={generateBracketFromGroups}
                  className="px-4 py-2 rounded font-semibold text-sm"
                  style={{ backgroundColor: "#9fe022", color: "#14181f" }}
                >
                  Completar llave con las parejas clasificadas
                </button>
              )}
            </div>
          )}
          {category.bracket && !round1HasResults && (
            <div className="border border-teal-800 rounded-lg p-4 mb-6">
              <button
                type="button"
                onClick={() => { setEditingCrosses((v) => !v); setSwapA(""); setSwapB(""); }}
                className="text-sm text-teal-300 hover:text-lime-400"
                style={F.body}
              >
                {editingCrosses ? "Ocultar edición de cruces" : "Editar cruces manualmente"}
              </button>
              {editingCrosses && (
                <div className="mt-3 flex flex-wrap gap-3 items-end">
                  <p className="w-full text-xs text-teal-500" style={F.body}>
                    Elegí dos parejas para que intercambien de lugar en la primera ronda de la llave.
                  </p>
                  <select value={swapA} onChange={(e) => setSwapA(e.target.value)} className="px-3 py-2 rounded border outline-none" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
                    <option value="">Pareja 1…</option>
                    {category.bracket[0].flatMap((m) => [m.pairA, m.pairB]).filter(Boolean).map((pid) => (
                      <option key={pid} value={pid}>{pairsById[pid]?.name || pid}</option>
                    ))}
                  </select>
                  <select value={swapB} onChange={(e) => setSwapB(e.target.value)} className="px-3 py-2 rounded border outline-none" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
                    <option value="">Pareja 2…</option>
                    {category.bracket[0].flatMap((m) => [m.pairA, m.pairB]).filter(Boolean).map((pid) => (
                      <option key={pid} value={pid}>{pairsById[pid]?.name || pid}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!swapA || !swapB || swapA === swapB}
                    onClick={applySwap}
                    className="px-4 py-2 rounded font-semibold text-sm disabled:opacity-40"
                    style={{ backgroundColor: "#9fe022", color: "#14181f" }}
                  >
                    Intercambiar
                  </button>
                </div>
              )}
            </div>
          )}
          {category.bracket && (
            <div className="flex gap-8 overflow-x-auto pb-4">
              {category.bracket.map((round, ri) => {
                const isFinal = ri === category.bracket.length - 1;
                const color = GROUP_COLORS[(category.bracket.length - 1 - ri) % GROUP_COLORS.length];
                return (
                  <div key={ri} className="flex flex-col justify-around gap-4 min-w-[240px]">
                    <span
                      className="self-start px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide"
                      style={{ backgroundColor: color, color: "#14181f" }}
                    >
                      {isFinal ? "🏆 " : ""}{roundStageLabel(category.bracket.length, ri)}
                    </span>
                    {round.map((m) => {
                      const editable = m.pairA && m.pairB;
                      const w = winnerOf(m);
                      return (
                        <div key={m.id} className="rounded-lg p-3 text-sm space-y-2" style={{ ...F.body, backgroundColor: color + "0d", border: `1px solid ${color}40` }}>
                          <ScheduleLabel schedule={m.schedule} />
                          {m.walkover ? (
                            <p className="text-amber-400 font-semibold text-xs">WO</p>
                          ) : (() => {
                            const { a: setsA, b: setsB } = setsWon(m);
                            return (
                              <>
                                <div className={`flex justify-between items-center gap-2 ${w && w === m.pairA ? "font-semibold" : ""}`} style={w && w === m.pairA ? { color } : undefined}>
                                  <span className="flex items-center gap-1">{w === m.pairA && <WinnerCheck />}<PairName id={m.pairA} pairsById={pairsById} /></span>
                                  {editable && <span>{matchIsPlayed(m) ? setsA : ""}</span>}
                                </div>
                                <div className={`flex justify-between items-center gap-2 ${w && w === m.pairB ? "font-semibold" : ""}`} style={w && w === m.pairB ? { color } : undefined}>
                                  <span className="flex items-center gap-1">{w === m.pairB && <WinnerCheck />}<PairName id={m.pairB} pairsById={pairsById} /></span>
                                  {editable && <span>{matchIsPlayed(m) ? setsB : ""}</span>}
                                </div>
                              </>
                            );
                          })()}
                          {editable && (
                            <>
                              <MatchSetsEditor
                                sets={m.sets}
                                format={format}
                                onSetScore={(setIndex, side, value) => setBracketSetScore(m.id, setIndex, side, value)}
                              />
                              <div className="flex gap-2 flex-wrap text-[10px]">
                                {m.walkover ? (
                                  <button type="button" onClick={() => setBracketWalkover(m.id, null)} className="text-teal-400 underline">Deshacer WO</button>
                                ) : (
                                  <>
                                    <button type="button" onClick={() => setBracketWalkover(m.id, m.pairA)} className="text-amber-400 underline">WO {pairsById[m.pairA]?.name || "pareja 1"}</button>
                                    <button type="button" onClick={() => setBracketWalkover(m.id, m.pairB)} className="text-amber-400 underline">WO {pairsById[m.pairB]?.name || "pareja 2"}</button>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              <button onClick={() => onUpdateCategory({ ...category, bracket: null })} className="text-xs text-red-400 self-start" style={F.body}>Reiniciar llave</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryTabs({ categories, activeId, onSelect, onAdd, onRename, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const submitNew = () => {
    if (!newName.trim()) return;
    onAdd(newName.trim());
    setNewName(""); setAdding(false);
  };
  const [editName, setEditName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  return (
    <div className="mb-6">
      <div className="flex gap-2 items-center overflow-x-auto pb-1 sm:flex-wrap">
        {categories.map((c, ci) => {
          const color = GROUP_COLORS[ci % GROUP_COLORS.length];
          return (
          <div key={c.id} className="flex items-center shrink-0">
            {editingId === c.id ? (
              <span className="flex items-center gap-1">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="px-2 py-1 rounded border text-sm w-32" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
                />
                <button type="button" onClick={() => { if (editName.trim()) { onRename(c.id, editName.trim()); setEditingId(null); } }} className="text-xs text-lime-400">✓</button>
                <button type="button" onClick={() => setEditingId(null)} className="text-xs text-teal-400">✕</button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                onDoubleClick={() => { setEditingId(c.id); setEditName(c.name); }}
                className="whitespace-nowrap px-4 py-2 rounded-full text-sm border transition font-medium"
                style={
                  c.id === activeId
                    ? { backgroundColor: color, color: "#14181f", borderColor: color }
                    : { backgroundColor: color + "14", color, borderColor: color + "40" }
                }
              >
                {c.name}
              </button>
            )}
            {c.id === activeId && editingId !== c.id && (
              confirmingDeleteId === c.id ? (
                <span className="ml-1 text-xs">
                  <button type="button" onClick={() => { onDelete(c.id); setConfirmingDeleteId(null); }} className="text-red-400 font-semibold mr-1">Confirmar</button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)} className="text-teal-400">✕</button>
                </span>
              ) : (
                <span className="ml-1 flex gap-1">
                  <button type="button" onClick={() => { setEditingId(c.id); setEditName(c.name); }} className="text-xs text-teal-400 hover:text-lime-400" title="Renombrar">✎</button>
                  <button type="button" onClick={() => setConfirmingDeleteId(c.id)} className="text-xs text-red-400" title="Eliminar categoría">🗑</button>
                </span>
              )
            )}
          </div>
          );
        })}

        {adding ? (
          <span className="flex items-center gap-1 shrink-0">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
              placeholder="Ej: 4ta Caballeros"
              autoFocus
              className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
            />
            <button
              type="button"
              onClick={submitNew}
              className="px-3 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
            >
              Agregar
            </button>
            <button type="button" onClick={() => { setAdding(false); setNewName(""); }} className="text-sm text-teal-400" style={F.body}>Cancelar</button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="shrink-0 whitespace-nowrap px-4 py-2 rounded-full text-sm border border-dashed border-teal-700 text-teal-400 hover:border-lime-400 hover:text-lime-400" style={F.body}>
            + Agregar categoría
          </button>
        )}
      </div>
      {categories.length > 0 && (
        <p className="text-[11px] text-teal-600 mt-2" style={F.body}>Tip: doble clic en una categoría para renombrarla.</p>
      )}
    </div>
  );
}

function AdminTournament({ tournament, update, onBack, inscripciones = [], onResolveInscripcion }) {
  const usesSchedule = tournamentUsesSchedule(tournament);
  const pendingCount = inscripciones.filter((i) => i.estado === "pendiente").length;
  // Con el torneo en curso arranca en "En cancha", que es lo que se usa desde el celular en el club;
  // si hay inscripciones nuevas y todavía no empezó, arranca ahí
  const [chosenView, setView] = useState(
    tournament.status === STATUS.EN_CURSO ? "encancha" : pendingCount > 0 ? "inscripciones" : "horarios"
  ); // encancha | horarios | categorias | inscripciones
  // El Súper 8 no tiene grilla de horarios: los partidos se juegan uno atrás del otro
  const view = usesSchedule || chosenView === "inscripciones" ? chosenView : "categorias";
  const tabs = [
    ...(usesSchedule ? [["encancha", "En cancha"], ["horarios", "Horarios"]] : []),
    ["categorias", "Categorías"],
    ["inscripciones", "Inscripciones"],
  ];
  const [categoryId, setCategoryId] = useState(tournament.categories[0]?.id || null);
  const category = tournament.categories.find((c) => c.id === categoryId) || null;

  const setCategories = (categories) => update({ ...tournament, categories });

  const addCategory = (name) => {
    const cat = newCategory(name, categoryFormatForConfig(tournamentConfig(tournament)));
    setCategories([...tournament.categories, cat]);
    setCategoryId(cat.id);
  };

  const renameCategory = (id, name) => {
    setCategories(tournament.categories.map((c) => (c.id === id ? { ...c, name } : c)));
  };

  const deleteCategory = (id) => {
    const remaining = tournament.categories.filter((c) => c.id !== id);
    setCategories(remaining);
    if (categoryId === id) setCategoryId(remaining[0]?.id || null);
  };

  const updateCategory = (updated) => {
    setCategories(tournament.categories.map((c) => (c.id === updated.id ? updated : c)));
  };

  /* Igual que updateCategory, pero además dispara el auto-armado de horarios de grupos sobre el
     torneo completo apenas queda formada la fase de grupos (el "cierre" de grupos), para que el
     organizador solo tenga que revisar/ajustar excepciones en vez de armar todo desde cero. */
  const updateCategoryAndAutoSchedule = (updated) => {
    const merged = { ...tournament, categories: tournament.categories.map((c) => (c.id === updated.id ? updated : c)) };
    update(merged.playDates && merged.playDates.length > 0 ? autoSchedule(merged) : merged);
  };

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto">
      <button onClick={onBack} className="text-sm text-teal-400 hover:text-lime-400 mb-2" style={F.body}>← Mis torneos</button>
      <div className="flex justify-between items-center flex-wrap gap-3 mb-1">
        <h1 className="text-xl" style={F.display}>{tournament.name.toUpperCase()}</h1>
        <select
          value={tournament.status}
          onChange={(e) => update({ ...tournament, status: e.target.value })}
          className="px-3 py-1.5 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
        >
          {Object.values(STATUS).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <p className="text-sm text-teal-400 mb-4" style={F.body}>
        {usesSchedule
          ? "Este torneo puede tener varias categorías (ej: 4ta Caballeros, 5ta Damas, Mixta). Cada una tiene sus propias parejas, grupos y llave. El formato de partido y la grilla de horarios aplican a todas por igual."
          : "Este torneo puede tener varias categorías (ej: 4ta Caballeros, 5ta Damas, Mixta), cada una con sus 8 inscriptos. El tipo de torneo y el formato de partido aplican a todas por igual. No hay grilla de horarios: los partidos se juegan uno atrás del otro en la cancha disponible."}
      </p>

      <div className="flex gap-2 mb-6 overflow-x-auto">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 rounded text-sm border flex items-center gap-1.5 ${view === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
            style={F.body}
          >
            {label}
            {key === "inscripciones" && pendingCount > 0 && (
              <span className="px-1.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: "#fb923c", color: "#14181f" }}>{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {view === "inscripciones" ? (
        <InscripcionesPanel tournament={tournament} update={update} inscripciones={inscripciones} onResolve={onResolveInscripcion} />
      ) : view === "encancha" ? (
        <OnCourtView tournament={tournament} update={update} />
      ) : view === "horarios" ? (
        <ScheduleAdminView tournament={tournament} update={update} />
      ) : (
        <>
          <TournamentTypeEditor tournament={tournament} update={update} />

          <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-2" style={F.body}>Categorías</h2>
          <CategoryTabs
            categories={tournament.categories}
            activeId={categoryId}
            onSelect={setCategoryId}
            onAdd={addCategory}
            onRename={renameCategory}
            onDelete={deleteCategory}
          />

          {category ? (
            <CategoryAdminView key={category.id} category={category} format={tournament.matchFormat} playDates={tournament.playDates} tournament={tournament} onUpdateCategory={updateCategory} onGroupsLocked={updateCategoryAndAutoSchedule} />
          ) : (
            <p className="opacity-60 text-sm" style={F.body}>Agregá al menos una categoría para empezar a cargar parejas.</p>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Manejo de errores visible ---------- */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen p-6" style={{ backgroundImage: "linear-gradient(135deg, #14181f, #1b2027)", color: "#e2e8f0", ...F.body }}>
          <p className="text-red-400 font-semibold mb-2">Se produjo un error en la app:</p>
          <pre className="text-sm whitespace-pre-wrap opacity-80">{String(this.state.error?.message || this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/* Completa y migra los torneos leídos de Supabase: torneos de antes de las categorías, partidos
   sin sets, fechas guardadas como texto y valores por defecto de formato, canchas y duración */
function normalizeLoadedTournaments(tours) {
  const fixMatches = (matches) => (matches || []).map((m) => (m.sets ? m : { ...m, sets: [] }));
  const fixBracket = (bracket) => (bracket ? bracket.map((round) => round.map((m) => (m.sets ? m : { ...m, sets: [] }))) : bracket);
  const fixPlayDates = (pd) => (pd || []).map((d) => (typeof d === "string" ? { date: d, from: "09:00", to: "22:00" } : d));

  return tours.map((t) => {
    const { pairs, groups, bracket, ...rest } = t;
    let categories = t.categories;
    if (!categories) {
      // Migración: torneos de antes de "categorías" pasan a tener una única categoría "General"
      categories = [{
        id: uid(),
        name: "General",
        pairs: (pairs || []).map((p) => ({ ...p, availability: p.availability || [] })),
        groups: (groups || []).map((g) => ({ ...g, matches: fixMatches(g.matches) })),
        bracket: fixBracket(bracket),
      }];
    } else {
      categories = categories.map((c) => ({
        ...c,
        pairs: (c.pairs || []).map((p) => ({ ...p, availability: p.availability || [] })),
        groups: (c.groups || []).map((g) => ({ ...g, matches: fixMatches(g.matches) })),
        bracket: fixBracket(c.bracket),
      }));
    }
    return {
      ...rest,
      matchFormat: t.matchFormat || { ...DEFAULT_MATCH_FORMAT },
      courtsCount: t.courtsCount ?? 4,
      matchDurationMinutes: t.matchDurationMinutes ?? 90,
      playDates: fixPlayDates(t.playDates),
      categories,
    };
  });
}

/* ---------- App raíz ---------- */

function SmashPointAppInner() {
  useBrandFonts();
  const [ready, setReady] = useState(false);
  const [tournaments, setTournaments] = useState([]);
  const [organizers, setOrganizers] = useState([]);
  const [ads, setAds] = useState([]);
  const [circuits, setCircuits] = useState([]);
  const [route, setRoute] = useState("public-home");
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        let orgs;
        try {
          orgs = await fetchOrganizers();
        } catch { orgs = []; }
        try {
          const covers = (await kvGet(STORAGE_KEY_ORGANIZER_COVERS)) || {};
          orgs = orgs.map((o) => ({ ...o, coverUrl: covers[o.id] || "" }));
        } catch {}

        let tours;
        try {
          tours = await kvGet(STORAGE_KEY_TOURNAMENTS);
        } catch { tours = null; }
        if (!Array.isArray(tours)) {
          const firstOrganizer = orgs.find((o) => o.role === "organizador") || orgs[0] || { id: "sin-organizador" };
          tours = seedTournaments(firstOrganizer.id);
        } else {
          tours = normalizeLoadedTournaments(tours);
        }

        let loadedAds;
        try {
          loadedAds = await kvGet(STORAGE_KEY_ADS);
        } catch { loadedAds = null; }
        if (!Array.isArray(loadedAds)) loadedAds = [];

        let loadedCircuits;
        try {
          loadedCircuits = await kvGet(STORAGE_KEY_CIRCUITS);
        } catch { loadedCircuits = null; }
        if (!Array.isArray(loadedCircuits)) loadedCircuits = [];

        setOrganizers(orgs);
        setTournaments(tours);
        setAds(loadedAds);
        setCircuits(loadedCircuits);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persistAds = useCallback(async (next) => {
    setAds(next);
    try { await kvSet(STORAGE_KEY_ADS, next, session?.accessToken); } catch {}
  }, [session]);

  const persistCircuits = useCallback(async (next) => {
    setCircuits(next);
    try { await kvSet(STORAGE_KEY_CIRCUITS, next, session?.accessToken); } catch {}
  }, [session]);

  const persistTournaments = useCallback(async (next) => {
    setTournaments(next);
    try { await kvSet(STORAGE_KEY_TOURNAMENTS, next, session?.accessToken); } catch {}
  }, [session]);

  /* Vuelve a leer los torneos de Supabase. Se usa después de aceptar una inscripción (la pareja la
     agrega el servidor) y al volver a la pestaña del panel, para no guardar encima una copia vieja. */
  const reloadTournaments = useCallback(async () => {
    try {
      const tours = await kvGet(STORAGE_KEY_TOURNAMENTS);
      if (Array.isArray(tours)) setTournaments(normalizeLoadedTournaments(tours));
    } catch {}
  }, []);

  useEffect(() => {
    if (!session) return;
    const onVisible = () => { if (document.visibilityState === "visible") reloadTournaments(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [session, reloadTournaments]);

  // Inscripciones de los torneos del organizador logueado (para los avisos de "nuevas" y su pestaña)
  const [inscripciones, setInscripciones] = useState([]);
  const reloadInscripciones = useCallback(async () => {
    if (!session?.accessToken || session.role === "creador") { setInscripciones([]); return; }
    try { setInscripciones(await fetchInscripciones(session.accessToken)); } catch { /* la migración todavía no está aplicada o el token venció */ }
  }, [session]);

  useEffect(() => {
    reloadInscripciones();
    if (!session) return;
    const id = setInterval(reloadInscripciones, 60000);
    const onVisible = () => { if (document.visibilityState === "visible") reloadInscripciones(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [session, reloadInscripciones]);

  const resolveInscripcion = async (inscripcion, accept) => {
    await supabaseRpc(accept ? "aceptar_inscripcion" : "rechazar_inscripcion", { p_id: inscripcion.id }, session.accessToken);
    await Promise.all([accept ? reloadTournaments() : null, reloadInscripciones()]);
  };

  const updateTournament = (updated) => {
    persistTournaments(tournaments.map((t) => (t.id === updated.id ? updated : t)));
  };

  const deleteTournament = (id) => {
    persistTournaments(tournaments.filter((t) => t.id !== id));
  };

  const createTournament = ({ name, date, circuitId, config, categories, schedule, inscripcionesAbiertas }) => {
    const base = { id: uid(), name, date, status: STATUS.PROXIMO, organizerId: session.id, coverImageUrl: "", venue: "", circuitId: circuitId || null, matchFormat: { ...DEFAULT_MATCH_FORMAT }, courtsCount: 4, matchDurationMinutes: 90, playDates: [], categories: [], inscripcionesAbiertas: !!inscripcionesAbiertas, ...(schedule || {}) };
    const categoryFormat = categoryFormatForConfig(config);
    const newCategories = categories.map(({ name: n, cupo }) => ({ ...newCategory(n, categoryFormat), ...(cupo ? { cupo } : {}) }));
    const t = withTournamentConfig({ ...base, categories: newCategories }, config);
    persistTournaments([...tournaments, t]);
  };

  const updateOrganizerProfile = async (id, patch) => {
    const { coverUrl, ...profilePatch } = patch;
    if (Object.keys(profilePatch).length > 0) await updateOrganizerProfileRemote(id, session.accessToken, profilePatch);
    if (coverUrl !== undefined) {
      // Se relee antes de guardar para no pisar la portada que otro organizador haya cambiado
      const covers = { ...((await kvGet(STORAGE_KEY_ORGANIZER_COVERS)) || {}), [id]: coverUrl };
      await kvSet(STORAGE_KEY_ORGANIZER_COVERS, covers, session.accessToken);
    }
    setOrganizers((orgs) => orgs.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    setSession((s) => (s && s.id === id ? { ...s, ...patch } : s));
  };

  const createOrganizer = async ({ name, username, email, password }) => {
    const data = await callAdminOrganizers(session.accessToken, { action: "create", name, username, email, password });
    if (!data.organizer || !data.organizer.id) throw new Error("La función respondió pero sin los datos esperados. Revisá que el código de admin-organizers esté bien pegado en Supabase.");
    setOrganizers((orgs) => [...orgs, data.organizer]);
  };

  const deleteOrganizer = async (id) => {
    await callAdminOrganizers(session.accessToken, { action: "delete", id });
    setOrganizers((orgs) => orgs.filter((o) => o.id !== id));
  };

  const addAd = (ad) => {
    persistAds([...ads, { id: uid(), ...ad }]);
  };

  const updateAd = (updated) => {
    persistAds(ads.map((a) => (a.id === updated.id ? updated : a)));
  };

  const deleteAd = (id) => {
    persistAds(ads.filter((a) => a.id !== id));
  };

  const addCircuit = (circuit) => {
    persistCircuits([...circuits, { id: uid(), organizerId: session.id, ...circuit }]);
  };

  const updateCircuit = (updated) => {
    persistCircuits(circuits.map((c) => (c.id === updated.id ? updated : c)));
  };

  const deleteCircuit = (id) => {
    persistCircuits(circuits.filter((c) => c.id !== id));
    persistTournaments(tournaments.map((t) => (t.circuitId === id ? { ...t, circuitId: null } : t)));
  };

  const restoreBackup = (data) => {
    if (Array.isArray(data.tournaments)) persistTournaments(data.tournaments);
    if (Array.isArray(data.circuits)) persistCircuits(data.circuits);
    if (Array.isArray(data.ads)) persistAds(data.ads);
  };

  if (!ready) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: APP_BACKGROUND, color: "#e2e8f0" }}>Cargando…</div>;
  }

  const selected = tournaments.find((t) => t.id === selectedId) || null;
  const myTournaments = session ? tournaments.filter((t) => t.organizerId === session.id) : [];
  const myCircuits = session ? circuits.filter((c) => c.organizerId === session.id) : [];

  let content;
  // En la pantalla de inicio las publicidades van en el carrusel de arriba, no al pie
  let onHome = false;
  if (route === "public-home") {
    onHome = true;
    content = <PublicHome tournaments={tournaments} ads={ads} circuits={circuits} organizers={organizers} onOpen={(id) => { setSelectedId(id); setRoute("public-tournament"); }} onGoLogin={() => setRoute("login")} />;
  } else if (route === "public-tournament" && selected) {
    content = <PublicTournament tournament={selected} ads={ads} organizers={organizers} onBack={() => setRoute("public-home")} />;
  } else if (route === "login") {
    content = <Login onBack={() => setRoute("public-home")} onLogin={(org) => { setSession(org); setRoute(org.role === "creador" ? "creator-home" : "admin-home"); }} />;
  } else if (route === "creator-home" && session && session.role === "creador") {
    content = (
      <CreatorHome
        creator={session}
        organizers={organizers}
        tournaments={tournaments}
        circuits={circuits}
        ads={ads}
        onUpdateOrganizer={updateOrganizerProfile}
        onCreateOrganizer={createOrganizer}
        onDeleteOrganizer={deleteOrganizer}
        onDeleteTournament={deleteTournament}
        onDeleteCircuit={deleteCircuit}
        onAddAd={addAd}
        onUpdateAd={updateAd}
        onDeleteAd={deleteAd}
        onRestoreBackup={restoreBackup}
        onLogout={() => { setSession(null); setRoute("public-home"); }}
      />
    );
  } else if (route === "admin-home" && session) {
    content = (
      <AdminHome
        organizer={{ ...session, coverUrl: session.coverUrl ?? organizers.find((o) => o.id === session.id)?.coverUrl ?? "" }}
        tournaments={myTournaments}
        circuits={myCircuits}
        onCreate={createTournament}
        onOpen={(id) => { setSelectedId(id); setRoute("admin-tournament"); }}
        onLogout={() => { setSession(null); setRoute("public-home"); }}
        onUpdate={updateTournament}
        onDelete={deleteTournament}
        onAddCircuit={addCircuit}
        onUpdateCircuit={updateCircuit}
        onDeleteCircuit={deleteCircuit}
        onUpdateProfile={(patch) => updateOrganizerProfile(session.id, patch)}
        inscripciones={inscripciones}
      />
    );
  } else if (route === "admin-tournament" && selected) {
    content = (
      <AdminTournament
        tournament={selected}
        update={updateTournament}
        onBack={() => setRoute("admin-home")}
        inscripciones={inscripciones.filter((i) => i.torneo_id === selected.id)}
        onResolveInscripcion={resolveInscripcion}
      />
    );
  } else {
    onHome = true;
    content = <PublicHome tournaments={tournaments} ads={ads} circuits={circuits} organizers={organizers} onOpen={(id) => { setSelectedId(id); setRoute("public-tournament"); }} onGoLogin={() => setRoute("login")} />;
  }

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ background: APP_BACKGROUND, backgroundAttachment: "fixed", color: "#e2e8f0", ...F.body }}>
      {content}
      {!onHome && (
        // En el detalle de un torneo con inscripciones, deja lugar para el botón fijo de abajo
        <div className={`px-6 max-w-4xl mx-auto ${route === "public-tournament" && selected && registrationStatus(selected) !== "cerrado" ? "pb-32" : "pb-10"}`}>
          <AdBanner ads={ads} />
        </div>
      )}
    </div>
  );
}

export default function SmashPointApp() {
  return (
    <ErrorBoundary>
      <SmashPointAppInner />
    </ErrorBoundary>
  );
}
