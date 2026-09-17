// Edge Function: admin-organizers
// Crea o borra cuentas de organizador de verdad (usuario de Auth + fila en la tabla
// "organizers"). Usa la service_role key, que solo existe acá adentro (nunca en el
// navegador), y primero valida que quien llama esté logueado como "creador".

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

      await fetch(`${SUPABASE_URL}/rest/v1/organizers?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      });
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      });

      return json({ success: true });
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
