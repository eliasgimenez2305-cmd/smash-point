/* Horarios de un día de juego que puede terminar pasada la medianoche.

   Un día "18:00 a 01:00" es la noche del viernes hasta la 1 del sábado: el cierre es más temprano
   que la apertura y llega hasta las 06:00 (MAX_AFTER_MIDNIGHT), así que se lee como del día
   siguiente. Los turnos de después de medianoche quedan en el mismo día de juego con la hora
   corrida ("24:00", "24:30"), así se ordenan después de las 23 y no chocan con el día siguiente;
   para mostrarlos se usa clockTime ("00:00", "00:30").

   Sin React, para poder probarlo: ver horas.test.js. */

const MAX_AFTER_MIDNIGHT = 6 * 60;

export const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/* ¿Un cierre "to" más temprano que la apertura "from" es de la madrugada siguiente? */
export function endsAfterMidnight(from, to) {
  if (!from || !to) return false;
  const f = toMin(from), t = toMin(to);
  return t < f && t <= MAX_AFTER_MIDNIGHT;
}

/* Minuto en que cierra un día de juego (o una ventana de disponibilidad) { from, to }: pasada la
   medianoche suma 24 h ("01:00" → 25:00) */
export function dayEndMin(day) {
  const t = toMin(day.to);
  return endsAfterMidnight(day.from, day.to) ? t + 24 * 60 : t;
}

/* ¿El horario "from a to" tiene turnos? Termina después de que empieza, o pasada la medianoche
   hasta las 06:00 */
export function validDayRange(from, to) {
  if (!from || !to) return false;
  return toMin(to) > toMin(from) || endsAfterMidnight(from, to);
}

/* Hora para mostrar: "24:30" → "00:30" */
export function clockTime(time) {
  if (!time) return time;
  const m = toMin(time);
  return m >= 24 * 60 ? toTime(m - 24 * 60) : time;
}

/* ¿La hora de un turno es de la madrugada siguiente ("24:00" en adelante)? */
export function isAfterMidnight(time) {
  return !!time && toMin(time) >= 24 * 60;
}
