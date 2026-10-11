/* Reserva de canchas: cuentas de horarios (ver supabase/migrations/20261014_reservas_canchas.sql).

   Todo se mide en minutos desde las 00:00 del día de la grilla, en hora de Argentina (UTC-3, sin
   horario de verano). Una cancha que cierra pasada la medianoche llega a más de 1440: la de 14:00 a
   01:00 va de 840 a 1500. Los turnos empiezan cada 30 minutos y duran 60, 90 o 120. */

export const PASO = 30;
export const DURACIONES = [60, 90, 120];
const OFFSET = "-03:00";

/* "14:30" o "14:30:00" → 870 */
export function aMinutos(hora) {
  const [h, m] = String(hora).split(":").map(Number);
  return h * 60 + (m || 0);
}

/* 870 → "14:30"; 1500 → "01:00" (pasada la medianoche) */
export function etiquetaHora(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/* Horario de una cancha en minutos del día: { desde, hasta } (hasta > 1440 si cierra al día siguiente) */
export function horarioCancha(cancha) {
  const desde = aMinutos(cancha.apertura);
  let hasta = aMinutos(cancha.cierre);
  if (hasta <= desde) hasta += 1440;
  return { desde, hasta };
}

/* Duraciones que ofrece una cancha (las que tienen precio cargado) */
export function duracionesOfrecidas(cancha) {
  return DURACIONES.filter((d) => cancha[`precio_${d}`] != null && cancha[`precio_${d}`] !== "");
}

export function precioDe(cancha, duracion) {
  const p = cancha?.[`precio_${duracion}`];
  return p == null || p === "" ? null : Number(p);
}

/* Horarios de inicio de una cancha (cada 30 min) en los que entra un turno de esa duración */
export function iniciosPosibles(cancha, duracion = PASO) {
  const { desde, hasta } = horarioCancha(cancha);
  const out = [];
  for (let m = desde; m + duracion <= hasta; m += PASO) out.push(m);
  return out;
}

/* "2026-10-14" + 1 → "2026-10-15" */
export function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Instante (ISO con la zona de Argentina) de un minuto de la grilla de ese día */
export function instante(fecha, min) {
  const dias = Math.floor(min / 1440);
  return `${sumarDias(fecha, dias)}T${etiquetaHora(min)}:00${OFFSET}`;
}

/* Minuto de la grilla de "fecha" que corresponde a un instante guardado (timestamptz) */
export function minutoEnGrilla(fecha, iso) {
  return Math.round((Date.parse(iso) - Date.parse(`${fecha}T00:00:00${OFFSET}`)) / 60000);
}

/* Fecha de hoy en Argentina, "2026-10-14" */
export function hoyArgentina(ahora = new Date()) {
  return new Date(ahora.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

/* "Martes 14/10" */
export function etiquetaFecha(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  const dia = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"][d.getUTCDay()];
  return `${dia} ${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;
}

/* ¿La reserva ocupa la cancha? (los bloqueos también; las canceladas, rechazadas o vencidas no) */
export function reservaActiva(r) {
  return r.estado === "pendiente" || r.estado === "confirmada";
}

/* Reservas activas de una cancha en ese día, como { r, desde, hasta } en minutos de la grilla */
export function ocupacion(fecha, canchaId, reservas) {
  return reservas
    .filter((r) => r.cancha_id === canchaId && reservaActiva(r))
    .map((r) => ({ r, desde: minutoEnGrilla(fecha, r.inicio), hasta: minutoEnGrilla(fecha, r.fin) }))
    .sort((a, b) => a.desde - b.desde);
}

/* ¿Se puede poner un turno de [desde, desde+duracion) en la cancha? Devuelve null si sí, o el motivo */
export function motivoNoEntra(cancha, fecha, desde, duracion, reservas) {
  const { desde: abre, hasta: cierra } = horarioCancha(cancha);
  const hasta = desde + duracion;
  if (desde < abre || hasta > cierra) return "fuera_de_horario";
  if (ocupacion(fecha, cancha.id, reservas).some((o) => o.desde < hasta && desde < o.hasta)) return "superpuesto";
  return null;
}

/* Horarios de inicio libres en un complejo (en alguna de sus canchas que ofrezca esa duración),
   que todavía no pasaron y desde un minuto mínimo: [{ desde, cancha }] con la primera cancha libre */
export function iniciosLibres(canchas, fecha, duracion, ocupado, { desdeMin = 0, ahora = Date.now() } = {}) {
  const porInicio = new Map();
  for (const c of canchas) {
    if (!duracionesOfrecidas(c).includes(duracion)) continue;
    for (const m of iniciosPosibles(c, duracion)) {
      if (m < desdeMin || porInicio.has(m) || Date.parse(instante(fecha, m)) <= ahora) continue;
      if (motivoNoEntra(c, fecha, m, duracion, ocupado) === null) porInicio.set(m, c);
    }
  }
  return [...porInicio.entries()].sort((a, b) => a[0] - b[0]).map(([desde, cancha]) => ({ desde, cancha }));
}

/* Precio más barato de esa duración entre las canchas ("desde $…") */
export function precioDesde(canchas, duracion) {
  const precios = canchas.map((c) => precioDe(c, duracion)).filter((p) => p != null);
  return precios.length > 0 ? Math.min(...precios) : null;
}

/* Filas de la agenda: de la primera apertura al último cierre de las canchas, cada 30 min */
export function filasAgenda(canchas) {
  if (canchas.length === 0) return [];
  const hs = canchas.map(horarioCancha);
  const desde = Math.min(...hs.map((h) => h.desde));
  const hasta = Math.max(...hs.map((h) => h.hasta));
  const out = [];
  for (let m = desde; m < hasta; m += PASO) out.push(m);
  return out;
}

/* Fechas de un turno fijo: la misma fecha y las N-1 semanas siguientes */
export function fechasSemanales(fecha, semanas) {
  return Array.from({ length: Math.max(1, semanas) }, (_, i) => sumarDias(fecha, i * 7));
}

/* Normaliza un precio escrito a mano ("12.000", "12000", "") → número o null */
export function leerPrecio(texto) {
  const limpio = String(texto ?? "").replace(/[^\d]/g, "");
  return limpio === "" ? null : Number(limpio);
}

/* 12000 → "$12.000" */
export function formatoPrecio(n) {
  if (n == null || n === "") return "";
  return "$" + Math.round(Number(n)).toLocaleString("es-AR");
}
