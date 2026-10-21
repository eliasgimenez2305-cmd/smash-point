/* Service worker de Smash Point: recibe las notificaciones push (ver supabase/functions/enviar-push)
   y, al tocarlas, abre la app (o la pestaña que ya estaba abierta). No guarda la página para usarla
   sin conexión: la app siempre se baja fresca. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let aviso = {};
  try { aviso = event.data ? event.data.json() : {}; } catch { aviso = { titulo: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(aviso.titulo || "Smash Point", {
    body: aviso.texto || "",
    icon: "/icono-192.png",
    badge: "/icono-192.png",
    tag: aviso.id || undefined,
    data: { url: aviso.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const misma = abiertas.find((c) => c.url.startsWith(self.location.origin));
    if (misma) {
      await misma.focus();
      const id = new URL(url).searchParams.get("aviso");
      if (id) misma.postMessage({ tipo: "aviso", id });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
