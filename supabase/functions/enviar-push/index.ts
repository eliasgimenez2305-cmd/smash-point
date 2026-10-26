// Edge Function: enviar-push
// La llama la base (disparador push_aviso de 20261043_push.sql) cada vez que se anota un aviso en
// "notificaciones". Lee el aviso y los aparatos de esa cuenta y les manda la notificación push.
// Los aparatos que ya no existen (el navegador contesta 404 o 410) se borran.
//
// Secretos de la función (Supabase > Edge Functions > Secrets):
//   VAPID_PUBLICA, VAPID_PRIVADA: el par de claves de los avisos (la pública también va en la app,
//     como VITE_VAPID_PUBLICA).
//   PUSH_SECRETO: el mismo valor que el secreto "push_secreto" de Vault; sin él no se manda nada.
// Se publica con "Verify JWT" apagado (la llamada viene de la base, no de un usuario).

import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRETO = Deno.env.get("PUSH_SECRETO") || "";
const VAPID_PUBLICA = Deno.env.get("VAPID_PUBLICA") || "";
const VAPID_PRIVADA = Deno.env.get("VAPID_PRIVADA") || "";
if (VAPID_PUBLICA && VAPID_PRIVADA) webpush.setVapidDetails("mailto:eliasgimenez2305@gmail.com", VAPID_PUBLICA, VAPID_PRIVADA);

const base = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Solo POST." }, 405);
  if (!SECRETO || req.headers.get("x-push-secreto") !== SECRETO) return json({ error: "No autorizado." }, 401);
  if (!VAPID_PUBLICA || !VAPID_PRIVADA) return json({ error: "Faltan las claves VAPID." }, 500);

  try {
    const { id } = await req.json();
    if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return json({ error: "Falta el aviso." }, 400);

    const avisoRes = await fetch(`${SUPABASE_URL}/rest/v1/notificaciones?id=eq.${id}&select=id,usuario_id,titulo,texto`, { headers: base });
    const [aviso] = avisoRes.ok ? await avisoRes.json() : [];
    if (!aviso) return json({ error: "No existe el aviso." }, 404);

    const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/push_suscripciones?usuario_id=eq.${aviso.usuario_id}&select=id,endpoint,p256dh,auth`, { headers: base });
    const subs = subsRes.ok ? await subsRes.json() : [];

    // Al tocarla abre la app con ?aviso=<id>, y la campanita lleva adonde corresponde.
    const carga = JSON.stringify({ id: aviso.id, titulo: aviso.titulo, texto: aviso.texto, url: `/?aviso=${aviso.id}` });
    let enviadas = 0;
    const vencidas: string[] = [];
    await Promise.all(subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, carga, { TTL: 60 * 60 * 24 });
        enviadas++;
      } catch (e) {
        const codigo = (e as { statusCode?: number }).statusCode;
        if (codigo === 404 || codigo === 410) vencidas.push(s.id);
        else console.error("push falló", codigo, (e as Error).message);
      }
    }));

    if (vencidas.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/push_suscripciones?id=in.(${vencidas.join(",")})`, { method: "DELETE", headers: base });
    }
    return json({ enviadas, borradas: vencidas.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
