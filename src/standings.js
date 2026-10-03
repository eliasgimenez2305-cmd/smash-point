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
  if (match && match.walkover) return true;
  const { a, b } = setsWon(match);
  return a + b > 0;
}

export function matchWinnerId(match) {
  if (match && match.walkover) return match.walkover === match.pairA ? match.pairB : match.pairA;
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

/* Los sets con que cuenta un partido: los cargados, o los del W.O. si no se jugó */
export function effectiveSets(match, format) {
  return match.walkover ? walkoverSets(match, format) : match.sets || [];
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

const emptyRow = (pairId) => ({ pairId, pj: 0, pg: 0, pp: 0, setsF: 0, setsC: 0, gamesF: 0, gamesC: 0, stb: 0, pts: 0, wo: 0, eliminated: false, byDraw: false });

/* Ordena un grupo de parejas empatadas en puntos según el reglamento de la FIP:
   - Dos empatadas: manda el enfrentamiento directo.
   - Tres o más: no se mira el enfrentamiento directo (arma un círculo sin salida). Se arma una
     mini tabla solo con los partidos entre las empatadas y se ordena por diferencia de sets,
     después diferencia de games y, si sigue el empate, por sorteo.
   Si todavía no se jugó el partido entre dos empatadas, se usa la diferencia general de sets y de
   games, y después el sorteo. */
function orderTied(tied, matches, groupId, format) {
  if (tied.length < 2) return tied;
  const ids = new Set(tied.map((r) => r.pairId));
  const between = matches.filter((m) => ids.has(m.pairA) && ids.has(m.pairB));
  const draw = (r) => drawNumber(groupId, r.pairId);

  if (tied.length === 2) {
    const [x, y] = tied;
    const winsX = between.filter((m) => matchWinnerId(m) === x.pairId).length;
    const winsY = between.filter((m) => matchWinnerId(m) === y.pairId).length;
    if (winsX !== winsY) return winsX > winsY ? [x, y] : [y, x];
    return sortByDiffThenDraw(tied, (r) => r, draw);
  }

  const mini = Object.fromEntries(tied.map((r) => [r.pairId, emptyRow(r.pairId)]));
  between.forEach((m) => tallySetsAndGames(m, mini[m.pairA], mini[m.pairB], format));
  return sortByDiffThenDraw(tied, (r) => mini[r.pairId], draw);
}

/* Orden por diferencia de sets, después de games (de las estadísticas que da statsOf) y, si
   sigue el empate, por sorteo. Marca byDraw en las parejas que quedaron ordenadas por sorteo. */
function sortByDiffThenDraw(rows, statsOf, draw) {
  const key = (r) => [setDiff(statsOf(r)), gameDiff(statsOf(r))];
  const sorted = [...rows].sort((x, y) => {
    const kx = key(x), ky = key(y);
    if (ky[0] !== kx[0]) return ky[0] - kx[0];
    if (ky[1] !== kx[1]) return ky[1] - kx[1];
    return draw(x) - draw(y);
  });
  for (let i = 1; i < sorted.length; i++) {
    const a = key(sorted[i - 1]), b = key(sorted[i]);
    if (a[0] === b[0] && a[1] === b[1]) { sorted[i - 1].byDraw = true; sorted[i].byDraw = true; }
  }
  return sorted;
}

/* Tabla de posiciones de un grupo: PJ, PG, PP, sets y games a favor y en contra, super
   tie-breaks ganados y puntos (2 por partido ganado).

   Orden:
   - Grupo de 4 con sorteo y cruces (format "bracket4"): lo definen los cruces de ganadores y de
     perdedores; mientras no se jueguen, orden provisorio por puntos, sets y games.
   - El resto: puntos y, entre empatadas, el desempate de la FIP (ver orderTied).
   - W.O.: afecta solo ese partido. Cuenta como ganado sin jugar por la pareja que se presentó
     (ver walkoverSets) y 0 puntos para la que no vino, que sigue en el torneo y puede clasificar
     si le dan los números. wo cuenta cuántos W.O. dio (solo informativo).
   - Pareja eliminada (pairsById[id].eliminated: la sacó el organizador porque abandonó): va
     siempre al fondo, sea cual sea su puntaje; si hay más de una, entre ellas se ordenan por sets
     y después por games. Sus partidos jugados siguen valiendo para sus rivales. */
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
  });

  const rows = Object.values(table);
  const present = rows.filter((r) => !r.eliminated);
  const eliminated = sortByDiffThenDraw(rows.filter((r) => r.eliminated), (r) => r, (r) => drawNumber(group.id, r.pairId));

  let ordered;
  if (group.format === "bracket4" && group.matches.length === 4) {
    // 1° = ganó el cruce de ganadores, 2° = lo perdió, 3° = ganó el de perdedores, 4° = lo perdió
    const [, , mw, ml] = group.matches;
    const order = [winnerOf(mw), loserOf(mw), winnerOf(ml), loserOf(ml)];
    ordered = [...present].sort((x, y) => {
      const rx = order.indexOf(x.pairId), ry = order.indexOf(y.pairId);
      const px = rx === -1 ? 99 : rx, py = ry === -1 ? 99 : ry;
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
