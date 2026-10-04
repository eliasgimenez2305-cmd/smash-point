/* Resultados de partidos y tabla de posiciones de un grupo.
   Está en un archivo aparte (sin React) para poder probarlo solo: ver standings.test.js y
   `npm test`. */

export const DEFAULT_MATCH_FORMAT = { setsToPlay: 3, gamesPerSet: 6, setTiebreak: true, finalSuperTiebreak: true };

/* Cuenta sets ganados por cada lado a partir de los games/puntos cargados set por set */
export function setsWon(match) {
  let a = 0, b = 0;
  (match.sets || []).forEach((s) => {
    if (!s || s.a == null || s.b == null) return;
    if (s.a > s.b) a++; else if (s.b > s.a) b++;
  });
  return { a, b };
}

export function matchIsPlayed(match) {
  if (match && (match.walkover || match.retired)) return true;
  const { a, b } = setsWon(match);
  return a + b > 0;
}

export function matchWinnerId(match) {
  if (match && match.walkover) return match.walkover === match.pairA ? match.pairB : match.pairA;
  if (match && match.retired) return match.retired === match.pairA ? match.pairB : match.pairA;
  const { a, b } = setsWon(match);
  if (a === b) return null;
  return a > b ? match.pairA : match.pairB;
}

export function winnerOf(m) {
  if (m.pairA && !m.pairB) return m.pairA;
  if (m.pairB && !m.pairA) return m.pairB;
  return matchWinnerId(m);
}

export function loserOf(m) {
  if (!matchIsPlayed(m) || !m.pairA || !m.pairB) return null;
  const w = matchWinnerId(m);
  if (!w) return null;
  return w === m.pairA ? m.pairB : m.pairA;
}

/* Un W.O. se computa como el partido ganado sin jugar por la pareja que se presentó: a sets, dos
   sets a cero (6-0 6-0 con sets de 6 games); en un set único (Americano), un set a cero con los
   games del torneo (7-0 o 9-0). Los sets quedan del lado de cada pareja (a = pairA). */
export function walkoverSets(match, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const games = f.gamesPerSet || 6;
  const count = f.setsToPlay === 1 ? 1 : 2;
  const presentIsA = match.walkover === match.pairB;
  return Array.from({ length: count }, () => (presentIsA ? { a: games, b: 0 } : { a: 0, b: games }));
}

/* Retiro por lesión (RET): se respeta el marcador hasta donde se jugó y se completa el resto a
   favor del rival. El set cortado lo termina ganando el rival (con 5 o 6 games del que se retira
   queda 7-5 o 7-6; en set único, el rival llega a los games del set; en el super tie-break, a 10
   o a dos puntos de diferencia) y los sets que faltan se cuentan enteros para el rival (6-0, o
   10-0 el super tie-break). Los sets quedan del lado de cada pareja (a = pairA). */
export function retiredSets(match, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const games = f.gamesPerSet || 6;
  const total = f.setsToPlay || 3;
  const single = total === 1;
  const need = Math.floor(total / 2) + 1;
  const stbIndex = f.finalSuperTiebreak && total > 1 ? total - 1 : -1;
  const rivalIsA = match.retired === match.pairB;
  const side = (rival, retired) => (rivalIsA ? { a: rival, b: retired } : { a: retired, b: rival });

  const out = [];
  let rivalSets = 0, retiredWon = 0;
  for (let i = 0; i < total && rivalSets < need && retiredWon < need; i++) {
    const s = (match.sets || [])[i];
    const isStb = i === stbIndex;
    const started = s && (s.a != null || s.b != null);
    if (!started) {
      out.push(side(isStb ? 10 : games, 0));
      rivalSets++;
      continue;
    }
    const r = (rivalIsA ? s.a : s.b) || 0;
    const q = (rivalIsA ? s.b : s.a) || 0;
    const hi = Math.max(r, q), lo = Math.min(r, q);
    const complete = isStb ? hi >= 10 && hi - lo >= 2
      : single ? hi === games && lo < games
      : (hi >= games && hi - lo >= 2) || (hi === games + 1 && lo === games);
    if (complete) {
      out.push(side(r, q));
      if (r > q) rivalSets++; else retiredWon++;
    } else {
      const rivalFinal = isStb ? Math.max(10, q + 2) : single ? games : q >= games - 1 ? games + 1 : games;
      out.push(side(rivalFinal, q));
      rivalSets++;
    }
  }
  return out;
}

/* Los sets con que cuenta un partido: los cargados, los del W.O. si no se jugó, o los cargados
   completados a favor del rival si hubo retiro (RET) */
export function effectiveSets(match, format) {
  if (match.walkover) return walkoverSets(match, format);
  if (match.retired) return retiredSets(match, format);
  return match.sets || [];
}

/* Número pseudoaleatorio fijo para cada pareja del grupo: es el "sorteo" del último desempate.
   Siempre da lo mismo para el mismo grupo, así la tabla no cambia cada vez que se abre. */
function drawNumber(groupId, pairId) {
  let h = 5381;
  for (const ch of `${groupId}|${pairId}`) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h;
}

const setDiff = (r) => r.setsF - r.setsC;
const gameDiff = (r) => r.gamesF - r.gamesC;

/* Suma a las filas de cada pareja lo que dejó un partido: sets y games (con el super tie-break
   del set decisivo contando como un set y un game para quien lo ganó) */
function tallySetsAndGames(match, rowA, rowB, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const stbIndex = f.finalSuperTiebreak && f.setsToPlay > 1 ? f.setsToPlay - 1 : -1;
  effectiveSets(match, f).forEach((s, i) => {
    if (!s || s.a == null || s.b == null || s.a === s.b) return;
    const aWon = s.a > s.b;
    if (aWon) { rowA.setsF++; rowB.setsC++; } else { rowB.setsF++; rowA.setsC++; }
    if (i === stbIndex && !match.walkover) {
      // Super tie-break: son puntos, no games; vale un game para el que lo ganó
      if (aWon) { rowA.stb++; rowA.gamesF++; rowB.gamesC++; } else { rowB.stb++; rowB.gamesF++; rowA.gamesC++; }
    } else {
      rowA.gamesF += s.a; rowA.gamesC += s.b;
      rowB.gamesF += s.b; rowB.gamesC += s.a;
    }
  });
}

const emptyRow = (pairId) => ({ pairId, pj: 0, pg: 0, pp: 0, setsF: 0, setsC: 0, gamesF: 0, gamesC: 0, stb: 0, pts: 0, wo: 0, ret: false, eliminated: false, byDraw: false });

/* Ordena un grupo de parejas empatadas en puntos. Se usan los números de todo el grupo, no una
   mini tabla entre las empatadas, y el mismo criterio para todos los tipos de torneo:
   1. diferencia de sets
   2. diferencia de games
   3. games a favor (más es mejor)
   4. games en contra (menos es mejor)
   5. resultado entre sí: entre las que siguen empatadas, la que ganó más partidos contra las otras
   6. sorteo (marca byDraw en las parejas que quedaron ordenadas así) */
function orderTied(tied, matches, groupId) {
  if (tied.length < 2) return tied;
  const key = (r) => [setDiff(r), gameDiff(r), r.gamesF, -r.gamesC];
  const sameKey = (x, y) => key(x).every((v, i) => v === key(y)[i]);
  const byStats = [...tied].sort((x, y) => {
    const kx = key(x), ky = key(y);
    for (let i = 0; i < kx.length; i++) if (ky[i] !== kx[i]) return ky[i] - kx[i];
    return 0;
  });

  // Bloques de parejas iguales en los cuatro números: se definen por resultado entre sí y sorteo
  const out = [];
  for (let i = 0; i < byStats.length;) {
    let j = i + 1;
    while (j < byStats.length && sameKey(byStats[i], byStats[j])) j++;
    out.push(...orderByHeadToHead(byStats.slice(i, j), matches, groupId));
    i = j;
  }
  return out;
}

/* Resultado entre sí y, si sigue el empate, sorteo */
function orderByHeadToHead(block, matches, groupId) {
  if (block.length < 2) return block;
  const ids = new Set(block.map((r) => r.pairId));
  const wins = Object.fromEntries(block.map((r) => [r.pairId, 0]));
  matches.forEach((m) => {
    if (!ids.has(m.pairA) || !ids.has(m.pairB)) return;
    const w = matchWinnerId(m);
    if (w) wins[w]++;
  });
  const draw = (r) => drawNumber(groupId, r.pairId);
  const sorted = [...block].sort((x, y) => wins[y.pairId] - wins[x.pairId] || draw(x) - draw(y));
  for (let i = 1; i < sorted.length; i++) {
    if (wins[sorted[i - 1].pairId] === wins[sorted[i].pairId]) { sorted[i - 1].byDraw = true; sorted[i].byDraw = true; }
  }
  return sorted;
}

/* Tabla de posiciones de un grupo: PJ, PG, PP, sets y games a favor y en contra, super
   tie-breaks ganados y puntos (2 por partido ganado).

   Orden:
   - Grupo de 4 con sorteo y cruces (format "bracket4"): lo definen los cruces de ganadores y de
     perdedores; mientras no se jueguen, orden provisorio por puntos, sets y games.
   - El resto: puntos y, entre empatadas, diferencia de sets, de games, games a favor, games en
     contra, resultado entre sí y sorteo (ver orderTied).
   - W.O.: afecta solo ese partido. Cuenta como ganado sin jugar por la pareja que se presentó
     (ver walkoverSets) y 0 puntos para la que no vino, que sigue en el torneo y puede clasificar
     si le dan los números. wo cuenta cuántos W.O. dio (solo informativo).
   - Pareja eliminada (pairsById[id].eliminated: la sacó el organizador porque abandonó): va
     siempre al fondo, sea cual sea su puntaje; si hay más de una, entre ellas se ordenan con el
     mismo desempate (ver orderTied). Sus partidos jugados siguen valiendo para sus rivales.
   - Retiro por lesión (RET): el partido cuenta con el marcador completado a favor del rival (ver
     retiredSets) y la pareja que se retiró queda eliminada (ret: true y eliminated: true). */
export function computeStandings(group, pairsById, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const table = Object.fromEntries(group.pairIds.map((pid) => [pid, { ...emptyRow(pid), eliminated: !!pairsById?.[pid]?.eliminated }]));
  const counted = group.matches.filter((m) => matchIsPlayed(m) && table[m.pairA] && table[m.pairB]);

  counted.forEach((m) => {
    const a = table[m.pairA], b = table[m.pairB];
    a.pj++; b.pj++;
    tallySetsAndGames(m, a, b, f);
    const w = matchWinnerId(m);
    if (w) {
      const [winner, loser] = w === m.pairA ? [a, b] : [b, a];
      winner.pg++; winner.pts += 2; loser.pp++;
    }
    if (m.walkover && table[m.walkover]) table[m.walkover].wo++;
    if (m.retired && table[m.retired]) { table[m.retired].ret = true; table[m.retired].eliminated = true; }
  });

  const rows = Object.values(table);
  const present = rows.filter((r) => !r.eliminated);
  const eliminated = orderTied(rows.filter((r) => r.eliminated), counted, group.id);

  let ordered;
  if (group.format === "bracket4" && group.matches.length === 4) {
    // 1° = ganó el cruce de ganadores, 2° = lo perdió, 3° = ganó el de perdedores, 4° = lo perdió.
    // Las dos del cruce de ganadores van siempre arriba de las del de perdedores, aunque su cruce
    // todavía no se haya jugado (entre ellas, orden provisorio por la tabla).
    const [, , mw, ml] = group.matches;
    const place = (id) => {
      for (const [m, base] of [[mw, 0], [ml, 2]]) {
        if (!m || (m.pairA !== id && m.pairB !== id)) continue;
        const w = matchIsPlayed(m) ? matchWinnerId(m) : null;
        return w == null ? base + 0.5 : w === id ? base : base + 1;
      }
      return 99;
    };
    ordered = [...present].sort((x, y) => {
      const px = place(x.pairId), py = place(y.pairId);
      if (px !== py) return px - py;
      // Todavía sin definir (partidos no jugados): la tabla de puntos como orden provisorio
      if (y.pts !== x.pts) return y.pts - x.pts;
      if (setDiff(y) !== setDiff(x)) return setDiff(y) - setDiff(x);
      return gameDiff(y) - gameDiff(x);
    });
  } else {
    const byPoints = new Map();
    present.forEach((r) => byPoints.set(r.pts, [...(byPoints.get(r.pts) || []), r]));
    ordered = [...byPoints.keys()].sort((a, b) => b - a).flatMap((pts) => orderTied(byPoints.get(pts), counted, group.id));
  }
  return [...ordered, ...eliminated];
}
