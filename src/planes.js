/* Planes de Smash Point: estado de cada cliente (organizador, complejo, publicidad…) según su modo,
   su vencimiento y lo que pagó. Ver supabase/migrations/20261033_planes.sql.

   cliente: { activo, suspendido, modo: "prueba" | "bonificado" | "pago", vence: "AAAA-MM-DD" | null,
              dias_gracia, pagado_hasta: "AAAA-MM" | null, desde: "AAAA-MM", cuota_mensual }
   - Prueba y Bonificado terminan en "vence" (Bonificado sin fecha = gratis para siempre).
   - Pago: está cubierto hasta el último día del último mes de cuota cobrado (pagado_hasta). Sin
     ningún cobro, hasta el día antes del mes en que empieza a pagar (desde).

   Sin React, para poder probarlo: ver planes.test.js. */

export const DIAS_AVISO = 7; // "Por vencer" desde una semana antes

const dia = (f) => Date.parse(`${f}T12:00:00Z`);
const diasEntre = (desde, hasta) => Math.round((dia(hasta) - dia(desde)) / 86400000);
const sumar = (f, n) => new Date(dia(f) + n * 86400000).toISOString().slice(0, 10);
// Último día del mes "AAAA-MM"
const finDeMes = (mes) => {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0, 12)).toISOString().slice(0, 10);
};

/* Hasta qué día está cubierto (null = sin fin) */
export function finDeCobertura(c) {
  if (c.modo === "prueba" || c.modo === "bonificado") return c.vence || null;
  if (c.pagado_hasta) return finDeMes(c.pagado_hasta);
  if (c.cuota_mensual == null) return null; // sin cuota: no vence (cobros sueltos)
  return c.desde ? sumar(`${c.desde}-01`, -1) : null;
}

/* { estado, fin, dias }: estado es al_dia | prueba | bonificado | por_vencer | en_gracia | vencido |
   suspendido | baja; dias = cuántos faltan para el fin (negativo = hace cuántos venció) */
export function estadoCliente(c, hoy) {
  if (c.activo === false) return { estado: "baja", fin: null, dias: null };
  if (c.suspendido) return { estado: "suspendido", fin: null, dias: null };
  const fin = finDeCobertura(c);
  const base = c.modo === "prueba" ? "prueba" : c.modo === "bonificado" ? "bonificado" : "al_dia";
  if (!fin) return { estado: base, fin: null, dias: null };
  const dias = diasEntre(hoy, fin);
  if (dias >= 0) return { estado: dias < DIAS_AVISO ? "por_vencer" : base, fin, dias };
  return { estado: -dias <= (c.dias_gracia ?? 7) ? "en_gracia" : "vencido", fin, dias };
}

/* Para mostrar: etiqueta y color de cada estado */
export const ESTADOS_PLAN = {
  al_dia: { label: "Al día", color: "#9fe022" },
  prueba: { label: "Prueba", color: "#22d3ee" },
  bonificado: { label: "Bonificado", color: "#a78bfa" },
  por_vencer: { label: "Por vencer", color: "#fbbf24" },
  en_gracia: { label: "En gracia", color: "#fb923c" },
  vencido: { label: "Vencido", color: "#f87171" },
  suspendido: { label: "Suspendido", color: "#94a3b8" },
  baja: { label: "De baja", color: "#64748b" },
};

/* Lo que incluye un plan, en una línea: "Torneos · Reservas · Cantina · Reportes · 2 empleados" */
export function incluyePlan(p) {
  if (!p) return "";
  const partes = [p.modulo_torneos && "Torneos", p.modulo_reservas && "Reservas", p.modulo_cantina && "Cantina", p.reportes && "Reportes"].filter(Boolean);
  if (p.para !== "publicidad" && (p.modulo_reservas || p.modulo_cantina)) partes.push(p.empleados == null ? "empleados sin tope" : `${p.empleados} empleado${p.empleados === 1 ? "" : "s"}`);
  return partes.join(" · ") || (p.para === "publicidad" ? "Publicidad en el sitio" : "Sin módulos");
}

/* ¿Se muestra una publicidad en la página pública? Activa, dentro de su vigencia (desde / hasta, si
   tiene) y sin el cliente vencido, suspendido o de baja (ocultas: los ids que devuelve
   publicidades_ocultas() en 20261035_publicidades.sql). Devuelve null si se muestra o el motivo. */
export function motivoPublicidadOculta(ad, hoy, ocultas = []) {
  if (ad.active === false) return "Desactivada";
  if (ad.desde && hoy < ad.desde) return `Empieza el ${ad.desde.slice(8, 10)}/${ad.desde.slice(5, 7)}`;
  if (ad.hasta && hoy > ad.hasta) return `Terminó el ${ad.hasta.slice(8, 10)}/${ad.hasta.slice(5, 7)}`;
  if (ocultas.includes(ad.id)) return "Cliente vencido o de baja";
  return null;
}
