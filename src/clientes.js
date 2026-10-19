/* Clientes del complejo: se arman juntando los turnos de la agenda, las cuentas de la cantina y las
   inscripciones a torneos. La misma persona se reconoce por su WhatsApp; si no tiene, por el nombre
   (sin mayúsculas ni acentos). */

export const claveNombre = (nombre) => String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const claveDe = (telefono, nombre) => (telefono ? `t:${telefono}` : `n:${claveNombre(nombre)}`);

/* ¿El turno ya empezó? Con "ahora" (ms) mira la hora de inicio; sin eso, solo la fecha */
export const yaEmpezo = (r, hoy, ahora) => (ahora != null && r.inicio ? Date.parse(r.inicio) <= ahora : r.fecha <= hoy);

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000);
}

/* reservas: turnos (tipo turno) con nombre, telefono, fecha, estado, no_vino, precio, medio_pago
   cuentas: [{ id, nombre, telefono, consumido, pagado }]
   inscripciones: [{ jugador1_nombre, telefono, estado, torneo_id }] */
export function armarClientes({ reservas = [], cuentas = [], inscripciones = [], hoy, ahora }) {
  const mapa = new Map();
  const cliente = (telefono, nombre) => {
    // Si alguien sin WhatsApp ya está por nombre y ahora aparece con WhatsApp, se juntan
    const kn = `n:${claveNombre(nombre)}`;
    const k = claveDe(telefono, nombre);
    if (telefono && mapa.has(kn) && !mapa.has(k)) {
      const c = mapa.get(kn);
      mapa.delete(kn);
      c.clave = k; c.telefono = telefono;
      mapa.set(k, c);
    }
    if (!telefono) {
      // Sin WhatsApp: si hay uno con el mismo nombre y WhatsApp, es esa persona
      const conTel = [...mapa.values()].find((c) => c.telefono && claveNombre(c.nombre) === claveNombre(nombre));
      if (conTel) return conTel;
    }
    if (!mapa.has(k)) mapa.set(k, { clave: k, nombre: String(nombre || "").trim(), telefono: telefono || null, turnos: 0, proximos: 0, noVino: 0, ultimaVisita: null, gastado: 0, deuda: 0, cuentaId: null, torneos: 0, historial: [] });
    return mapa.get(k);
  };

  const ordenadas = [...reservas].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)); // la más nueva primero: su nombre queda
  for (const r of ordenadas) {
    if (r.tipo && r.tipo !== "turno") continue;
    if (!r.nombre) continue;
    const c = cliente(r.telefono, r.nombre);
    if (r.estado !== "confirmada") continue;
    c.historial.push(r);
    if (!yaEmpezo(r, hoy, ahora)) { c.proximos += 1; continue; }
    if (r.no_vino) { c.noVino += 1; continue; }
    c.turnos += 1;
    if (!c.ultimaVisita || r.fecha > c.ultimaVisita) c.ultimaVisita = r.fecha;
    if (r.medio_pago && r.precio != null) c.gastado += Number(r.precio);
  }
  for (const k of cuentas) {
    const c = cliente(k.telefono, k.nombre);
    c.cuentaId = k.id;
    c.deuda += Math.max(0, Number(k.consumido) - Number(k.pagado)) + Number(k.debe_inscripciones || 0);
  }
  for (const i of inscripciones) {
    if (i.estado !== "aceptada") continue;
    cliente(i.telefono, i.jugador1_nombre).torneos += 1;
  }
  return [...mapa.values()].map((c) => ({ ...c, diasSinVenir: c.ultimaVisita ? diasEntre(c.ultimaVisita, hoy) : null }));
}

/* Los que venían y hace un tiempo que no vienen (sin turnos próximos) */
export const noVienenHace = (c, dias = 30) => c.turnos > 0 && c.proximos === 0 && c.diasSinVenir != null && c.diasSinVenir >= dias;
