/* Caja nueva: cuentas del libro de movimientos (ver supabase/migrations/20261045_caja_libro.sql).
   En la base los montos van en centavos; en pantalla, en pesos. */

export const TIPOS_MOVIMIENTO = {
  ingreso: "Ingreso",
  gasto: "Gasto",
  retiro_socio: "Retiro de socio",
  aporte_socio: "Aporte de socio",
  transferencia_interna: "Pase entre cuentas",
  ajuste: "Ajuste",
};

export const ORIGENES_LIBRO = {
  inscripcion: "una inscripción",
  turno: "un turno",
  cuenta: "un cobro de cuenta",
  venta: "una venta del mostrador",
  caja_dia: "la caja del día",
  cuota_clase: "una cuota de clases",
  pago_profe: "un pago a profe",
  compra: "una compra",
};

/* Lo que escribe la persona ("12.500", "12500,50") → centavos; null si no es un monto válido */
export function aCentavos(texto) {
  const limpio = String(texto ?? "").trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!limpio) return null;
  const partes = limpio.split(",");
  if (partes.length > 2) return null;
  const enteros = partes[0].replace(/\./g, "");
  const decimales = (partes[1] ?? "").slice(0, 2).padEnd(2, "0");
  if (!/^\d+$/.test(enteros) || !/^\d{2}$/.test(decimales)) return null;
  const c = Number(enteros) * 100 + Number(decimales);
  return c > 0 ? c : null;
}

/* Centavos → "12500" o "12500,5" para volver a mostrar en un campo */
export function centavosATexto(c) {
  if (c == null) return "";
  const pesos = Math.trunc(c / 100);
  const resto = Math.abs(c % 100);
  return resto ? `${pesos},${String(resto).padStart(2, "0").replace(/0$/, "")}` : String(pesos);
}

/* Lo que mueve un movimiento en el resultado (ingresos − gastos): los ajustes, pases, retiros y
   aportes no son ingreso ni gasto */
export function esResultado(m) {
  return m.tipo === "ingreso" || m.tipo === "gasto";
}

/* Resumen de los movimientos vigentes: ingresos, gastos, retiros, aportes y ajustes, y
   lo que suma cada categoría (en centavos) */
export function resumenLibro(movimientos) {
  const r = { ingresos: 0, gastos: 0, retiros: 0, aportes: 0, ajustes: 0, porCategoria: { ingreso: {}, gasto: {} } };
  for (const m of movimientos) {
    if (m.anulado_at) continue;
    const monto = Number(m.monto);
    if (m.tipo === "ingreso" || m.tipo === "gasto") {
      if (m.tipo === "ingreso") r.ingresos += monto; else r.gastos += monto;
      const k = m.categoria_id || "sin";
      r.porCategoria[m.tipo][k] = (r.porCategoria[m.tipo][k] || 0) + monto;
    } else if (m.tipo === "retiro_socio") r.retiros += monto;
    else if (m.tipo === "aporte_socio") r.aportes += monto;
    else if (m.tipo === "ajuste") r.ajustes += m.sentido * monto;
  }
  r.resultado = r.ingresos - r.gastos;
  return r;
}

/* Barras: [{ id, nombre, monto, pct }] ordenadas de mayor a menor (pct sobre el mayor) */
export function barrasPorCategoria(porCategoria, categorias) {
  const nombre = (id) => categorias.find((c) => c.id === id)?.nombre || "Sin categoría";
  const filas = Object.entries(porCategoria).map(([id, monto]) => ({ id, nombre: nombre(id), monto }));
  filas.sort((a, b) => b.monto - a.monto);
  const mayor = filas[0]?.monto || 1;
  return filas.map((f) => ({ ...f, pct: Math.round((f.monto / mayor) * 100) }));
}

/* Efecto de un movimiento sobre una cuenta (+ entra, − sale; 0 si no la toca) */
export function efectoEnCuenta(m, cuentaId) {
  if (m.anulado_at) return 0;
  let e = 0;
  if (m.cuenta_id === cuentaId) e += m.sentido * Number(m.monto);
  if (m.tipo === "transferencia_interna" && m.cuenta_destino_id === cuentaId) e += Number(m.monto);
  return e;
}

/* Signo con el que se muestra un movimiento en la lista: + entra, − sale, 0 pase entre cuentas */
export function signoMovimiento(m) {
  if (m.tipo === "transferencia_interna") return 0;
  return m.sentido;
}

/* Filtros de la lista. f: { buscar, tipo, cuenta, categoria, complejo, quien, verAnulados }, yo: id del dueño */
export function filtrarMovimientos(movimientos, f, yo) {
  const texto = (f.buscar || "").trim().toLowerCase();
  return movimientos.filter((m) => {
    if (m.anulado_at && !f.verAnulados) return false;
    if (f.tipo && m.tipo !== f.tipo) return false;
    if (f.cuenta && m.cuenta_id !== f.cuenta && m.cuenta_destino_id !== f.cuenta) return false;
    if (f.categoria && m.categoria_id !== f.categoria) return false;
    if (f.complejo && m.complejo_id !== f.complejo) return false;
    if (f.quien === "yo" && m.cargado_por !== yo) return false;
    if (f.quien === "otros" && m.cargado_por === yo) return false;
    if (texto && !String(m.concepto || "").toLowerCase().includes(texto)) return false;
    return true;
  });
}

/* Pago dividido: separa "monto" de los pagos [{ medio, monto }] (tomando en orden) y devuelve
   { parte, resto }, cada uno una lista de pagos. Sirve para pagar primero los productos del ticket y
   con lo que queda la inscripción. */
export function separarPagos(pagos, monto) {
  let falta = Math.max(0, Number(monto) || 0);
  const parte = [];
  const resto = [];
  for (const p of pagos) {
    const m = Number(p.monto) || 0;
    if (m <= 0) continue;
    const toma = Math.min(falta, m);
    if (toma > 0) parte.push({ medio: p.medio, monto: toma });
    if (m - toma > 0) resto.push({ medio: p.medio, monto: m - toma });
    falta -= toma;
  }
  return { parte, resto };
}

/* ¿Algún medio alcanza solo para pagar "monto"? (la cancha de un turno se paga con un solo medio) */
export function unMedioAlcanza(pagos, monto) {
  return !(Number(monto) > 0) || pagos.some((p) => Number(p.monto) >= Number(monto));
}
