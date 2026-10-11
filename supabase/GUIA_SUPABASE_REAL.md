# Guía: reservas de canchas en el Supabase REAL

Pasos para llevar al proyecto **real** ("Smash Point", `cfaapvyttzedackbmkpt`) todo lo que se probó en
`smash-point-prueba`: reservas, login de jugadores con código, colaboradores con permisos, buscador y
política de privacidad.

**Cuándo:** entre el **16 y el 22/10/2026**, cuando vuelvan los créditos de Netlify y antes de los
torneos del 23–25/10. Ideal: un día sin torneo en juego.

**Tiempo estimado:** unos 30–40 minutos (más lo que tarde verificar el dominio, si se usa uno).

---

## Antes de empezar

- [ ] Estar en el proyecto **real**: arriba a la izquierda tiene que decir **Smash Point**, no
      `smash-point-prueba`. Revisarlo **antes de cada Run**.
- [ ] Tener decidido el envío de mails (ver Paso 5): **dominio propio con Resend** o **Brevo con el Gmail**.
- [ ] No hace falta frenar el sitio: las migraciones son compatibles con la versión publicada hoy.
      Los organizadores pueden seguir usándolo mientras se hacen los pasos 1 a 4.
- [ ] **No correr en el real los scripts de `supabase/pruebas/`.** Usan las cuentas de prueba
      (`organizador-prueba`), que en el real no existen.

---

## Paso 1 — Reservas: canchas y agenda

SQL Editor → pegar todo [`migrations/20261014_reservas_canchas.sql`](migrations/20261014_reservas_canchas.sql) → **Run**.

- [ ] Tiene que decir **Success. No rows returned**.

## Paso 2 — Jugadores y cierre de permisos

Pegar todo [`migrations/20261015_reservas_jugadores.sql`](migrations/20261015_reservas_jugadores.sql) → **Run**.

- [ ] **Success**. Puede aparecer el aviso de "destructive operations" (borra y vuelve a crear la
      política de imágenes): confirmarlo.
- [ ] En la pestaña de mensajes puede aparecer `Se borra la política de storage: …` con el nombre de
      la política vieja de imágenes. Es lo esperado.

> **Importante:** este paso es el que hace que una cuenta de jugador **no** pueda crear torneos,
> eventos ni subir imágenes. Tiene que estar hecho **antes** del Paso 6 (abrir las altas de usuarios).

## Paso 3 — Colaboradores

Pegar todo [`migrations/20261016_reservas_colaboradores.sql`](migrations/20261016_reservas_colaboradores.sql) → **Run**.

- [ ] **Success**.

## Paso 4 — Permisos por colaborador

Pegar todo [`migrations/20261017_colaboradores_permisos.sql`](migrations/20261017_colaboradores_permisos.sql) → **Run**.

- [ ] **Success** (confirmar el aviso de "destructive operations" si aparece).

## Paso 4b — Cobros de inscripciones y cajas

Pegar todo [`migrations/20261018_cobros_inscripciones.sql`](migrations/20261018_cobros_inscripciones.sql) → **Run** → **Success**.
Después, todo [`migrations/20261019_caja.sql`](migrations/20261019_caja.sql) → **Run** → **Success**.
Y por último [`migrations/20261020_caja_plataforma.sql`](migrations/20261020_caja_plataforma.sql) (la caja de Smash Point, solo para el creador) → **Run** → **Success**.
Y [`migrations/20261021_consumos.sql`](migrations/20261021_consumos.sql) (consumos, cuentas y stock) → **Run** → **Success**.

### Verificación (solo lectura, no cambia nada)

```sql
select
  to_regclass('public.complejos') is not null as complejos,
  to_regclass('public.canchas') is not null as canchas,
  to_regclass('public.reservas') is not null as reservas,
  to_regclass('public.jugadores') is not null as jugadores,
  to_regclass('public.colaboradores') is not null as colaboradores,
  to_regclass('public.pagos_inscripcion') is not null as pagos,
  to_regclass('public.caja_movimientos') is not null as caja,
  to_regclass('public.plataforma_movimientos') is not null as caja_plataforma,
  to_regclass('public.cuenta_consumos') is not null as consumos,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('pedir_turno', 'disponibilidad_canchas', 'cancelar_mi_reserva', 'vencer_pedidos',
     'es_organizador', 'es_colaborador', 'colaborador_permiso', 'colaborador_de',
     'mis_complejos_colaborador', 'puede_subir_imagenes')) as funciones,
  (select string_agg(policyname, ', ') from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'INSERT') as subir_imagenes;
```

- [ ] Las nueve primeras columnas en `true`, **funciones = 10**.
- [ ] `subir_imagenes` dice **solo** `Solo organizadores suben imagenes`. Si aparece otra política,
      avisar antes de seguir.

### Control rápido del sitio publicado (todavía la versión vieja)

- [ ] Entrar al sitio publicado como organizador, abrir un torneo y cargar/borrar un resultado de
      prueba en un partido: tiene que guardarse como siempre.

---

## Paso 5 — Envío de mails (código de entrada)

Sin esto, los jugadores y los empleados **no reciben el código** (el servicio de Supabase solo manda
a los mails del equipo y unos pocos por hora).

**Opción A — Resend con dominio propio** (por ejemplo `smashpoint.com.ar`):
1. Resend → **Domains** → **Add domain** → cargar en el proveedor del dominio los registros que
   muestra Resend → esperar a que diga **Verified**.
2. Resend → **API Keys** → crear una clave con *Sending access* (copiarla con el botón).
3. Supabase real → **Authentication → Emails → SMTP Settings** → activar *Custom SMTP*:
   - Sender email: `reservas@` + el dominio (o el que elijas)
   - Sender name: `Smash Point`
   - Host: `smtp.resend.com` · Port: `465` · Username: `resend` · Password: la clave
   - **Save changes**

**Opción B — Brevo con el Gmail** (sin dominio):
1. Brevo → **Senders** → agregar y verificar `smashpoint.arg@gmail.com`.
2. Brevo → **SMTP & API → SMTP** → generar una *SMTP key*; anotar el *login*.
3. Supabase real → **SMTP Settings** → Custom SMTP:
   - Sender email: `smashpoint.arg@gmail.com` · Sender name: `Smash Point`
   - Host: `smtp-relay.brevo.com` · Port: `587` · Username: el *login* · Password: la SMTP key
   - **Save changes**
4. Si se usa Brevo, avisar para cambiar "Resend" por "Brevo" en la política de privacidad.

**Plantillas** (Authentication → Emails → Templates), en **"Magic link or OTP"** y en **"Confirm sign up"**:

- Asunto: `Tu código para Smash Point`
- Cuerpo:

```html
<h2>Tu código para Smash Point</h2>
<p>Escribí este código en la app para entrar:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Vence en 1 hora. Si no lo pediste, ignorá este mail.</p>
```

- [ ] Las dos plantillas guardadas.
- [ ] **No tocar** la plantilla "Reset password": la usan los organizadores para recuperar su contraseña.

## Paso 6 — Altas de usuarios (recién después del Paso 2)

Authentication → **Sign In / Providers**:

- [ ] **Allow new users to sign up**: activado (los jugadores y empleados crean su cuenta con el código).
- [ ] **Confirm email**: activado.
- [ ] Authentication → **Rate Limits**: con SMTP propio el límite de mails sube a 30 por hora. Si se
      espera más movimiento (por ejemplo, el día que se anuncie), subirlo.

---

## Paso 7 — Publicar la app (lo hace Claude)

- Unir las ramas `reservas-etapa1` … `reservas-etapa4` en una sola, abrir el PR y publicar en Netlify
  **una sola vez** (los créditos vuelven el 16/10).
- Después del deploy: completar los resúmenes de la portada que habían quedado pendientes
  (backfill de `resumen` en `torneos`).

## Paso 8 — Configuración inicial en el sitio publicado

1. Entrar como **creador** → **Complejos** → editar el complejo → **Dueño** = su organizador →
   tildar **Sección Reservas habilitada** → Guardar.
2. Entrar como ese **organizador** → **Reservas → Canchas y precios**: cargar canchas, horarios y
   precios por duración (destildar "Recibe reservas online" en las de clases).
3. **Perfil → Colaboradores**: agregar a los empleados y tildar sus permisos.

## Paso 9 — Prueba final en el sitio publicado

- [ ] **Jugador** (ventana de incógnito): Complejos → buscador → tocar un horario → código por mail →
      datos → **Pedir turno**.
- [ ] **Dueño**: el pedido aparece arriba de la agenda y "Reservas (1)" en la pestaña → **Confirmar** →
      "Avisarle por WhatsApp".
- [ ] **Jugador**: en "Mis reservas" figura **Confirmado**.
- [ ] **Empleado**: `…/#complejo` → código → ve solo lo que tiene permitido.
- [ ] Un torneo: cargar un resultado y verlo en la página pública.
- [ ] Cancelar o rechazar los turnos de prueba para que no queden en la agenda.

---

## Si algo sale mal

- **El sitio nuevo falla:** en Netlify → **Deploys** → elegir el deploy anterior → **Publish deploy**.
  Vuelve la versión de antes al instante. Las migraciones pueden quedar: la versión vieja funciona con
  ellas.
- **No llegan los códigos:** Supabase → **Logs → Auth** → buscar `/otp` con ERROR y abrir el detalle
  (por ejemplo, `535` = clave SMTP mal cargada; `550 … verify a domain` = falta verificar el dominio).
- **Un organizador no puede guardar:** revisar que su cuenta esté en la tabla `organizers` (las
  cuentas de jugadores no pueden crear torneos a propósito).
