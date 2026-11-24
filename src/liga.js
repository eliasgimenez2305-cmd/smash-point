/* Liga por parejas + semis y final (formato "super8_liga"): las parejas juegan una fase de todos
   contra todos (o un fixture que se pega), una sola tabla, y los 4 primeros juegan semis 1° vs 4°
   y 2° vs 3°, el 3er puesto y la final. Sin React, para poder probarlo: ver liga.test.js. */

/* "MARÍA R - Alina" → "mariaralina": para reconocer el nombre de una pareja escrito de otra forma */
export function claveEquipo(nombre) {
  return String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* "10:00", "10.00", "10" → "10:00"; null si no es una hora */
export function leerHora(texto) {
  const m = String(texto || "").trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(?:hs?)?$/i);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] || 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/* Lee un fixture pegado: un partido por renglón, "ronda; cancha; hora; pareja A; pareja B"
   (separado por punto y coma, tabulación o barra |). Los renglones vacíos o que empiezan con #
   se saltean. parejas: [{ id, name }]. Devuelve
   { partidos: [{ ronda, cancha, hora, a, b, nombreA, nombreB }], errores: [texto], nuevas: [nombre] }
   donde a/b son ids de parejas existentes o null si el nombre no está (y va a "nuevas"). */
export function leerFixture(texto, parejas = []) {
  const porClave = new Map(parejas.map((p) => [claveEquipo(p.name), p.id]));
  const partidos = [];
  const errores = [];
  const nuevas = [];
  String(texto || "").split(/\r?\n/).forEach((linea, i) => {
    const l = linea.trim();
    if (!l || l.startsWith("#")) return;
    const partes = l.split(/\s*[;\t|]\s*/).map((x) => x.trim());
    const n = i + 1;
    if (partes.length !== 5) { errores.push(`Renglón ${n}: tiene que tener 5 datos (ronda; cancha; hora; pareja A; pareja B).`); return; }
    const [r, c, h, na, nb] = partes;
    const ronda = Number.parseInt(r, 10);
    const hora = leerHora(h);
    if (!Number.isInteger(ronda) || ronda < 1) { errores.push(`Renglón ${n}: la ronda "${r}" no es un número.`); return; }
    if (!c) { errores.push(`Renglón ${n}: falta la cancha.`); return; }
    if (!hora) { errores.push(`Renglón ${n}: la hora "${h}" no se entiende (ej: 10:20).`); return; }
    if (!na || !nb) { errores.push(`Renglón ${n}: faltan las parejas.`); return; }
    if (claveEquipo(na) === claveEquipo(nb)) { errores.push(`Renglón ${n}: la pareja juega contra sí misma.`); return; }
    const idDe = (nombre) => {
      const k = claveEquipo(nombre);
      if (porClave.has(k)) return porClave.get(k);
      if (!nuevas.some((x) => claveEquipo(x) === k)) nuevas.push(nombre);
      return null;
    };
    const cancha = /^\d+$/.test(c) ? `Cancha ${Number(c)}` : c;
    partidos.push({ ronda, cancha, hora, a: idDe(na), b: idDe(nb), nombreA: na, nombreB: nb });
  });
  return { partidos, errores, nuevas };
}

/* Controles de un fixture ya leído (con ids): quién juega dos veces a la misma hora, quién repite
   rival y cuántos partidos juega cada uno. Devuelve avisos en texto (no frenan la carga). */
export function revisarFixture(partidos, nombreDe = (id) => id) {
  const avisos = [];
  const misma = new Map();
  const cruces = new Map();
  const cuenta = new Map();
  partidos.forEach((p) => {
    [p.a, p.b].forEach((id) => {
      const k = `${p.hora}|${id}`;
      misma.set(k, (misma.get(k) || 0) + 1);
      cuenta.set(id, (cuenta.get(id) || 0) + 1);
    });
    const k = [p.a, p.b].sort().join("|");
    cruces.set(k, [...(cruces.get(k) || []), p.ronda]);
  });
  misma.forEach((v, k) => { if (v > 1) { const [hora, id] = k.split("|"); avisos.push(`${nombreDe(id)} juega ${v} partidos a las ${hora}.`); } });
  cruces.forEach((rondas, k) => { if (rondas.length > 1) { const [a, b] = k.split("|"); avisos.push(`${nombreDe(a)} vs ${nombreDe(b)} se repite (rondas ${rondas.join(" y ")}).`); } });
  const cantidades = [...new Set(cuenta.values())];
  if (cantidades.length > 1) {
    const max = Math.max(...cantidades);
    cuenta.forEach((v, id) => { if (v !== max) avisos.push(`${nombreDe(id)} juega ${v} partidos (otros juegan ${max}).`); });
  }
  return avisos;
}

/* Todos contra todos por el método del círculo; con cantidad impar, una pareja descansa por ronda.
   Devuelve [{ ronda, a, b }]. */
export function todosContraTodos(ids) {
  const arr = ids.length % 2 ? [...ids, null] : [...ids];
  const n = arr.length;
  const out = [];
  let rot = arr;
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = rot[i], b = rot[n - 1 - i];
      if (a != null && b != null) out.push({ ronda: r + 1, a, b });
    }
    rot = [rot[0], rot[n - 1], ...rot.slice(1, n - 1)];
  }
  return out;
}

/* Las semis con los 4 primeros de la tabla (ids en orden): 1° vs 4° y 2° vs 3° */
export function armarSemis(primeros) {
  if (primeros.length < 4) return null;
  return [{ a: primeros[0], b: primeros[3] }, { a: primeros[1], b: primeros[2] }];
}

/* Quiénes juegan la final y el 3er puesto según las semis: ganador(semi) devuelve el id del
   ganador o null si no se jugó. Devuelve { final: [a, b], tercero: [a, b] } (null donde falta). */
export function cruceFinal(semis, ganador) {
  const g = semis.map((s) => ganador(s));
  const p = semis.map((s, i) => (g[i] == null ? null : g[i] === s.pairA ? s.pairB : s.pairA));
  return { final: [g[0] ?? null, g[1] ?? null], tercero: [p[0] ?? null, p[1] ?? null] };
}
