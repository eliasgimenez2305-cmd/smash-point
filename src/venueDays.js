/* Sedes de un torneo Clásico y los días y horarios en que se usa cada una.

   t.venues: [{ id, name, courts, days? }]. Las canchas del torneo van numeradas de corrido (sede 1:
   canchas 1 a 3, sede 2: 4 y 5...). days: [{ date, from, to }] son los días en que se usa la sede y
   en qué horario; sin days, la sede se usa todos los días del torneo en el horario de cada uno.
   Una cancha está habilitada en un turno si el partido entero entra en el horario de su sede ese día.

   Sin React, para poder probarlo: ver venueDays.test.js. */

// Igual que DEFAULT_MATCH_DURATION de la app
const DEFAULT_DURATION = 60;

const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const durationOf = (t) => t?.matchDurationMinutes || DEFAULT_DURATION;

/* Horarios de arranque de un día de juego */
function dayTimes(day, duration) {
  const times = [];
  for (let m = toMin(day.from); m + duration <= toMin(day.to); m += duration) times.push(toTime(m));
  return times;
}

/* Sede de una cancha (su posición en la lista de sedes del torneo); sin sedes, todas son la misma */
export function courtVenueIndex(t, court) {
  let offset = 0;
  const venues = t?.venues || [];
  for (let i = 0; i < venues.length; i++) {
    if (court <= offset + venues[i].courts) return i;
    offset += venues[i].courts;
  }
  return 0;
}

/* ¿Se puede jugar en esa cancha un partido que arranca a esa hora (minutos) ese día? */
export function courtIsOpen(t, court, date, minutes, duration = durationOf(t)) {
  const venue = (t?.venues || [])[courtVenueIndex(t, court)];
  if (!venue?.days) return true;
  const d = venue.days.find((x) => x.date === date);
  return !!d && minutes >= toMin(d.from) && minutes + duration <= toMin(d.to);
}

/* Turnos de la grilla ("fecha|hora|cancha") en que la cancha no se usa porque su sede no juega ese
   día o a esa hora: el armado automático y los avisos de lugar los toman como ocupados */
export function closedCourtSlots(t) {
  const closed = new Set();
  if (!(t?.venues || []).some((v) => v.days)) return closed;
  const duration = durationOf(t);
  (t.playDates || []).forEach((d) => dayTimes(d, duration).forEach((time) => {
    for (let c = 1; c <= (t.courtsCount || 4); c++) {
      if (!courtIsOpen(t, c, d.date, toMin(time), duration)) closed.add(`${d.date}|${time}|${c}`);
    }
  }));
  return closed;
}

/* Canchas que se muestran en la grilla de un día: las de las sedes que juegan ese día, más las que
   igual tienen algún partido (puesto antes de cambiar los días de la sede) */
export function courtsOfDay(t, date, scheduled = []) {
  const duration = durationOf(t);
  const day = (t.playDates || []).find((d) => d.date === date);
  const times = day ? dayTimes(day, duration) : [];
  return Array.from({ length: t.courtsCount || 4 }, (_, i) => i + 1).filter((c) =>
    times.some((time) => courtIsOpen(t, c, date, toMin(time), duration))
    || scheduled.some((m) => m.schedule?.date === date && m.schedule.court === c));
}

/* Partidos ubicados en una cancha cuya sede no se usa ese día o a esa hora */
export function matchesAtClosedCourts(t, scheduled) {
  return scheduled.filter((m) => m.schedule && !courtIsOpen(t, m.schedule.court, m.schedule.date, toMin(m.schedule.time)));
}
