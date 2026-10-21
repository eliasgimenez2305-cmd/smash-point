// Edge Function: enviar-mail
// La llama la base (20261044_mail_avisos.sql) para mandar dos clases de mail con Resend:
//   {tipo: "confirmar", usuario}: el link para confirmar el "mail para recibir avisos".
//   {tipo: "aviso", id}: un aviso de la campanita que quedó sin leer (pedido o cancelación de turno).
//
// Secretos de la función (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY: la clave de Resend.
//   PUSH_SECRETO: la misma que usa enviar-push (y el secreto "push_secreto" de Vault).
//   MAIL_REMITENTE (opcional): "Smash Point <avisos@dominio>"; sin dominio propio, Resend solo deja
//     mandar desde onboarding@resend.dev y solo al mail de la cuenta de Resend.
//   APP_URL (opcional): dirección de la app para los links (en PRUEBA, http://localhost:5173).
// Se publica con "Verify JWT" apagado (la llamada viene de la base, no de un usuario).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRETO = Deno.env.get("PUSH_SECRETO") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const REMITENTE = Deno.env.get("MAIL_REMITENTE") || "Smash Point <onboarding@resend.dev>";
const APP_URL = (Deno.env.get("APP_URL") || "https://celadon-pudding-9d22a7.netlify.app").replace(/\/+$/, "");

const base = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
const UUID = /^[0-9a-f-]{36}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function leer(tabla: string, filtro: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}?${filtro}`, { headers: base });
  return res.ok ? (await res.json())[0] : null;
}

const escapar = (s: string) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function plantilla(titulo: string, texto: string, boton: string, link: string, pie: string) {
  return `<!doctype html><html><body style="margin:0;background:#0b1c24;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1c24;padding:24px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#071319;border:1px solid #115e59;border-radius:12px">
<tr><td style="padding:24px">
<p style="margin:0 0 4px;color:#9fe022;font-size:13px;font-weight:bold;letter-spacing:1px">SMASH POINT</p>
<h1 style="margin:0 0 12px;color:#f1f5f9;font-size:20px">${escapar(titulo)}</h1>
<p style="margin:0 0 20px;color:#cbd5e1;font-size:15px;line-height:1.5">${escapar(texto)}</p>
<a href="${link}" style="display:inline-block;background:#9fe022;color:#0b1c24;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${escapar(boton)}</a>
<p style="margin:20px 0 0;color:#5eaaa8;font-size:12px;line-height:1.5">${escapar(pie)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

async function mandar(para: string, asunto: string, html: string, texto: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: REMITENTE, to: [para], subject: asunto, html, text: texto }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Solo POST." }, 405);
  if (!SECRETO || req.headers.get("x-push-secreto") !== SECRETO) return json({ error: "No autorizado." }, 401);
  if (!RESEND_API_KEY) return json({ error: "Falta RESEND_API_KEY." }, 500);

  try {
    const cuerpo = await req.json();

    if (cuerpo.tipo === "confirmar") {
      if (!UUID.test(String(cuerpo.usuario))) return json({ error: "Falta el usuario." }, 400);
      const m = await leer("mail_avisos", `usuario_id=eq.${cuerpo.usuario}&select=email,token`);
      if (!m?.token) return json({ error: "No hay mail para confirmar." }, 404);
      const link = `${APP_URL}/?confirmar_mail=${m.token}`;
      await mandar(m.email, "Confirmá tu mail de avisos de Smash Point",
        plantilla("Confirmá tu mail", "Tocá el botón para empezar a recibir en este mail los pedidos y cancelaciones de turnos que no veas en la app.", "Confirmar mail", link,
          "Si no fuiste vos, ignorá este mail. El link vence en 2 días."),
        `Confirmá tu mail de avisos de Smash Point: ${link}`);
      return json({ enviado: true });
    }

    if (cuerpo.tipo === "aviso") {
      if (!UUID.test(String(cuerpo.id))) return json({ error: "Falta el aviso." }, 400);
      const a = await leer("notificaciones", `id=eq.${cuerpo.id}&select=id,usuario_id,titulo,texto,leida_at`);
      if (!a) return json({ error: "No existe el aviso." }, 404);
      if (a.leida_at) return json({ enviado: false, motivo: "ya leído" });
      const m = await leer("mail_avisos", `usuario_id=eq.${a.usuario_id}&select=email,confirmado_at,pausado`);
      if (!m?.confirmado_at || m.pausado) return json({ enviado: false, motivo: "sin mail confirmado" });
      const link = `${APP_URL}/?aviso=${a.id}`;
      await mandar(m.email, a.titulo,
        plantilla(a.titulo, a.texto, "Abrir en Smash Point", link,
          "Te llega porque este aviso lleva 15 minutos sin leer en la app. Podés pausar estos mails desde la campanita."),
        `${a.titulo}\n${a.texto}\n\nAbrir en Smash Point: ${link}`);
      return json({ enviado: true });
    }

    return json({ error: "Tipo no reconocido." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
