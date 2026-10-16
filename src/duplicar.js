/* Duplicar un torneo para la fecha siguiente: se copia la configuración (tipo, formato, categorías,
   cupos, precios, sedes, canchas, días y horarios de juego, circuito, portada) y se arranca de cero
   en lo que es de cada fecha (parejas, grupos, llaves, resultados, inscripciones). Las fechas se
   corren tantos días como haya entre el torneo original y el nuevo. */

const CATEGORIA_SIN_COPIAR = ["pairs", "groups", "bracket", "teams", "bracketPublished", "bracketIsSkeleton", "bracketSeeding"];
const TORNEO_SIN_COPIAR = ["rev", "_light", "eventId", "inscripcionesAbiertas", "categories"];

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000);
}
function correr(fecha, dias) {
  if (!fecha) return fecha;
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
// Las claves con "_" adelante son datos calculados del resumen (parejas, avance, podio): no se copian
const sin = (obj, claves) => Object.fromEntries(Object.entries(obj).filter(([k]) => !claves.includes(k) && !k.startsWith("_")));

/* "Fecha 3" → "Fecha 4"; "Torneo de Primavera" → "Torneo de Primavera (copia)" */
export function nombreSiguiente(nombre) {
  const m = String(nombre).match(/^(.*?)(\d+)(\s*)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}`.trim() : `${nombre} (copia)`;
}

export function duplicarTorneo(t, { name, date, estado, nuevoId }) {
  const dias = t.date && date ? diasEntre(t.date, date) : 0;
  const categorias = (t.categories || []).map((c) => {
    const nueva = { ...sin(c, CATEGORIA_SIN_COPIAR), id: nuevoId(), pairs: [], groups: [], bracket: null };
    if (c.format && c.format !== "zonas") nueva.teams = [];
    if (c.start?.date) nueva.start = { ...c.start, date: correr(c.start.date, dias) };
    if (c.bracketStart?.date) nueva.bracketStart = { ...c.bracketStart, date: correr(c.bracketStart.date, dias) };
    return nueva;
  });
  return {
    ...sin(t, TORNEO_SIN_COPIAR),
    id: nuevoId(),
    name,
    date,
    status: estado,
    inscripcionesAbiertas: false,
    playDates: (t.playDates || []).map((d) => ({ ...d, date: correr(d.date, dias) })),
    ...(t.venues ? { venues: t.venues.map((v) => (v.days ? { ...v, days: v.days.map((d) => ({ ...d, date: correr(d.date, dias) })) } : v)) } : {}),
    categories: categorias,
  };
}
