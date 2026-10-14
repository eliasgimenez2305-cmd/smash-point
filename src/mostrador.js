/* Cuentas del mostrador (venta al contado de la cantina): total del ticket, descuento o recargo,
   pago con varios medios y vuelto. La base vuelve a calcular todo al vender (ver
   supabase/migrations/20261024_mostrador.sql); esto es lo que se muestra mientras se arma la venta. */

/* Rubros sugeridos, en este orden; después, los que haya cargado el complejo */
export const RUBROS_SUGERIDOS = ["Bebidas", "Comida", "Paletas", "Pelotas", "Accesorios", "Indumentaria"];

export function rubrosDe(productos) {
  const propios = [...new Set(productos.map((p) => (p.rubro || "").trim()).filter(Boolean))];
  const orden = (r) => {
    const i = RUBROS_SUGERIDOS.indexOf(r);
    return i === -1 ? RUBROS_SUGERIDOS.length : i;
  };
  return propios.sort((a, b) => orden(a) - orden(b) || a.localeCompare(b, "es"));
}

/* items: [{ precio, cantidad }] */
export function subtotalDe(items) {
  return items.reduce((s, i) => s + Number(i.precio) * Number(i.cantidad), 0);
}

/* Descuento (negativo) o recargo (positivo) en pesos enteros. valor en % o en $. Nunca más que el subtotal. */
export function ajusteDe(subtotal, { tipo = "descuento", modo = "%", valor = 0 } = {}) {
  const v = Math.max(0, Number(valor) || 0);
  const monto = Math.min(subtotal, Math.round(modo === "%" ? (subtotal * Math.min(v, 100)) / 100 : v));
  return monto === 0 ? 0 : tipo === "recargo" ? monto : -monto;
}

/* pagos: [{ medio, monto }] */
export function resumenPagos(total, pagos) {
  const pagado = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  return { pagado, falta: Math.max(0, total - pagado), sobra: Math.max(0, pagado - total) };
}

/* Vuelto si paga en efectivo con un billete más grande (null si no alcanza o no se escribió) */
export function vueltoDe(pagaCon, monto) {
  const p = Number(pagaCon);
  if (!p || p < monto) return null;
  return p - monto;
}

/* Clave del ticket: el producto, o el producto y su talle ("id|M") */
export const claveTicket = (productoId, talle = null) => (talle ? `${productoId}|${talle}` : productoId);
export function deClave(clave) {
  const i = clave.indexOf("|");
  return i === -1 ? { productoId: clave, talle: null } : { productoId: clave.slice(0, i), talle: clave.slice(i + 1) };
}

/* Lo que se manda a vender(): productos del catálogo (con su talle si tiene) y algo suelto */
export function itemsParaVender(carrito, sueltos) {
  return [
    ...Object.entries(carrito).filter(([, n]) => n > 0).map(([clave, cantidad]) => {
      const { productoId, talle } = deClave(clave);
      return talle ? { producto_id: productoId, talle, cantidad } : { producto_id: productoId, cantidad };
    }),
    ...sueltos.map((s) => ({ descripcion: s.descripcion.trim(), precio: Number(s.precio), cantidad: s.cantidad || 1 })),
  ];
}

/* Nombre para mostrar: si lo cargaron todo en mayúsculas ("AGUA X 500"), en formato normal
   ("Agua x 500"); si no, tal cual lo escribieron */
export function nombreLindo(nombre) {
  const s = String(nombre || "").trim();
  if (!/\p{L}/u.test(s) || s !== s.toLocaleUpperCase("es")) return s;
  const l = s.toLocaleLowerCase("es");
  return l.charAt(0).toLocaleUpperCase("es") + l.slice(1);
}

/* Stock mínimo de un producto: el que tenga cargado o 3 */
export const minimoStock = (p) => (p.aviso_stock == null ? 3 : Number(p.aviso_stock));

/* Estado del stock en la tarjeta, descontando lo que ya está en el ticket:
   cocina (no controla stock) | sin | poco | normal, con lo que queda */
export function estadoStock(p, enTicket = 0) {
  if (p.stock == null) return { estado: "cocina", quedan: null };
  const quedan = Number(p.stock) - enTicket;
  if (quedan <= 0) return { estado: "sin", quedan: 0 };
  return { estado: quedan <= minimoStock(p) ? "poco" : "normal", quedan };
}

/* Más vendidos: los productos ordenados por unidades vendidas (items: [{ producto_id, cantidad }]);
   los que no se vendieron quedan después, en su orden de siempre */
export function masVendidos(productos, items) {
  const vendidos = new Map();
  for (const i of items) if (i.producto_id) vendidos.set(i.producto_id, (vendidos.get(i.producto_id) || 0) + Number(i.cantidad));
  return productos.map((p, orden) => ({ p, n: vendidos.get(p.id) || 0, orden })).sort((a, b) => b.n - a.n || a.orden - b.orden).map((x) => x.p);
}

/* Talles de un producto (vienen adentro de cada producto), en su orden */
export const tallesDe = (p) => [...(p?.producto_talles || [])].sort((a, b) => a.orden - b.orden || a.talle.localeCompare(b.talle));

/* Producto (y talle) con ese código exacto, o null */
export function buscarPorCodigo(productos, codigo) {
  const c = String(codigo || "").trim();
  if (!c) return null;
  for (const p of productos) {
    if (p.codigo && p.codigo === c) return { p, talle: null };
    const t = (p.producto_talles || []).find((x) => x.codigo && x.codigo === c);
    if (t) return { p, talle: t.talle };
  }
  return null;
}

/* Talles sugeridos para indumentaria */
export const TALLES_SUGERIDOS = ["S", "M", "L", "XL"];
