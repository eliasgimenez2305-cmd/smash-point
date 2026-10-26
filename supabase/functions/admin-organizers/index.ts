// Edge Function: admin-organizers
// Crea o borra cuentas de organizador de verdad (usuario de Auth + fila en la tabla
// "organizers"), y le muestra/cambia al creador el mail de entrada y la contraseña de cada uno.
// Usa la service_role key, que solo existe acá adentro (nunca en el navegador), y primero
// valida que quien llama esté logueado como "creador".

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer /i, "");
    if (!token) return json({ error: "Falta autenticación." }, 401);

    // 1. Averiguar quién llama, validando su token contra Auth.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: "Sesión inválida." }, 401);
    const callerUser = await userRes.json();
    const callerId = callerUser.id;

    // 2. Verificar que sea el usuario "creador".
    const orgRes = await fetch(`${SUPABASE_URL}/rest/v1/organizers?id=eq.${callerId}&select=role`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    const orgRows = await orgRes.json();
    if (!orgRes.ok || !orgRows[0] || orgRows[0].role !== "creador") {
      return json({ error: "Solo el usuario creador puede administrar organizadores." }, 403);
    }

    const body = await req.json();

    if (body.action === "create") {
      const { email, password, username, name } = body;
      if (!email || !password || !username || !name) return json({ error: "Faltan datos." }, 400);

      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        return json({ error: created.msg || created.message || "No se pudo crear el usuario." }, 400);
      }

      const newId = created.id;
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/organizers`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ id: newId, username, name, role: "organizador", logo_url: "" }),
      });
      if (!insertRes.ok) {
        // Si no se pudo guardar el perfil, deshacemos la creación del usuario.
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newId}`, {
          method: "DELETE",
          headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        });
        return json({ error: "No se pudo crear el perfil del organizador (¿el usuario ya existe?)." }, 400);
      }

      return json({ organizer: { id: newId, username, name, role: "organizador", logoUrl: "" } });
    }

    if (body.action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "Falta el id." }, 400);
      if (id === callerId) return json({ error: "No podés borrar tu propia cuenta de creador." }, 400);

      const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/organizers?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      });
      if (!profileRes.ok) {
        const detail = await profileRes.text();
        return json({ error: `No se pudo borrar el perfil del organizador: ${detail}` }, 500);
      }

      const userDelRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      });
      if (!userDelRes.ok) {
        const detail = await userDelRes.text();
        return json({
          error: `Se borró el perfil pero no el usuario de Auth: ${detail}`,
        }, 500);
      }

      return json({ success: true });
    }

    // Mail de entrada de un organizador (para mostrarlo en el panel del creador)
    // y cambio de mail o contraseña (los mails de entrada pueden ser inventados: el
    // organizador no puede recuperar la clave solo, se la cambia el creador).
    if (body.action === "acceso" || body.action === "cambiar_acceso") {
      const { id } = body;
      if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return json({ error: "Falta el id." }, 400);
      const esOrg = await fetch(`${SUPABASE_URL}/rest/v1/organizers?id=eq.${id}&select=id`, {
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      });
      if (!esOrg.ok || !(await esOrg.json())[0]) return json({ error: "No es una cuenta de organizador." }, 404);

      if (body.action === "acceso") {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
          headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        });
        const u = await userRes.json();
        if (!userRes.ok) return json({ error: u.msg || u.message || "No se encontró la cuenta." }, 400);
        // Mail para recibir avisos (20261044_mail_avisos.sql), si lo cargó
        const mRes = await fetch(`${SUPABASE_URL}/rest/v1/mail_avisos?usuario_id=eq.${id}&select=email,confirmado_at,pausado`, {
          headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        });
        const m = mRes.ok ? (await mRes.json())[0] : null;
        const mailAvisos = m ? { email: m.email, confirmado: !!m.confirmado_at, pausado: !!m.pausado } : null;
        return json({ email: u.email || "", ultimoIngreso: u.last_sign_in_at || null, mailAvisos });
      }

      const cambios: Record<string, unknown> = {};
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "El mail no es válido." }, 400);
        cambios.email = email;
        cambios.email_confirm = true;
      }
      if (password) {
        if (password.length < 6) return json({ error: "La contraseña tiene que tener al menos 6 caracteres." }, 400);
        cambios.password = password;
      }
      if (!Object.keys(cambios).length) return json({ error: "No hay nada para cambiar." }, 400);
      const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "PUT",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(cambios),
      });
      const r = await upd.json();
      if (!upd.ok) {
        const msg = r.msg || r.message || "";
        if (/already|registered|exists/i.test(msg)) return json({ error: "Ese mail ya lo usa otra cuenta." }, 400);
        return json({ error: msg || "No se pudo cambiar." }, 400);
      }
      return json({ email: r.email || email });
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
