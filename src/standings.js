/* Resultados de partidos y tabla de posiciones de un grupo.
   Está en un archivo aparte (sin React) para poder probarlo solo: ver standings.test.js y
   `npm test`. */

export const DEFAULT_MATCH_FORMAT = { setsToPlay: 3, gamesPerSet: 6, setTiebreak: true, finalSuperTiebreak: true };

/* Cuenta sets ganados por cada lado a partir de los games/puntos cargados set por set, tal como
   están (para mostrar). Para saber si el partido terminó y quién ganó, ver matchIsPlayed y
   matchWinnerId, que solo cuentan sets terminados. */
export function setsWon(match) {
  let a = 0, b = 0;
  (match.sets || []).forEach((s) => {
    if (!s || s.a == null || s.b == null) return;
    if (s.a > s.b) a++; else if (s.b > s.a) b++;
  });
  return { a, b };
}

/* Sets que hay que ganar para llevarse el partido: 1 en set único, 2 al mejor de 3 o en 2 sets */
export function setsNeeded(format) {
  const n = (format || DEFAULT_MATCH_FORMAT).setsToPlay || 3;
  return n === 1 ? 1 : Math.floor(n / 2) + 1;
}

/* ¿El set i es el super tie-break (a 10 puntos) del formato? */
export function isSuperTiebreakSet(i, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  return !!f.finalSuperTiebreak && f.setsToPlay > 1 && i === f.setsToPlay - 1;
}

/* ¿El set cargado es un resultado final posible? Un set en juego (3-2) o mal tipeado (7-3) no:
   - Super tie-break: 10 con 8 o menos del otro lado, o más de 10 con dos de diferencia.
   - Set único (Súper 8, Americano): llegar a los games del set (en el empate se juega tie break).
   - Set común con tie break: 6-4 o menos, 7-5 o 7-6 (con sets a 6).
   - Set común sin tie break: llegar a los games con dos de diferencia (8-6, 9-7...). */
export function setIsComplete(set, i, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  if (!set || set.a == null || set.b == null || set.a === set.b) return false;
  const hi = Math.max(set.a, set.b), lo = Math.min(set.a, set.b);
  const g = f.gamesPerSet || 6;
  if (isSuperTiebreakSet(i, f)) return (hi === 10 && lo <= 8) || (hi > 10 && hi - lo === 2);
  if (f.setsToPlay === 1) return hi === g && lo <= g - 1;
  if (f.setTiebreak) return (hi === g && lo <= g - 2) || (hi === g + 1 && (lo === g - 1 || lo === g));
  return (hi === g && lo <= g - 2) || (hi > g && hi - lo === 2);
}

/* Sets terminados de cada lado, en orden, hasta que alguien llega a los sets necesarios (lo que
   se cargue después no cuenta). decided: alguien ganó; complete: no queda nada por jugar (ganó
   alguien o se jugaron todos los sets, por ejemplo un 1-1 en "2 sets directos"). */
function finishedSets(match, format) {
  const f = format || DEFAULT_MATCH_FORMAT;
  const need = setsNeeded(f);
  const total = f.setsToPlay || 3;
  let a = 0, b = 0, played = 0;
  for (let i = 0; i < total; i++) {
    const s = (match.sets || [])[i];
    if (!setIsComplete(s, i, f)) break;
    if (s.a > s.b) a++; else b++;
    played++;
    if (a >= need || b >= need) break;
  }
  const decided = a >= need || b >= need;
  return { a, b, played, decided, complete: decided || played === total };
}

/* Los sets que valen de un partido terminado, para mostrar y para la tabla: con W.O. o retiro, los
   completados (ver effectiveSets); si no, los que definieron el partido, sin un set cargado de más
   después. Con el partido a medias devuelve lo cargado, tal cual. */
export function countedSets(match, format) {
  if (match.walkover || match.retired) return effectiveSets(match, format);
  const fin = finishedSets(match, format);
  return fin.complete ? (match.sets || []).slice(0, fin.played) : match.sets || [];
}

/* ¿Tiene algún resultado cargado, aunque sea a medias? (para no dejar cambiar parejas o grupos
   que ya empezaron a jugar) */
export function matchHasScore(match) {
  if (match && (match.walkover || match.retired)) return true;
  const { a, b } = setsWon(match);
  return a + b > 0;
}

/* ¿Terminó el partido? Con W.O. o retiro sí; si no, cuando alguien ganó los sets necesarios (o
   se jugaron todos). Un partido a medias (6-4 y nada más) todavía no terminó. */
export function matchIsPlayed(match, format) {
  if (match && (match.walkover || match.retired)) return true;
  return finishedSets(match, format).complete;
}

export function matchWinnerId(match, format) {
  if (match && match.walkover) return match.walkover === match.pairA ? match.pairB : match.pairA;
  if (match && match.retired) return match.retired === match.pairA ? match.pairB : match.pairA;
  const { a, b, decided } = finishedSets(match, format);
  if (!decided) return null;
  return a > b ? match.pairA : match.pairB;
}

export function winnerOf(m, format) {
  if (m.pairA && !m.pairB) return m.pairA;
  if (m.pairB && !m.pairA) return m.pairB;
  return matchWinnerId(m, format);
}

export function loserOf(m, format) {
  if (!matchIsPlayed(m, format) || !m.pairA || !m.pairB) return null;
  const w = matchWinnerId(m, format);
  if (!w) return null;
  return w === m.pairA ? m.pairB : m.pairA;
}

/* Recorre una llave ronda por ronda: completa cada ronda con los ganadores de la anterior y
   devuelve { rounds, winners } (winners[r][i]: ganador del partido i de la ronda r, o null).
   Un lugar vacío solo es un bye (la pareja del otro lado pasa sola) si nunca va a llegar nadie:
   en la primera ronda, cuando no tiene pareja ni texto de "1° Grupo A"; en las siguientes, cuando
   los dos partidos que lo alimentan también están vacíos para siempre. Si el lugar está esperando
   al ganador de un partido que todavía no se jugó, no pasa nadie. */
export function walkBracket(rounds, format) {
  const next = rounds.map((r) => r.map((m) => ({ ...m })));
  const winners = [];
  let deadPrev = null; // deadPrev[i]: el partido i de la ronda anterior no va a tener ganador nunca
  for (let r = 0; r < next.length; r++) {
    const feederDead = (i, slot) => (r === 0 ? false : deadPrev[2 * i + (slot === "pairA" ? 0 : 1)]);
    const slotDead = (m, i, slot) => !m[slot] && (r === 0 ? !m[slot === "pairA" ? "placeholderA" : "placeholderB"] : feederDead(i, slot));
    const dead = next[r].map((m, i) => slotDead(m, i, "pairA") && slotDead(m, i, "pairB"));
    winners[r] = next[r].map((m, i) => {
      if (m.pairA && m.pairB) return matchWinnerId(m, format);
      const lone = m.pairA || m.pairB;
      if (!lone) return null;
      return slotDead(m, i, m.pairA ? "pairB" : "pairA") ? lone : null;
    });
    if (r < next.length - 1) {
      next[r].forEach((m, i) => { next[r + 1][Math.floor(i / 2)][i % 2 === 0 ? "pairA" : "pairB"] = winners[r][i]; });
    }
    deadPrev = dead;
  }
  return { rounds: next, winners };
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
  // Sin W.O. ni retiro, solo los sets que definieron el partido (no un set de más cargado después)
  countedSets(match, f).forEach((s, i) => {
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
function orderTied(tied, matches, groupId, format) {
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
    out.push(...orderByHeadToHead(byStats.slice(i, j), matches, groupId, format));
    i = j;
  }
  return out;
}

/* Resultado entre sí y, si sigue el empate, sorteo */
function orderByHeadToHead(block, matches, groupId, format) {
  if (block.length < 2) return block;
  const ids = new Set(block.map((r) => r.pairId));
  const wins = Object.fromEntries(block.map((r) => [r.pairId, 0]));
  matches.forEach((m) => {
    if (!ids.has(m.pairA) || !ids.has(m.pairB)) return;
    const w = matchWinnerId(m, format);
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
  const counted = group.matches.filter((m) => matchIsPlayed(m, f) && table[m.pairA] && table[m.pairB]);

  counted.forEach((m) => {
    const a = table[m.pairA], b = table[m.pairB];
    a.pj++; b.pj++;
    tallySetsAndGames(m, a, b, f);
    const w = matchWinnerId(m, f);
    if (w) {
      const [winner, loser] = w === m.pairA ? [a, b] : [b, a];
      winner.pg++; winner.pts += 2; loser.pp++;
    }
    if (m.walkover && table[m.walkover]) table[m.walkover].wo++;
    if (m.retired && table[m.retired]) { table[m.retired].ret = true; table[m.retired].eliminated = true; }
  });

  const rows = Object.values(table);
  const present = rows.filter((r) => !r.eliminated);
  const eliminated = orderTied(rows.filter((r) => r.eliminated), counted, group.id, f);

  let ordered;
  if (group.format === "bracket4" && group.matches.length === 4) {
    // 1° = ganó el cruce de ganadores, 2° = lo perdió, 3° = ganó el de perdedores, 4° = lo perdió.
    // Las dos del cruce de ganadores van siempre arriba de las del de perdedores, aunque su cruce
    // todavía no se haya jugado (entre ellas, orden provisorio por la tabla).
    const [, , mw, ml] = group.matches;
    const place = (id) => {
      for (const [m, base] of [[mw, 0], [ml, 2]]) {
        if (!m || (m.pairA !== id && m.pairB !== id)) continue;
        const w = matchIsPlayed(m, f) ? matchWinnerId(m, f) : null;
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
    ordered = [...byPoints.keys()].sort((a, b) => b - a).flatMap((pts) => orderTied(byPoints.get(pts), counted, group.id, f));
  }
  return [...ordered, ...eliminated];
}
