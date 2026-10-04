/* Imagen del fixture para redes (historia de Instagram, 1080x1920) de un torneo clásico.
   Una imagen por sede y por día, con sus partidos ordenados por hora; si en un día hay más de
   ROWS_PER_PAGE partidos, se parte en varias (1/2, 2/2...). Se dibuja en un canvas en el
   navegador del organizador, sin librerías y sin guardar nada. */

export const FIXTURE_WIDTH = 1080;
export const FIXTURE_HEIGHT = 1920;
export const ROWS_PER_PAGE = 20;

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

const C = {
  bg: "#0a0e12",
  lime: "#9fe022",
  cyan: "#38bdf8",
  ink: "#f1f5f9",
  muted: "#94a3b8",
  rowA: "rgba(255,255,255,0.035)",
  rowB: "rgba(159,224,34,0.07)",
  line: "rgba(159,224,34,0.28)",
};
const DISPLAY = "'Archivo Black', sans-serif";
const BODY = "'Work Sans', sans-serif";

/* Sede de una cancha: las canchas de un torneo con sedes van numeradas de corrido (sede 1: 1 a 3,
   sede 2: 4 y 5...). Devuelve la sede y el número de cancha dentro de ella. */
function venueOfCourt(tournament, court) {
  let offset = 0;
  for (const v of tournament.venues || []) {
    if (court <= offset + v.courts) return { venue: v, court: court - offset };
    offset += v.courts;
  }
  return { venue: null, court };
}

export function fixtureDateLabel(date) {
  const d = new Date(date + "T00:00:00");
  return `${WEEKDAYS[d.getDay()]} ${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })}`;
}

/* Arma las páginas del fixture: una por sede y por día (partidas cada ROWS_PER_PAGE partidos).
   matches: lo que devuelve collectScheduleableMatches; complexes: la lista de Complejos (para el
   logo de cada sede). Quedan afuera los partidos sin horario y los de una llave sin publicar. */
export function fixturePages(tournament, matches, pairsById, complexes) {
  const byKey = new Map();
  const nameOf = (id) => pairsById[id]?.name || "A definir";
  matches
    .filter((m) => m.schedule && m.schedule.date && m.schedule.time && !m.draft)
    .forEach((m) => {
      const { venue, court } = venueOfCourt(tournament, m.schedule.court || 1);
      const venueKey = venue ? venue.id : "_";
      const key = `${venueKey}|${m.schedule.date}`;
      if (!byKey.has(key)) {
        const complex = venue?.complexId ? complexes.find((c) => c.id === venue.complexId) : null;
        byKey.set(key, {
          venueName: venue ? (complex?.name || venue.name) : (tournament.venue || ""),
          logoUrl: complex?.logoUrl || null,
          date: m.schedule.date,
          venueOrder: venue ? (tournament.venues || []).indexOf(venue) : 0,
          rows: [],
        });
      }
      const [phA, phB] = m.placeholder ? m.placeholder.split(" vs ") : [];
      byKey.get(key).rows.push({
        time: m.schedule.time,
        court,
        category: m.categoryName,
        stage: m.label,
        pairA: m.pairA ? nameOf(m.pairA) : (phA || "A definir"),
        pairB: m.pairB ? nameOf(m.pairB) : (phB || "A definir"),
      });
    });

  const groups = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.venueOrder - b.venueOrder);
  return groups.flatMap((g) => {
    const rows = [...g.rows].sort((a, b) => a.time.localeCompare(b.time) || a.court - b.court);
    const pages = Math.ceil(rows.length / ROWS_PER_PAGE);
    return Array.from({ length: pages }, (_, i) => ({
      venueName: g.venueName, logoUrl: g.logoUrl, date: g.date,
      page: i + 1, pages, rows: rows.slice(i * ROWS_PER_PAGE, (i + 1) * ROWS_PER_PAGE),
    }));
  });
}

/* Nombre de archivo: fixture-mono-padel-sabado-03-10.png (con -2 si hay más de una página) */
export function fixtureFileName(page) {
  const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `fixture-${slug(page.venueName || "torneo")}-${slug(fixtureDateLabel(page.date))}${page.pages > 1 ? `-${page.page}` : ""}.png`;
}

export function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = "anonymous"; // sin esto el canvas no se puede descargar
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* Texto que entra en el ancho: achica la letra hasta minSize y, si igual no entra, lo corta con … */
function fitText(ctx, text, x, y, maxWidth, size, minSize, family, weight = "") {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && s > minSize) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  let t = text;
  if (ctx.measureText(t).width > maxWidth) {
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    t += "…";
  }
  ctx.fillText(t, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Logo redondo con borde verde; sin logo, la inicial de la sede */
function drawLogo(ctx, img, cx, cy, r, fallbackText) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#081218";
  ctx.fill();
  ctx.clip();
  if (img) {
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = C.lime;
    ctx.font = `${Math.round(r)}px ${DISPLAY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((fallbackText || "?").trim().charAt(0).toUpperCase(), cx, cy + 4);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = C.lime;
  ctx.shadowColor = C.lime;
  ctx.shadowBlur = 24;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* Dibuja una página del fixture en el canvas (1080x1920). logo: imagen del complejo (o null);
   brandLogo: el logo de Smash Point para el pie. */
export function drawFixture(canvas, page, tournamentName, logo, brandLogo) {
  canvas.width = FIXTURE_WIDTH;
  canvas.height = FIXTURE_HEIGHT;
  const ctx = canvas.getContext("2d");
  const W = FIXTURE_WIDTH, H = FIXTURE_HEIGHT;

  // Fondo casi negro con resplandores verde y celeste
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(W * 0.85, 120, 700, "rgba(159,224,34,0.22)");
  glow(0, H * 0.75, 800, "rgba(56,189,248,0.12)");

  // Encabezado: logo del complejo, nombre de la sede, torneo y día
  const logoR = 120;
  drawLogo(ctx, logo, 60 + logoR, 70 + logoR, logoR, page.venueName || tournamentName);
  const tx = 60 + logoR * 2 + 44, tw = W - tx - 50;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.ink;
  fitText(ctx, (page.venueName || tournamentName).toUpperCase(), tx, 150, tw, 64, 34, DISPLAY);
  ctx.fillStyle = C.cyan;
  fitText(ctx, tournamentName, tx, 210, tw, 40, 24, BODY, "600");
  ctx.fillStyle = C.lime;
  fitText(ctx, `FIXTURE · ${fixtureDateLabel(page.date).toUpperCase()}${page.pages > 1 ? `  (${page.page}/${page.pages})` : ""}`, tx, 268, tw, 34, 22, DISPLAY);

  // Tabla
  const x0 = 36, tableW = W - x0 * 2;
  const cols = [
    { title: "CANCHA", w: 130 },
    { title: "CATEGORÍA", w: 270 },
    { title: "PARTIDO", w: tableW - 130 - 270 - 170 },
    { title: "HORA", w: 170 },
  ];
  const top = 360, headH = 64;
  const footerH = 120;
  const avail = H - (top + headH) - footerH - 20;
  const n = Math.max(page.rows.length, 1);
  // Con pocos partidos las filas y las letras crecen (hasta el doble) para llenar la historia; si
  // igual sobra lugar, la tabla queda centrada entre el encabezado y el pie
  const rowH = Math.min(140, Math.floor(avail / n));
  const k = Math.min(2, Math.max(1, rowH / 68));
  const fs = (size) => Math.round(size * k);
  const headY = top + Math.max(0, Math.floor((avail - rowH * n) / 2));

  roundRect(ctx, x0, headY, tableW, headH + rowH * page.rows.length, 22);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "rgba(159,224,34,0.9)";
  ctx.fillRect(x0, headY, tableW, headH);
  let cx = x0;
  ctx.fillStyle = "#0a0e12";
  ctx.textAlign = "center";
  cols.forEach((c) => {
    ctx.font = `23px ${DISPLAY}`;
    ctx.fillText(c.title, cx + c.w / 2, headY + 43);
    cx += c.w;
  });

  page.rows.forEach((r, i) => {
    const y = headY + headH + i * rowH;
    ctx.fillStyle = i % 2 === 0 ? C.rowA : C.rowB;
    ctx.fillRect(x0, y, tableW, rowH);
    ctx.fillStyle = C.line;
    ctx.fillRect(x0, y + rowH - 1, tableW, 1);
    const mid = y + rowH / 2;
    let x = x0;
    ctx.textAlign = "center";

    // Cancha
    ctx.fillStyle = C.lime;
    fitText(ctx, `C${r.court}`, x + cols[0].w / 2, mid + fs(11), cols[0].w - 16, fs(32), 20, DISPLAY);
    x += cols[0].w;

    // Categoría y grupo o ronda
    ctx.fillStyle = C.ink;
    fitText(ctx, r.category, x + cols[1].w / 2, mid - fs(4), cols[1].w - 20, fs(24), 15, BODY, "600");
    ctx.fillStyle = C.lime;
    fitText(ctx, r.stage || "", x + cols[1].w / 2, mid + fs(24), cols[1].w - 20, fs(22), 14, BODY, "700");
    x += cols[1].w;

    // Pareja VS pareja
    const pw = cols[2].w - 24, pc = x + cols[2].w / 2;
    // Tres líneas centradas en la fila: pareja, VS y pareja (líneas de base calculadas con el
    // tamaño de letra, así no se pisan ni tocan el borde de la fila)
    const nameSize = fs(20), vsSize = fs(15), gap = nameSize * 0.25;
    ctx.fillStyle = C.ink;
    fitText(ctx, r.pairA, pc, mid - vsSize / 2 - gap, pw, nameSize, 14, BODY, "600");
    ctx.fillStyle = C.lime;
    ctx.font = `${vsSize}px ${DISPLAY}`;
    ctx.fillText("VS", pc, mid + vsSize * 0.36);
    ctx.fillStyle = C.ink;
    fitText(ctx, r.pairB, pc, mid + vsSize / 2 + gap + nameSize * 0.72, pw, nameSize, 14, BODY, "600");
    x += cols[2].w;

    // Hora
    ctx.fillStyle = C.cyan;
    fitText(ctx, r.time, x + cols[3].w / 2, mid + fs(12), cols[3].w - 16, fs(34), 22, DISPLAY);

    // Separadores de columnas
    ctx.fillStyle = C.line;
    let sx = x0;
    cols.slice(0, -1).forEach((c) => { sx += c.w; ctx.fillRect(sx, y, 1, rowH); });
  });
  ctx.restore();
  roundRect(ctx, x0, headY, tableW, headH + rowH * page.rows.length, 22);
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.lime;
  ctx.stroke();

  // Pie: Smash Point
  const fy = H - footerH / 2 - 10;
  ctx.textAlign = "left";
  ctx.font = `30px ${DISPLAY}`;
  const label = "SMASH POINT";
  const lw = ctx.measureText(label).width;
  const size = 64, gap = 18;
  const startX = (W - (brandLogo ? size + gap : 0) - lw) / 2;
  if (brandLogo) ctx.drawImage(brandLogo, startX, fy - size / 2, size, size * (brandLogo.height / brandLogo.width));
  ctx.fillStyle = C.ink;
  ctx.fillText(label, startX + (brandLogo ? size + gap : 0), fy + 11);
}
