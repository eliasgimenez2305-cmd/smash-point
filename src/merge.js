/* Mezcla de cambios cuando dos personas guardan el mismo torneo a la vez.

   Cada torneo lleva un número de versión (rev) que la base sube con cada guardado. Si alguien
   guarda sobre una versión vieja, la base lo rechaza y devuelve la versión actual (remote). Acá se
   rearma lo que había querido guardar (mine) sobre esa versión actual, mirando qué cambió cada uno
   desde la versión de la que partió (base):
   - Categorías: se toma la de quien la cambió. Si las dos personas cambiaron la misma categoría de
     forma distinta, queda la de la base (lo que ya estaba guardado) y se avisa: conflicts.
   - Datos generales del torneo (nombre, horarios, canchas...): lo mismo, campo por campo.
   - Si la otra persona solo cargó resultados (ver matchChanges), no hay choque: se aplican sus
     resultados sobre lo propio.

   matchChanges / applyMatchChanges: lo que se carga en los partidos (resultado, W.O., RET, en curso
   y horario) se guarda de a partido con guardar_partidos (supabase/migrations/20261009_tabla_torneos.sql),
   así dos celulares cargando partidos distintos no chocan.

   Está en un archivo aparte (sin React) para poder probarlo: ver merge.test.js. */

// Iguales en contenido, sin importar el orden de las claves (la app arma los objetos en distinto
// orden según por dónde pasaron: comparar el texto tal cual daba choques que no eran)
const same = (a, b) => stable(a) === stable(b);

// Lo que se carga en un partido. Es lo único que guardar_partidos acepta.
export const MATCH_FIELDS = ["sets", "walkover", "retired", "liveStatus", "schedule"];

// JSON con las claves ordenadas, para comparar sin depender del orden en que se armó cada objeto
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/* El torneo sin lo que se carga en los partidos ni lo que la app deduce de los resultados (y vuelve
   a calcular al leer): las parejas de los cruces de un grupo de 4, las de la llave desde la segunda
   ronda y, mientras la llave espera a los grupos, las de la primera ronda. */
function structureOf(t) {
  const strip = (m, derivedPairs) => {
    const out = { ...m };
    MATCH_FIELDS.forEach((k) => delete out[k]);
    if (derivedPairs) { delete out.pairA; delete out.pairB; }
    return out;
  };
  const { rev, ...rest } = t || {};
  return {
    ...rest,
    categories: (rest.categories || []).map((c) => {
      const { bracketIsSkeleton, bracketSeeding, ...cat } = c;
      return {
        ...cat,
        groups: (c.groups || []).map((g) => ({
          ...g,
          matches: (g.matches || []).map((m) => strip(m, g.format === "bracket4" && (m.stage === "ganadores" || m.stage === "perdedores"))),
        })),
        bracket: c.bracket ? c.bracket.map((round, ri) => round.map((m) => strip(m, ri > 0 || !!c.bracketIsSkeleton))) : c.bracket,
      };
    }),
  };
}

// Todos los partidos de un torneo: "categoría|partido" -> { categoria, m }
function matchesById(t) {
  const out = new Map();
  (t?.categories || []).forEach((c) => {
    (c.groups || []).forEach((g) => (g.matches || []).forEach((m) => out.set(`${c.id}|${m.id}`, { categoria: c.id, m })));
    (c.bracket || []).forEach((round) => round.forEach((m) => out.set(`${c.id}|${m.id}`, { categoria: c.id, m })));
  });
  return out;
}

/* Lo que cambió en los partidos de base a next: [{ categoria, partido, cambios }] con solo los
   campos de MATCH_FIELDS que cambiaron (null = se borró). Devuelve null si cambió algo más del
   torneo (parejas, grupos, configuración...): eso se guarda entero, con su versión. */
export function matchChanges(base, next) {
  if (!base || !next || stable(structureOf(base)) !== stable(structureOf(next))) return null;
  const before = matchesById(base);
  const changes = [];
  matchesById(next).forEach(({ categoria, m }, key) => {
    const old = before.get(key)?.m || {};
    const cambios = {};
    MATCH_FIELDS.forEach((k) => { if (stable(old[k]) !== stable(m[k])) cambios[k] = m[k] ?? null; });
    if (Object.keys(cambios).length > 0) changes.push({ categoria, partido: m.id, cambios });
  });
  return changes;
}

/* Aplica esos cambios sobre otro torneo (por ejemplo, la versión que guardó otra persona). Los
   partidos que ya no existen se saltean y vuelven en omitted. */
export function applyMatchChanges(t, changes) {
  const byKey = new Map(changes.map((c) => [`${c.categoria}|${c.partido}`, c.cambios]));
  const used = new Set();
  const patch = (catId, m) => {
    const cambios = byKey.get(`${catId}|${m.id}`);
    if (!cambios) return m;
    used.add(`${catId}|${m.id}`);
    return { ...m, ...cambios };
  };
  const tournament = {
    ...t,
    categories: (t.categories || []).map((c) => ({
      ...c,
      groups: (c.groups || []).map((g) => ({ ...g, matches: (g.matches || []).map((m) => patch(c.id, m)) })),
      bracket: c.bracket ? c.bracket.map((round) => round.map((m) => patch(c.id, m))) : c.bracket,
    })),
  };
  const omitted = changes.filter((c) => !used.has(`${c.categoria}|${c.partido}`)).map((c) => c.partido);
  return { tournament, omitted };
}

function mergeCategories(base, mine, remote, conflicts) {
  const byId = (list) => new Map((list || []).map((c) => [c.id, c]));
  const b = byId(base), m = byId(mine), r = byId(remote);
  // Orden: el de la versión guardada, con las categorías nuevas propias al final
  const ids = [...(remote || []).map((c) => c.id), ...(mine || []).map((c) => c.id).filter((id) => !r.has(id))];
  const out = [];
  ids.forEach((id) => {
    const mineChanged = !same(b.get(id), m.get(id));
    const remoteChanged = !same(b.get(id), r.get(id));
    let pick;
    if (mineChanged && remoteChanged && !same(m.get(id), r.get(id))) {
      conflicts.push((r.get(id) || m.get(id) || b.get(id)).name);
      pick = r.get(id);
    } else {
      pick = mineChanged ? m.get(id) : r.get(id);
    }
    if (pick) out.push(pick);
  });
  return out;
}

/* ¿La versión que trajo la recarga automática es más vieja que la última que sabemos guardada?
   Pasa cuando la lectura salió antes de un guardado y llegó después: aplicarla borraría ese
   cambio de la pantalla (y el próximo guardado lo borraría de la base). known: la última versión
   conocida de ese torneo (o undefined). */
export function isStaleRemote(known, remote) {
  return (known?.rev ?? -1) > (remote?.rev ?? 0);
}

/* Devuelve { merged, conflicts }: el torneo para volver a guardar y los nombres de las categorías
   (o "datos del torneo") donde los dos cambios chocaron y quedó lo que ya estaba guardado. */
export function mergeTournament(base, mine, remote) {
  // La otra persona solo cargó resultados: van sobre lo propio, sin choque
  const theirs = matchChanges(base, remote);
  if (theirs) {
    const { tournament } = applyMatchChanges(mine, theirs);
    return { merged: { ...tournament, rev: remote?.rev ?? 0 }, conflicts: [] };
  }
  const conflicts = [];
  const merged = { ...remote };
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(mine || {}), ...Object.keys(remote || {})]);
  let generalConflict = false;
  keys.forEach((k) => {
    if (k === "categories" || k === "rev") return;
    const mineChanged = !same(base?.[k], mine?.[k]);
    const remoteChanged = !same(base?.[k], remote?.[k]);
    if (!mineChanged) return; // queda lo guardado
    if (remoteChanged && !same(mine?.[k], remote?.[k])) { generalConflict = true; return; }
    if (mine && k in mine) merged[k] = mine[k]; else delete merged[k];
  });
  if (generalConflict) conflicts.push("datos del torneo");
  merged.categories = mergeCategories(base?.categories, mine?.categories, remote?.categories, conflicts);
  merged.rev = remote?.rev ?? 0;
  return { merged, conflicts };
}
