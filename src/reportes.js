/* Reportes del complejo: ocupación de las canchas por día y horario, y totales mes a mes. */
import { horarioCancha, minutoEnGrilla, sumarDias } from "./reservas.js";

/* Días de un mes ("2026-10") */
export function diasDelMes(mes) {
  const dias = [];
  for (let f = `${mes}-01`; f.slice(0, 7) === mes; f = sumarDias(f, 1)) dias.push(f);
  return dias;
}
const diaSemana = (fecha) => new Date(`${fecha}T12:00:00Z`).getUTCDay(); // 0 = domingo

/* Ocupación del mes: por cancha (horas abiertas y horas con turno) y un mapa día de la semana ×
   hora con el % ocupado. Cuentan los turnos confirmados (también "no vino": la cancha estuvo tomada).
   reservas: [{ tipo, estado, cancha_id, fecha, inicio, fin }] */
export function ocupacionMes({ canchas, reservas, mes }) {
  const dias = diasDelMes(mes);
  const mapa = {}; // dow -> hora -> { abierto, ocupado } (minutos)
  const celda = (dow, h) => {
    mapa[dow] = mapa[dow] || {};
    mapa[dow][h] = mapa[dow][h] || { abierto: 0, ocupado: 0 };
    return mapa[dow][h];
  };
  // Minutos de [a, b) que caen en cada hora
  const repartir = (a, b, fn) => {
    for (let h = Math.floor(a / 60); h * 60 < b; h++) {
      const m = Math.min(b, (h + 1) * 60) - Math.max(a, h * 60);
      if (m > 0) fn(h, m);
    }
  };
  const porCancha = canchas.map((c) => {
    const { desde, hasta } = horarioCancha(c);
    let abierto = 0;
    let ocupado = 0;
    const turnos = reservas.filter((r) => r.cancha_id === c.id && (r.tipo || "turno") !== "bloqueo" && r.estado === "confirmada");
    for (const f of dias) {
      const dow = diaSemana(f);
      repartir(desde, hasta, (h, m) => { celda(dow, h).abierto += m; abierto += m; });
      for (const r of turnos.filter((x) => x.fecha === f)) {
        const a = Math.max(desde, minutoEnGrilla(f, r.inicio));
        const b = Math.min(hasta, minutoEnGrilla(f, r.fin));
        if (b <= a) continue;
        repartir(a, b, (h, m) => { celda(dow, h).ocupado += m; ocupado += m; });
      }
    }
    return { id: c.id, nombre: c.nombre, horasAbiertas: abierto / 60, horasOcupadas: ocupado / 60, pct: abierto ? Math.round((ocupado / abierto) * 100) : 0 };
  });
  const horas = [...new Set(Object.values(mapa).flatMap((x) => Object.keys(x).map(Number)))].sort((a, b) => a - b);
  const pct = (dow, h) => {
    const x = mapa[dow]?.[h];
    return x && x.abierto ? Math.round((x.ocupado / x.abierto) * 100) : null;
  };
  const total = porCancha.reduce((s, c) => ({ a: s.a + c.horasAbiertas, o: s.o + c.horasOcupadas }), { a: 0, o: 0 });
  return { porCancha, horas, pct, pctTotal: total.a ? Math.round((total.o / total.a) * 100) : 0, horasOcupadas: total.o };
}

/* Suma montos por mes ("2026-10"). filas: [{ fecha: "2026-10-05", monto }] */
export function sumarPorMes(filas) {
  const out = {};
  for (const f of filas) {
    const m = String(f.fecha).slice(0, 7);
    out[m] = (out[m] || 0) + Number(f.monto || 0);
  }
  return out;
}

/* Productos vendidos: cantidad, facturado y ganancia (si hay costo), de mayor a menor facturación.
   items: [{ descripcion, cantidad, precio_unitario, costo_unitario? }] */
export function rankingProductos(items) {
  const mapa = new Map();
  for (const i of items) {
    // Los talles de un mismo producto van juntos (la descripción de la venta termina con el talle)
    const k = i.producto_id || i.descripcion;
    const nombre = i.talle && i.descripcion.endsWith(` ${i.talle}`) ? i.descripcion.slice(0, -(i.talle.length + 1)) : i.descripcion;
    if (!mapa.has(k)) mapa.set(k, { descripcion: nombre, cantidad: 0, facturado: 0, ganancia: 0, conCosto: false });
    const x = mapa.get(k);
    x.cantidad += i.cantidad;
    x.facturado += i.cantidad * Number(i.precio_unitario);
    if (i.costo_unitario != null) { x.ganancia += i.cantidad * (Number(i.precio_unitario) - Number(i.costo_unitario)); x.conCosto = true; }
  }
  return [...mapa.values()].sort((a, b) => b.facturado - a.facturado);
}
