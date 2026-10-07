/* Mezcla de cambios cuando dos personas guardan el mismo torneo a la vez.

   Cada torneo lleva un número de versión (rev) que la base sube con cada guardado. Si alguien
   guarda sobre una versión vieja, la base lo rechaza y devuelve la versión actual (remote). Acá se
   rearma lo que había querido guardar (mine) sobre esa versión actual, mirando qué cambió cada uno
   desde la versión de la que partió (base):
   - Categorías: se toma la de quien la cambió. Si las dos personas cambiaron la misma categoría de
     forma distinta, queda la de la base (lo que ya estaba guardado) y se avisa: conflicts.
   - Datos generales del torneo (nombre, horarios, canchas...): lo mismo, campo por campo.
   Está en un archivo aparte (sin React) para poder probarlo: ver merge.test.js. */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
