/* Horarios de las llaves de un torneo Clásico, armados "de atrás para adelante" como en los
   circuitos grandes: primero las finales de todas las categorías (a la hora y en la sede que eligió
   el organizador, o repartidas en la franja de cierre del último día de llaves), después todas las
   semis (antes y en la misma sede que su final), después todos los cuartos, y así, cada partido lo
   más tarde posible dejando a cada pareja un descanso entre partido y partido. Así cada categoría
   arranca cuando le hace falta: las que tienen más rondas, más temprano.

   - Descanso: entre el inicio de un partido de una pareja y el del siguiente pasan al menos `rest`
     minutos (también desde su último partido de grupos hasta su primer partido de llave). Como en la
     llave todavía no se sabe quién gana, se mira el camino: el partido que alimenta a otro.
   - "La llave arranca" (ownStart): la primera ronda de esa categoría va ese día, desde esa hora,
     lo antes posible; las rondas siguientes, en los días de llaves.
   - Partidos corridos de una pareja (sin un turno libre en el medio) van en la misma sede.
   - Los byes no llevan horario, y lo que ya tiene horario (puesto a mano) no se toca.

   Sin React, para poder probarlo: ver bracketSchedule.test.js. */

const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
// Minutos absolutos, para comparar horarios de días distintos
const absOf = (date, minutes) => Date.parse(`${date}T00:00:00Z`) / 60000 + minutes;

/* opts:
   categories: [{
     rounds: [[{ schedule: { date, time, court } | null, bye: bool }]] (ronda 0 = primera),
     finalPref: { time: "HH:MM" | null, venue: índice | null } | null,
     categoryStart: { date, minutes } | null, ownStart: { date, minutes } | null,
     entrants(i): horarios { date, time, court } de los partidos de grupos de quienes pueden llegar
       al partido i de la primera ronda
   }]
   days: [{ date, from, to, bracket: bool }] (bracket = día de llaves o "ambos")
   duration, courts, venueOf(court) -> índice de sede, busy: Set de "fecha|hora|cancha" ocupadas
   rest: minutos mínimos entre inicios de dos partidos de una pareja
   closingFrom: minutos desde los que arranca la franja de las finales en el último día de llaves
   otherFinals: [{ date, time, venue }] finales ya ubicadas de otras categorías
   Devuelve, por categoría, los horarios por ronda: [[{ date, time, court } | null]]. */
export function scheduleKnockouts(opts) {
  const { categories, duration, courts, venueOf, rest: restIn, closingFrom } = opts;
  const rest = Math.max(restIn || 0, duration);
  const busy = new Set(opts.busy);
  const finals = [...(opts.otherFinals || [])];
  const days = [...opts.days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const outs = categories.map((c) => c.rounds.map((round) => round.map((m) => (m.bye ? null : m.schedule || null))));
  if (days.length === 0) return outs;

  const slots = days.flatMap((d) => {
    const list = [];
    for (let t = toMin(d.from); t + duration <= toMin(d.to); t += duration) list.push({ date: d.date, minutes: t, abs: absOf(d.date, t), bracket: !!d.bracket });
    return list;
  });
  const bracketDays = days.filter((d) => d.bracket);
  const lastDay = bracketDays[bracketDays.length - 1];
  const at = (s) => ({ date: s.date, abs: absOf(s.date, toMin(s.time)), venue: venueOf(s.court) });
  const allCourts = Array.from({ length: courts }, (_, i) => i + 1);
  const venueCount = Math.max(1, ...allCourts.map((c) => venueOf(c) + 1));
  const allVenues = Array.from({ length: venueCount }, (_, v) => v);
  const courtsOfVenue = (v) => allCourts.filter((c) => venueOf(c) === v);
  const freeCourts = (slot, venue) => courtsOfVenue(venue).filter((c) => !busy.has(`${slot.date}|${toTime(slot.minutes)}|${c}`));
  const take = (slot, court) => { busy.add(`${slot.date}|${toTime(slot.minutes)}|${court}`); return { date: slot.date, time: toTime(slot.minutes), court }; };
  const prefer = (v) => (v == null ? allVenues : [v, ...allVenues.filter((x) => x !== v)]);
  // Dos partidos de una pareja corridos (sin un turno libre en el medio) van en la misma sede
  const corridoOk = (abs, venue, near) => near.every((e) => {
    const diff = Math.abs(abs - e.abs);
    return diff < duration || diff >= 2 * duration || e.venue === venue;
  });

  /* Herramientas de una categoría */
  const tools = categories.map((cat, ci) => {
    const { rounds, categoryStart, ownStart, entrants } = cat;
    const out = outs[ci];
    const last = rounds.length - 1;
    const groupNear = (ri, mi) => {
      if (ri === 0) return (entrants?.(mi) || []).map(at);
      if (ri === 1) return [2 * mi, 2 * mi + 1].flatMap((fi) => (rounds[0][fi]?.bye ? (entrants?.(fi) || []).map(at) : []));
      return [];
    };
    const childrenOf = (ri, mi) => (ri === 0 ? [] : [2 * mi, 2 * mi + 1].filter((fi) => rounds[ri - 1][fi] && !rounds[ri - 1][fi].bye));
    const parentOf = (ri, mi) => (ri < last ? Math.floor(mi / 2) : null);
    const nearOf = (ri, mi) => {
      const list = groupNear(ri, mi);
      childrenOf(ri, mi).forEach((fi) => { if (out[ri - 1][fi]) list.push(at(out[ri - 1][fi])); });
      const p = parentOf(ri, mi);
      if (p != null && out[ri + 1][p]) list.push(at(out[ri + 1][p]));
      return list;
    };
    // Pisos: inicio de la categoría, descanso desde los grupos de quienes llegan y desde los partidos
    // que lo alimentan (si ya tienen horario)
    const floorOf = (ri, mi) => {
      let f = categoryStart ? absOf(categoryStart.date, categoryStart.minutes) : -Infinity;
      groupNear(ri, mi).forEach((e) => { f = Math.max(f, e.abs + rest); });
      childrenOf(ri, mi).forEach((fi) => { if (out[ri - 1][fi]) f = Math.max(f, at(out[ri - 1][fi]).abs + rest); });
      return f;
    };
    // Techo: descanso hasta el partido siguiente (o hasta el techo de ese, si quedó sin horario)
    const deadline = rounds.map((r) => r.map(() => Infinity));
    const ceilingOf = (ri, mi) => {
      const p = parentOf(ri, mi);
      if (p == null) return Infinity;
      const pAbs = out[ri + 1][p] ? at(out[ri + 1][p]).abs : deadline[ri + 1][p];
      deadline[ri][mi] = pAbs - rest;
      return deadline[ri][mi];
    };
    const allowed = (slot, ri) => slot.bracket || (ri === 0 && ownStart && slot.date === ownStart.date && slot.minutes >= ownStart.minutes);
    return { cat, out, rounds, last, nearOf, floorOf, ceilingOf, parentOf, allowed };
  });

  /* Prueba los horarios en orden y, en cada uno, las sedes en orden de preferencia */
  const placeBySlot = (t, ri, mi, candidates, venues) => {
    const near = t.nearOf(ri, mi);
    for (const slot of candidates) {
      for (const v of venues) {
        if (!corridoOk(slot.abs, v, near)) continue;
        const free = freeCourts(slot, v);
        if (free.length > 0) return take(slot, free[0]);
      }
    }
    return null;
  };
  /* Prueba primero todas las horas en la sede preferida, después en las otras */
  const placeByVenue = (t, ri, mi, candidates, venues) => {
    for (const v of venues) {
      const r = placeBySlot(t, ri, mi, candidates, [v]);
      if (r) return r;
    }
    return null;
  };

  // 1) "La llave arranca": primera ronda hacia adelante, ese día
  tools.forEach((t) => {
    const { ownStart } = t.cat;
    if (!ownStart) return;
    t.rounds[0].forEach((m, mi) => {
      if (m.bye || t.out[0][mi]) return;
      const floor = t.floorOf(0, mi);
      const cands = slots.filter((s) => s.date === ownStart.date && s.minutes >= ownStart.minutes && s.abs >= floor);
      t.out[0][mi] = placeBySlot(t, 0, mi, cands, allVenues);
    });
  });

  // 2) De atrás para adelante, por etapas contadas desde la final y para todas las categorías a la
  //    vez: finales, semis, cuartos... Dentro de cada etapa, primero las que tienen más rondas.
  const maxStage = Math.max(0, ...tools.map((t) => t.last));
  const byDepth = [...tools].sort((a, b) => b.last - a.last);
  for (let stage = 0; stage <= maxStage; stage++) {
    const order = stage === 0
      ? [...tools.filter((t) => t.cat.finalPref?.time || t.cat.finalPref?.venue != null), ...byDepth.filter((t) => !(t.cat.finalPref?.time || t.cat.finalPref?.venue != null))]
      : byDepth;
    order.forEach((t) => {
      const ri = t.last - stage;
      if (ri < 0) return;
      t.rounds[ri].forEach((m, mi) => {
        const ceiling = t.ceilingOf(ri, mi);
        if (m.bye || t.out[ri][mi]) return;
        const floor = t.floorOf(ri, mi);
        const usable = slots.filter((s) => t.allowed(s, ri) && s.abs >= floor && s.abs <= ceiling);
        const latestFirst = [...usable].sort((a, b) => b.abs - a.abs);
        if (stage === 0) {
          t.out[ri][mi] = placeFinal(t, ri, usable, latestFirst);
          const f = t.out[ri][mi];
          if (f) finals.push({ date: f.date, time: f.time, venue: venueOf(f.court) });
        } else {
          const p = t.parentOf(ri, mi);
          const parent = p != null ? t.out[ri + 1][p] : null;
          const venues = prefer(parent ? venueOf(parent.court) : null);
          // Semis: en la sede de la final aunque haya que adelantarlas; el resto, mejor la sede del
          // partido siguiente si a esa hora hay lugar
          t.out[ri][mi] = stage === 1 ? placeByVenue(t, ri, mi, latestFirst, venues) : placeBySlot(t, ri, mi, latestFirst, venues);
        }
      });
    });
  }

  /* La final: a la hora y en la sede elegidas, o en la franja de cierre del último día de llaves,
     en la hora con menos finales (y, entre esas, la más tarde) y en una sede con lugar para jugar
     las dos semis juntas */
  function placeFinal(t, ri, usable, latestFirst) {
    const pref = t.cat.finalPref;
    const onLast = lastDay ? usable.filter((s) => s.date === lastDay.date) : [];
    const finalsAt = (s) => finals.filter((f) => f.date === s.date && toMin(f.time) === s.minutes).length;
    const finalsIn = (v) => finals.filter((f) => f.venue === v).length;
    const autoVenues = [...allVenues].sort((a, b) => (courtsOfVenue(b).length >= 2) - (courtsOfVenue(a).length >= 2) || finalsIn(a) - finalsIn(b) || a - b);
    const venues = pref?.venue != null ? prefer(pref.venue) : autoVenues;
    if (pref?.time) {
      // La hora elegida; si está ocupada, la anterior más cercana de ese día; si no, la más tarde posible
      const wanted = toMin(pref.time);
      const cands = [...onLast.filter((s) => s.minutes <= wanted).sort((a, b) => b.abs - a.abs), ...latestFirst];
      return placeByVenue(t, ri, 0, cands, venues);
    }
    const window = onLast.filter((s) => s.minutes >= closingFrom).sort((a, b) => finalsAt(a) - finalsAt(b) || b.abs - a.abs);
    return placeBySlot(t, ri, 0, [...window, ...latestFirst], venues);
  }

  return outs;
}

/* Una sola categoría (al armar o rearmar su llave): las demás ya están en busy y otherFinals */
export function scheduleKnockout(opts) {
  const { rounds, finalPref, categoryStart, ownStart, entrants, ...rest } = opts;
  return scheduleKnockouts({ ...rest, categories: [{ rounds, finalPref, categoryStart, ownStart, entrants }] })[0];
}
