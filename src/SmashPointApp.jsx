import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ---------- Utilidades de datos ---------- */

const uid = () => Math.random().toString(36).slice(2, 10);

const STORAGE_KEY_TOURNAMENTS = "sp:tournaments";
const STORAGE_KEY_ADS = "sp:ads";
const STORAGE_KEY_CIRCUITS = "sp:circuits";

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

/* Chequea si una pareja ya jugó algún partido (de grupos o de la llave) dentro de la categoría */
function pairHasPlayed(category, pairId) {
  const inGroups = (category.groups || []).some((g) => g.matches.some((m) => (m.pairA === pairId || m.pairB === pairId) && matchIsPlayed(m)));
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
    if (sa > sb) { a.pg++; a.pts += 2; b.pp++; }
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

/* Arma el orden de clasificados para la llave final a partir de los grupos, evitando que el
   1° y 2° de un mismo grupo se crucen en la primera ronda, y dejando a los mejores clasificados
   (por diferencia de games) pasar directo cuando la cantidad no cierra en potencia de dos.

   Cómo arma los cruces entre grupos:
   - Si hay 2 o más grupos, se rota en cadena: el 2° del grupo 1 "viaja" a la llave del 1° del
     grupo 2, el 2° del grupo 2 a la del 1° del grupo 3, ..., y el 2° del último grupo cierra el
     círculo volviendo a la llave del 1° del grupo 1. Así ningún 1° se cruza con el 2° de su
     propio grupo en primera ronda, sea cual sea la cantidad de grupos (par o impar).
   - Si hay un solo grupo, no hay con quién rotar: se arma la llave con el orden normal de la tabla.

   Cómo resuelve cuando el número de clasificados no es potencia de dos:
   - Se ordenan todas las parejas clasificadas por mérito (puntos, luego diferencia de sets, luego
     diferencia de games, igual que el desempate de grupo) para decidir cuáles son "mejores
     clasificados".
   - Los mejores clasificados (empezando por los que más méritos tienen) pasan directo a la ronda
     siguiente (bye), hasta que la cantidad de parejas que sí juegan la primera ronda complete un
     número par que, sumado a los que ya tienen bye, cierre en una potencia de dos. Es el sistema
     habitual en pádel: con byes, los mejor ubicados saltan la primera ronda. */
function buildKnockoutSeeding(groups, pairsById, format) {
  const groupTables = groups.map((g) => computeStandings(g, pairsById, format));

  // Mérito general de una fila de tabla, para comparar clasificados de distintos grupos entre sí.
  const meritKey = (row) => [row.pts, row.setsF - row.setsC, row.gamesF - row.gamesC];
  const compareMerit = (a, b) => {
    const ka = meritKey(a), kb = meritKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  };

  const firsts = groupTables.map((t) => t[0]).filter(Boolean);
  const seconds = groupTables.map((t) => t[1]).filter(Boolean);

  // Rotación en cadena de los 2dos puestos, para que cada uno caiga en la llave del 1° de OTRO grupo.
  let crossedSeconds = seconds;
  if (seconds.length >= 2) {
    crossedSeconds = seconds.map((_, i) => seconds[(i + 1) % seconds.length]);
  }

  // Armamos los "duelos" 1° vs 2° cruzado, en el orden de los grupos.
  const duels = firsts.map((f1, i) => [f1, crossedSeconds[i]].filter(Boolean));
  let seeded = duels.flat();

  // Si algún grupo no tiene 2do (grupos de 1 pareja, caso raro) igual quedan sueltos los 1ros.
  if (seeded.length === 0) seeded = [...firsts, ...seconds];

  // Orden de mérito general, para decidir quién pasa directo cuando el número no cierra.
  const byMerit = [...seeded].sort((a, b) => compareMerit(a, b));

  let size = 1;
  while (size < seeded.length) size *= 2;
  const byeCount = size - seeded.length; // cuántas parejas pasan directo a la ronda siguiente

  const byePairIds = byMerit.slice(0, byeCount).map((r) => r.pairId);
  const playFirstRound = seeded.filter((r) => !byePairIds.includes(r.pairId));

  return {
    order: seeded.map((r) => r.pairId),
    byePairIds,
    playFirstRoundIds: playFirstRound.map((r) => r.pairId),
  };
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

/* Como buildBracket, pero a partir del resultado de buildKnockoutSeeding: coloca en la ronda 1
   primero los duelos reales entre parejas que juegan, y después las parejas con bye emparejadas
   con un lugar vacío (pasan solas a la ronda siguiente sin jugar la ronda 1). */
function buildSeededBracket(seeding) {
  const { order, byePairIds } = seeding;
  const byeSet = new Set(byePairIds);
  const playing = order.filter((id) => !byeSet.has(id));
  const slots = [...playing];
  byePairIds.forEach((id) => { slots.push(id); slots.push(null); });
  return buildBracket(slots);
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
            location: { type: "group", groupId: g.id }, matchId: m.id, label: g.name,
            pairA: m.pairA, pairB: m.pairB, schedule: m.schedule || null, sets: m.sets || [],
            walkover: m.walkover || null, liveStatus: m.liveStatus || null,
            stage: m.stage || null, groupFormat: g.format || "roundrobin",
            placeholder: isPending4 ? (m.stage === "ganadores" ? "Ganador Partido 1 vs Ganador Partido 2" : "Perdedor Partido 1 vs Perdedor Partido 2") : null,
          });
        }
      });
    });
    (c.bracket || []).forEach((round, ri) => {
      round.forEach((m) => {
        if (m.pairA && m.pairB) {
          list.push({ key: `${c.id}:b:${ri}:${m.id}`, categoryId: c.id, categoryName: c.name, location: { type: "bracket", roundIndex: ri }, matchId: m.id, label: roundStageLabel(c.bracket.length, ri), pairA: m.pairA, pairB: m.pairB, schedule: m.schedule || null, sets: m.sets || [], walkover: m.walkover || null, liveStatus: m.liveStatus || null, draft: !c.bracketPublished });
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
  if (dates.length === 0 || !category.bracket) return category;

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
  const courts = tournament.courtsCount || 4;
  const duration = tournament.matchDurationMinutes || 90;
  const dates = (tournament.playDates || []).map((d) => d.date);
  const all = collectScheduleableMatches(tournament);

  const courtBusy = new Set();
  const pairBusy = new Set();
  all.filter((m) => m.schedule).forEach((m) => {
    const { date, time, court } = m.schedule;
    courtBusy.add(`${date}|${time}|${court}`);
    pairBusy.add(`${date}|${time}|${m.pairA}`);
    pairBusy.add(`${date}|${time}|${m.pairB}`);
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
        if (!isPlaceholder && (pairBusy.has(`${date}|${time}|${m.pairA}`) || pairBusy.has(`${date}|${time}|${m.pairB}`))) continue;
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
      if (!isPlaceholder) {
        pairBusy.add(`${placed.date}|${placed.time}|${m.pairA}`);
        pairBusy.add(`${placed.date}|${placed.time}|${m.pairB}`);
      }
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
const BRAND = { bgStart: "#14181f", bgEnd: "#1b2027", lime: "#9fe022", limeText: "#14181f", ink: "#f2f5f8" };

/* ---------- Componentes chicos ---------- */

/* Isotipo "S" del logo. size chico para navbars, más grande con wordmark para pantallas de login/landing */

function Logo({ size = 40, withWordmark = false }) {
  const mark = (
    <svg width={size} height={size} viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={BRAND.bgStart} />
          <stop offset="100%" stopColor={BRAND.bgEnd} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="600" height="600" rx="80" fill="url(#sp-bg)" />
      <g transform="translate(300,295) scale(0.55) translate(-312,-290)">
        <path
          d="M 400 160 L 400 215 L 275 215 C 255 215 245 225 245 245 C 245 263 255 273 275 273 L 355 273 C 405 273 435 300 435 345 C 435 392 405 420 355 420 L 210 420 L 210 365 L 345 365 C 365 365 375 355 375 337 C 375 319 365 309 345 309 L 275 309 C 220 309 190 282 190 240 C 190 195 222 160 270 160 Z"
          fill={BRAND.lime}
        />
        <circle cx="322" cy="243" r="30" fill={BRAND.bgStart} />
        <path d="M 302 227 Q 322 243 302 259" fill="none" stroke={BRAND.lime} strokeWidth="3" opacity="0.8" />
        <path d="M 342 227 Q 322 243 342 259" fill="none" stroke={BRAND.lime} strokeWidth="3" opacity="0.8" />
      </g>
    </svg>
  );
  if (!withWordmark) return mark;
  return (
    <div className="flex flex-col items-center">
      {mark}
      <span className="mt-2 text-lg" style={{ ...F.display, color: BRAND.ink, letterSpacing: "1px" }}>SMASH POINT</span>
      <span className="text-[11px]" style={{ ...F.body, color: BRAND.lime, letterSpacing: "3px" }}>EVENTOS DE PADEL</span>
    </div>
  );
}

/* Banner publicitario público: rota entre los anuncios activos. No renderiza nada si no hay anuncios. */
function AdBanner({ ads }) {
  const PAGE_SIZE = 4;
  const active = (ads || []).filter((a) => a.active);
  const pages = [];
  for (let i = 0; i < active.length; i += PAGE_SIZE) pages.push(active.slice(i, i + PAGE_SIZE));
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (pages.length < 2) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages.length), 6000);
    return () => clearInterval(id);
  }, [pages.length]);

  if (active.length === 0) return null;
  const current = pages[page % pages.length] || [];

  return (
    <div className="mb-6">
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        {current.map((ad) => (
          <a
            key={ad.id}
            href={ad.linkUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="block relative rounded-lg overflow-hidden border border-teal-800"
          >
            <img src={ad.imageUrl} alt={ad.name || "Publicidad"} className="w-full h-24 sm:h-28 object-cover" />
            <span className="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "rgba(20,24,31,0.8)", color: "#94a3b8" }}>
              Publicidad
            </span>
          </a>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="flex gap-1 justify-center mt-2">
          {pages.map((_, i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: i === page ? BRAND.lime : "#334155" }}
            />
          ))}
        </div>
      )}
    </div>
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

function StandingsTable({ group, pairsById, format, accentColor = "#9fe022" }) {
  const table = computeStandings(group, pairsById, format);
  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: accentColor + "40" }}>
      {table.map((row, i) => {
        const qualifies = i < 2;
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
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((s, i) => {
        const isTiebreak = format?.finalSuperTiebreak && i === total - 1;
        return (
          <div key={i} className="flex flex-col items-center">
            <span className="text-[10px] text-teal-500 mb-0.5" style={F.body}>
              {isTiebreak ? "STB a 10" : `Set ${i + 1}`}
            </span>
            <div className="flex items-center gap-1">
              <input
                type="number" min="0" max={isTiebreak ? undefined : 9}
                maxLength={isTiebreak ? 2 : 1}
                className="w-11 px-1 py-1 rounded border text-center text-sm"
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
                type="number" min="0" max={isTiebreak ? undefined : 9}
                maxLength={isTiebreak ? 2 : 1}
                className="w-11 px-1 py-1 rounded border text-center text-sm"
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
  );
}

/* Panel para ver y editar el formato de partido de un torneo */
function MatchFormatEditor({ format, onChange }) {
  const [open, setOpen] = useState(false);
  const f = format || DEFAULT_MATCH_FORMAT;
  const [gamesText, setGamesText] = useState(String(f.gamesPerSet));

  return (
    <div className="border border-teal-800 rounded-lg p-4 mb-6">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <p className="text-sm font-semibold" style={F.body}>Formato de partido</p>
          <p className="text-xs text-teal-400" style={F.body}>{formatSummary(f)}</p>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>
          {open ? "Cerrar" : "Editar formato"}
        </button>
      </div>

      {open && (
        <div className="mt-4 flex flex-wrap gap-4 items-end">
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
      )}
    </div>
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
      <p className="text-sm font-semibold mb-3" style={F.body}>Canchas y fechas del torneo</p>
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
          <label className="block text-xs text-teal-400 mb-1" style={F.body}>Duración de partido (min)</label>
          <input
            type="number" min="15" step="15" inputMode="numeric"
            value={durationText}
            onChange={(e) => setDurationText(e.target.value)}
            onBlur={() => {
              const n = Number(durationText);
              const valid = durationText.trim() !== "" && n >= 15;
              const final = valid ? n : (tournament.matchDurationMinutes ?? 90);
              setDurationText(String(final));
              if (final !== tournament.matchDurationMinutes) onChange({ ...tournament, matchDurationMinutes: final });
            }}
            className="w-24 px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
          />
        </div>
      </div>
      <label className="block text-xs text-teal-400 mb-1" style={F.body}>Fechas y horario en que se juega cada una</label>
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
      <div className="border-t border-teal-800 pt-3 space-y-2">
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
      </div>
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
function GridMatchCard({ m, pairsById, conflict, onDragStart, onClear }) {
  const status = m.placeholder ? "pendiente" : matchDisplayStatus(m);
  const finished = status === "finalizado";
  const border = conflict ? "#f87171" : m.draft ? "#a78bfa" : finished ? "#9fe022" : "#38bdf8";
  const bg = conflict ? "#f8717122" : m.draft ? "#a78bfa1a" : finished ? "#9fe0221a" : "#38bdf81a";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="rounded-md px-2 py-1.5 mb-1 text-[11px] leading-tight relative"
      style={{ ...F.body, border: `1.5px ${m.draft ? "dashed" : "solid"} ${border}`, backgroundColor: bg, cursor: "grab" }}
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
        </>
      )}
    </div>
  );
}

/* Grilla completa de horarios (admin): planilla tipo canchas x horarios con arrastrar y soltar.
   Reemplaza la vieja lista: bloquea/reubica automáticamente los choques de cancha y marca visualmente
   los partidos finalizados, ya que no queda un orden lineal como en una lista. */
function ScheduleAdminView({ tournament, update }) {
  const [notice, setNotice] = useState(null);
  const pairsById = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c) => c.pairs.forEach((p) => { map[p.id] = p; }));
    return map;
  }, [tournament.categories]);

  const matches = useMemo(() => collectScheduleableMatches(tournament), [tournament]);
  const scheduled = matches.filter((m) => m.schedule);
  const unscheduled = matches.filter((m) => !m.schedule);
  const duration = tournament.matchDurationMinutes || 90;
  const courtsCount = tournament.courtsCount || 4;
  const playDates = tournament.playDates || [];

  const editSchedule = (m, schedule) => { update(withMatchSchedule(tournament, m.categoryId, m.location, m.matchId, schedule)); };
  const clearSchedule = (m) => { update(withMatchSchedule(tournament, m.categoryId, m.location, m.matchId, null)); setNotice(null); };
  const toggleLiveStatus = (m, liveStatus) => update(withMatchLiveStatus(tournament, m.categoryId, m.location, m.matchId, liveStatus));

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
      <CourtsAndDatesEditor tournament={tournament} onChange={update} />

      {matches.length === 0 ? (
        <p className="opacity-60 text-sm" style={F.body}>Todavía no hay partidos con ambas parejas definidas (cargá grupos o llave en alguna categoría).</p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => update(autoSchedule(tournament))}
            disabled={playDates.length === 0}
            className="px-4 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
          >
            Generar horarios automáticamente
          </button>
          <p className="text-xs text-teal-500 mt-2 mb-3" style={F.body}>
            El armado automático solo asigna partidos de grupos (y se repite solo apenas se cierra un grupo). Los de la llave se precargan al generarla; arrastrá las tarjetas para reubicarlas.
          </p>

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
              const start = timeToMinutes(dateInfo.from), end = timeToMinutes(dateInfo.to);
              const times = [];
              for (let t = start; t + duration <= end; t += duration) times.push(minutesToTime(t));
              const courts = Array.from({ length: courtsCount }, (_, i) => i + 1);
              return (
                <div key={dateInfo.date} className="mb-8">
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <SkewPill color={dateColor}>{formatDateShort(dateInfo.date)}</SkewPill>
                  </div>
                  <div className="overflow-x-auto">
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
                                      <GridMatchCard key={m.key} m={m} pairsById={pairsById} conflict={conflict} onDragStart={onDragStartMatch(m.key)} onClear={() => clearSchedule(m)} />
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

/* Grilla de horarios en modo lectura para la vista pública */
function SchedulePublicView({ tournament }) {
  const pairsById = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c) => c.pairs.forEach((p) => { map[p.id] = p; }));
    return map;
  }, [tournament.categories]);

  const categoryColor = useMemo(() => {
    const map = {};
    tournament.categories.forEach((c, ci) => { map[c.id] = GROUP_COLORS[ci % GROUP_COLORS.length]; });
    return map;
  }, [tournament.categories]);

  const scheduled = useMemo(() => collectScheduleableMatches(tournament).filter((m) => m.schedule && !m.draft).sort((a, b) => {
    if (a.schedule.date !== b.schedule.date) return a.schedule.date < b.schedule.date ? -1 : 1;
    if (a.schedule.time !== b.schedule.time) return a.schedule.time < b.schedule.time ? -1 : 1;
    return a.schedule.court - b.schedule.court;
  }), [tournament]);

  const byDate = {};
  scheduled.forEach((m) => { (byDate[m.schedule.date] = byDate[m.schedule.date] || []).push(m); });
  const dateKeys = Object.keys(byDate).sort();

  if (scheduled.length === 0) {
    return <p className="opacity-60 text-sm" style={F.body}>Todavía no hay horarios publicados para este torneo.</p>;
  }

  return (
    <div>
      {dateKeys.map((date, di) => {
        const dateColor = GROUP_COLORS[di % GROUP_COLORS.length];
        const byTime = {};
        byDate[date].forEach((m) => { (byTime[m.schedule.time] = byTime[m.schedule.time] || []).push(m); });
        const times = Object.keys(byTime).sort();
        return (
        <div key={date} className="mb-8">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <SkewPill color={dateColor}>{formatDateShort(date)}</SkewPill>
          </div>
          <div className="space-y-4">
            {times.map((time) => (
              <div key={time} className="rounded-xl overflow-hidden border min-w-0" style={{ borderColor: dateColor + "40" }}>
                <div className="px-3 py-2 text-center font-extrabold text-sm uppercase tracking-wide" style={{ backgroundColor: dateColor, color: "#14181f" }}>
                  {time}hs
                </div>
                <div className="divide-y" style={{ borderColor: dateColor + "22" }}>
                  {byTime[time]
                    .slice()
                    .sort((a, b) => a.schedule.court - b.schedule.court)
                    .map((m) => (
                    <div key={m.key} className="px-3 py-2" style={{ backgroundColor: dateColor + "08" }}>
                      <div className="flex items-center gap-2 text-xs mb-1 flex-wrap" style={F.body}>
                        <span className="font-bold" style={{ color: dateColor }}>Cancha {m.schedule.court}</span>
                        <span className="font-medium truncate max-w-[35%]" style={{ color: categoryColor[m.categoryId] }}>{m.categoryName}</span>
                        {!m.placeholder && <span className="ml-auto"><MatchStatusBadge status={matchDisplayStatus(m)} /></span>}
                      </div>
                      {m.placeholder ? (
                        <p className="text-sm italic opacity-70" style={F.body}>{m.label ? `${m.label} · ` : ""}{m.placeholder}</p>
                      ) : (() => {
                        const hasResult = matchIsPlayed(m);
                        const w = hasResult ? matchWinnerId(m) : null;
                        const winnerIsA = w == null ? null : w === m.pairA;
                        return (
                          <div className="text-sm min-w-0" style={F.body}>
                            {m.label && <span className="text-[10px] text-teal-500 block">{m.label}</span>}
                            <div className="truncate flex items-center gap-1">{w === m.pairA && <WinnerCheck />}<PairName id={m.pairA} pairsById={pairsById} /></div>
                            <div className="text-[11px] opacity-50 my-0.5 flex items-center gap-2">
                              <span>vs</span>
                              {hasResult && (
                                <span className="font-mono not-italic opacity-100 text-teal-300"><MatchResultLabel match={m} winnerIsA={winnerIsA} /></span>
                              )}
                            </div>
                            <div className="truncate flex items-center gap-1">{w === m.pairB && <WinnerCheck />}<PairName id={m.pairB} pairsById={pairsById} /></div>
                          </div>
                        );
                      })()}
                    </div>
                  ))}
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

function OrganizerSelectScreen({ organizers, tournaments, circuits, ads, onSelect, onGoLogin }) {
  const visible = organizers.filter((o) => o.role !== "creador");

  return (
    <div>
      <header className="px-6 pt-10 pb-8 border-b border-teal-900">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <h1 className="text-2xl" style={F.display}>SMASH POINT</h1>
          </div>
          <button onClick={onGoLogin} className="text-sm px-4 py-2 rounded border border-teal-700 hover:bg-teal-900 transition" style={F.body}>
            Organizadores
          </button>
        </div>
        <p className="mt-6 max-w-xl text-teal-200" style={F.body}>
          Elegí un organizador para ver sus torneos, resultados y llaves en vivo.
        </p>
      </header>

      <main className="px-6 py-8">
        {visible.length === 0 ? (
          <p className="opacity-60" style={F.body}>Todavía no hay organizadores con torneos cargados.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {visible.map((o) => {
              const count = tournaments.filter((t) => t.organizerId === o.id).length;
              return (
                <button
                  key={o.id}
                  onClick={() => onSelect(o.id)}
                  className="rounded-lg border border-teal-800 hover:border-lime-400 transition p-4 text-center"
                  style={{ backgroundColor: "#9fe02208" }}
                >
                  {o.logoUrl ? (
                    <img src={o.logoUrl} alt="" className="w-20 h-20 rounded-full object-cover mx-auto border border-teal-700" />
                  ) : (
                    <div className="w-20 h-20 rounded-full mx-auto flex items-center justify-center text-2xl font-semibold" style={{ backgroundColor: "#115e59", color: "#9fe022" }}>
                      {o.name.trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                  <p className="mt-3 font-semibold text-sm" style={F.body}>{o.name}</p>
                  <p className="text-xs text-teal-500 mt-0.5" style={F.body}>{count} torneo{count !== 1 ? "s" : ""}</p>
                </button>
              );
            })}
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

  if (!selectedOrgId) {
    return (
      <OrganizerSelectScreen
        organizers={organizers}
        tournaments={tournaments}
        circuits={circuits}
        ads={ads}
        onSelect={setSelectedOrgId}
        onGoLogin={onGoLogin}
      />
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
      <header className="px-6 pt-10 pb-8 border-b border-teal-900">
        <div className="flex items-center justify-between">
          <button onClick={() => setSelectedOrgId(null)} className="text-sm text-teal-400 hover:text-lime-400 flex items-center gap-1" style={F.body}>
            ← Organizadores
          </button>
          <button onClick={onGoLogin} className="text-sm px-4 py-2 rounded border border-teal-700 hover:bg-teal-900 transition" style={F.body}>
            Organizadores
          </button>
        </div>
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
          <button
            key={t.id}
            onClick={() => onOpen(t.id)}
            className="text-left rounded-lg transition overflow-hidden"
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
                  <p className="mt-2 text-sm text-teal-300" style={F.body}>
                    {new Date(t.date + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" })}
                    {t.venue ? ` · ${t.venue}` : ""}
                  </p>
                  <p className="mt-3 text-sm text-teal-400" style={F.body}>
                    {t.categories.length} categoría{t.categories.length !== 1 ? "s" : ""} · {t.categories.reduce((sum, c) => sum + c.pairs.length, 0)} parejas anotadas
                  </p>
                </div>
              </>
            )}
          </button>
          );
        })}
      </main>
      </>
      )}
    </div>
  );
}

/* ---------- Vista pública: detalle de torneo ---------- */

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
              </div>
              <StandingsTable group={g} pairsById={pairsById} format={format} accentColor={color} />
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
  const [view, setView] = useState("horarios"); // horarios | grupos | llaves
  const [categoryId, setCategoryId] = useState(tournament.categories[0]?.id || null);
  const category = tournament.categories.find((c) => c.id === categoryId) || tournament.categories[0] || null;
  const organizerName = (organizers || []).find((o) => o.id === tournament.organizerId)?.name;

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto">
      <button onClick={onBack} className="text-sm text-teal-300 hover:text-lime-400 mb-4" style={F.body}>← Todos los torneos</button>
      {tournament.coverImageUrl && (
        <img src={tournament.coverImageUrl} alt="" className="w-full h-40 sm:h-56 object-cover rounded-lg border border-teal-800 mb-4" />
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl" style={F.display}>{tournament.name.toUpperCase()}</h1>
        <Badge status={tournament.status} />
      </div>
      <p className="text-xs text-teal-500 mt-2" style={F.body}>
        {formatSummary(format)}
        {tournament.venue ? ` · Sede: ${tournament.venue}` : ""}
      </p>
      {organizerName && <p className="text-xs text-teal-600 mt-1" style={F.body}>Organiza: {organizerName}</p>}

      <div className="flex gap-2 mt-4">
        {[["horarios", "Horarios"], ["grupos", "Grupos"], ["llaves", "Llaves finales"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`px-3 py-1.5 rounded text-sm border ${view === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
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
          <div className="flex gap-2 mt-6 flex-wrap">
            {tournament.categories.map((c, ci) => {
              const color = GROUP_COLORS[ci % GROUP_COLORS.length];
              const active = c.id === category?.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setCategoryId(c.id)}
                  className="px-4 py-2 rounded-full text-sm border transition font-medium"
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
          {category && view === "grupos" && <CategoryGroupsPublicView category={category} format={format} />}
          {category && view === "llaves" && <CategoryBracketPublicView category={category} />}
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const saveProfile = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await onUpdateOrganizer(o.id, { name: profileName.trim() || o.name, logoUrl: profileLogo.trim() });
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

function TournamentRow({ t, circuits, onOpen, onUpdate, onDelete, accessToken }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [date, setDate] = useState(t.date);
  const [venue, setVenue] = useState(t.venue || "");
  const [coverImageUrl, setCoverImageUrl] = useState(t.coverImageUrl || "");
  const [circuitId, setCircuitId] = useState(t.circuitId || "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (editing) {
    return (
      <div className="p-4 rounded border border-lime-400">
        <p className="text-xs text-teal-400 mb-2" style={F.body}>Nombre, fecha, sede, imagen y circuito del torneo</p>
        <div className="flex flex-wrap gap-2 items-end mb-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
          <select value={circuitId} onChange={(e) => setCircuitId(e.target.value)} className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
            <option value="">Torneo relámpago (sin circuito)</option>
            {(circuits || []).map((c) => <option key={c.id} value={c.id}>{c.name} {c.year}</option>)}
          </select>
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
        <div className="flex flex-wrap gap-2 items-end mt-3">
          <button
            type="button"
            onClick={() => { if (name.trim() && date) { onUpdate({ ...t, name: name.trim(), date, venue: venue.trim(), coverImageUrl: coverImageUrl.trim(), circuitId: circuitId || null }); setEditing(false); } }}
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
          <button type="button" onClick={() => setEditing(true)} className="text-sm text-teal-300 hover:text-lime-400" style={F.body}>Editar nombre/fecha</button>
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
        Un circuito agrupa varias fechas (torneos) que suman puntos individuales durante la temporada. Al crear o editar un torneo, elegís a qué circuito pertenece esa fecha (o "Torneo relámpago" si es independiente).
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

function AdminHome({ organizer, tournaments, circuits, onCreate, onOpen, onLogout, onUpdate, onDelete, onAddCircuit, onUpdateCircuit, onDeleteCircuit, onUpdateProfile }) {
  const [tab, setTab] = useState("torneos"); // torneos | circuitos
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [circuitId, setCircuitId] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState(organizer.name);
  const [profileLogo, setProfileLogo] = useState(organizer.logoUrl || "");

  const create = () => {
    if (!name || !date) return;
    onCreate({ name, date, circuitId: circuitId || null });
    setName(""); setDate(""); setCircuitId("");
  };

  const saveProfile = () => {
    onUpdateProfile({ name: profileName.trim() || organizer.name, logoUrl: profileLogo.trim() });
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
        {editingProfile ? "Ocultar" : "Editar nombre y logo"}
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
          <div className="border border-teal-800 rounded-lg p-4 mb-8 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-teal-400 mb-1" style={F.body}>Nombre del torneo</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
            </div>
            <div>
              <label className="block text-xs text-teal-400 mb-1" style={F.body}>Fecha</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 rounded border outline-none focus:border-lime-400" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }} />
            </div>
            <div>
              <label className="block text-xs text-teal-400 mb-1" style={F.body}>Circuito (opcional)</label>
              <select value={circuitId} onChange={(e) => setCircuitId(e.target.value)} className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}>
                <option value="">Torneo relámpago (sin circuito)</option>
                {circuits.map((c) => <option key={c.id} value={c.id}>{c.name} {c.year}</option>)}
              </select>
            </div>
            <button type="button" onClick={create} className="px-4 py-2 rounded font-semibold" style={{ backgroundColor: "#9fe022", color: "#14181f", ...F.body }}>Crear torneo</button>
          </div>

          <h2 className="text-sm uppercase tracking-wide text-teal-400 mb-3" style={F.body}>Mis torneos</h2>
          <div className="space-y-2">
            {tournaments.map((t) => (
              <TournamentRow key={t.id} t={t} circuits={circuits} onOpen={onOpen} onUpdate={onUpdate} onDelete={onDelete} accessToken={organizer.accessToken} />
            ))}
            {tournaments.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no creaste torneos.</p>}
          </div>
        </>
      )}
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
  const pairsById = useMemo(() => Object.fromEntries(category.pairs.map((p) => [p.id, p])), [category.pairs]);
  const assignedPairIds = useMemo(() => new Set(category.groups.flatMap((g) => g.pairIds)), [category.groups]);

  const addPair = () => {
    if (!pairName.trim()) return;
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
    const group = { id: uid(), name: groupName.trim(), pairIds: groupSelection, format: built.format, matches: built.matches };
    (onGroupsLocked || onUpdateCategory)({ ...category, groups: [...category.groups, group] });
    setGroupName(""); setGroupSelection([]);
  };

  const runAutoGroups = () => {
    const { groups, warnings } = autoFormGroups(category.pairs, playDates);
    (onGroupsLocked || onUpdateCategory)({ ...category, groups, bracket: null });
    setGroupWarnings(warnings);
    setConfirmingAutoGroups(false);
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

  const generateBracketFromGroups = () => {
    const seeding = buildKnockoutSeeding(category.groups, pairsById, format);
    const withBracket = { ...category, bracket: buildSeededBracket(seeding), bracketPublished: false };
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

  return (
    <div>
      <div className="flex gap-2 mb-6 border-b border-teal-800">
        {[["parejas", "1. Parejas"], ["grupos", "2. Grupos"], ["llave", "3. Llave final"]].map(([key, label]) => (
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
              placeholder="Ej: Pérez / López"
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
                      <button type="button" onClick={() => removePair(p.id)} className="text-sm text-red-400">Quitar</button>
                    </div>
                  </div>
                  <PairAvailabilityEditor pair={p} playDates={playDates || []} onChange={(availability) => updatePairAvailability(p.id, availability)} />
                </li>
              );
            })}
            {category.pairs.length === 0 && <p className="opacity-60 text-sm" style={F.body}>Todavía no hay parejas en esta categoría.</p>}
          </ul>
        </div>
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
                <div className="flex items-center gap-2 mb-3">
                  <SkewPill color={color}>{g.name}</SkewPill>
                </div>
                <div className="mb-4"><StandingsTable group={g} pairsById={pairsById} format={format} accentColor={color} /></div>
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
          {!category.bracket && (
            <div className="border border-teal-800 rounded-lg p-4 mb-6">
              <p className="text-sm text-teal-300 mb-3" style={F.body}>
                Generá la llave final con el 1° y 2° puesto de cada grupo (si no hay grupos, se usan todas las parejas). Los cruces se arman entre grupos distintos, para que un 1° nunca se enfrente con el 2° de su propio grupo en la primera ronda.
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
  const [editName, setEditName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap gap-2 items-center">
        {categories.map((c, ci) => {
          const color = GROUP_COLORS[ci % GROUP_COLORS.length];
          return (
          <div key={c.id} className="flex items-center">
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
                className="px-4 py-2 rounded-full text-sm border transition font-medium"
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
          <span className="flex items-center gap-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { onAdd(newName.trim()); setNewName(""); setAdding(false); } }}
              placeholder="Ej: 4ta Caballeros"
              autoFocus
              className="px-3 py-2 rounded border text-sm" style={{ backgroundColor: "#eef2f2", color: "#111827", borderColor: "#94a3b8" }}
            />
            <button
              type="button"
              onClick={() => { if (newName.trim()) { onAdd(newName.trim()); setNewName(""); setAdding(false); } }}
              className="px-3 py-2 rounded font-semibold text-sm" style={{ backgroundColor: "#9fe022", color: "#14181f" }}
            >
              Agregar
            </button>
            <button type="button" onClick={() => { setAdding(false); setNewName(""); }} className="text-sm text-teal-400" style={F.body}>Cancelar</button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="px-4 py-2 rounded-full text-sm border border-dashed border-teal-700 text-teal-400 hover:border-lime-400 hover:text-lime-400" style={F.body}>
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

function AdminTournament({ tournament, update, onBack }) {
  const [view, setView] = useState("horarios"); // categorias | horarios
  const [categoryId, setCategoryId] = useState(tournament.categories[0]?.id || null);
  const category = tournament.categories.find((c) => c.id === categoryId) || null;

  const setCategories = (categories) => update({ ...tournament, categories });

  const addCategory = (name) => {
    const cat = { id: uid(), name, pairs: [], groups: [], bracket: null };
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
        Este torneo puede tener varias categorías (ej: 4ta Caballeros, 5ta Damas, Mixta). Cada una tiene sus propias parejas, grupos y llave. El formato de partido y la grilla de horarios aplican a todas por igual.
      </p>

      <div className="flex gap-2 mb-6">
        {[["horarios", "Horarios"], ["categorias", "Categorías"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`px-4 py-2 rounded text-sm border ${view === key ? "border-lime-400 text-lime-400" : "border-teal-800 text-teal-400"}`}
            style={F.body}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "horarios" ? (
        <ScheduleAdminView tournament={tournament} update={update} />
      ) : (
        <>
          <MatchFormatEditor format={tournament.matchFormat} onChange={(mf) => update({ ...tournament, matchFormat: mf })} />

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
            <CategoryAdminView category={category} format={tournament.matchFormat} playDates={tournament.playDates} tournament={tournament} onUpdateCategory={updateCategory} onGroupsLocked={updateCategoryAndAutoSchedule} />
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

        let tours;
        try {
          tours = await kvGet(STORAGE_KEY_TOURNAMENTS);
        } catch { tours = null; }
        if (!Array.isArray(tours)) {
          const firstOrganizer = orgs.find((o) => o.role === "organizador") || orgs[0] || { id: "sin-organizador" };
          tours = seedTournaments(firstOrganizer.id);
        } else {
          const fixMatches = (matches) => (matches || []).map((m) => (m.sets ? m : { ...m, sets: [] }));
          const fixBracket = (bracket) => (bracket ? bracket.map((round) => round.map((m) => (m.sets ? m : { ...m, sets: [] }))) : bracket);
          const fixPlayDates = (pd) => (pd || []).map((d) => (typeof d === "string" ? { date: d, from: "09:00", to: "22:00" } : d));

          tours = tours.map((t) => {
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

  const updateTournament = (updated) => {
    persistTournaments(tournaments.map((t) => (t.id === updated.id ? updated : t)));
  };

  const deleteTournament = (id) => {
    persistTournaments(tournaments.filter((t) => t.id !== id));
  };

  const createTournament = ({ name, date, circuitId }) => {
    const t = { id: uid(), name, date, status: STATUS.PROXIMO, organizerId: session.id, coverImageUrl: "", venue: "", circuitId: circuitId || null, matchFormat: { ...DEFAULT_MATCH_FORMAT }, courtsCount: 4, matchDurationMinutes: 90, playDates: [], categories: [] };
    persistTournaments([...tournaments, t]);
  };

  const updateOrganizerProfile = async (id, patch) => {
    await updateOrganizerProfileRemote(id, session.accessToken, patch);
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
    return <div className="min-h-screen flex items-center justify-center" style={{ backgroundImage: "linear-gradient(135deg, #14181f, #1b2027)", color: "#e2e8f0" }}>Cargando…</div>;
  }

  const selected = tournaments.find((t) => t.id === selectedId) || null;
  const myTournaments = session ? tournaments.filter((t) => t.organizerId === session.id) : [];
  const myCircuits = session ? circuits.filter((c) => c.organizerId === session.id) : [];

  let content;
  if (route === "public-home") {
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
        organizer={session}
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
      />
    );
  } else if (route === "admin-tournament" && selected) {
    content = <AdminTournament tournament={selected} update={updateTournament} onBack={() => setRoute("admin-home")} />;
  } else {
    content = <PublicHome tournaments={tournaments} ads={ads} circuits={circuits} organizers={organizers} onOpen={(id) => { setSelectedId(id); setRoute("public-tournament"); }} onGoLogin={() => setRoute("login")} />;
  }

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ backgroundImage: "linear-gradient(135deg, #14181f, #1b2027)", color: "#e2e8f0", ...F.body }}>
      {content}
      <div className="px-6 pb-10 max-w-4xl mx-auto">
        <AdBanner ads={ads} />
      </div>
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
