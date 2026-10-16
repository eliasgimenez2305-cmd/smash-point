# Guía: reservas de canchas en el Supabase REAL

Pasos para llevar al proyecto **real** ("Smash Point", `cfaapvyttzedackbmkpt`) todo lo que se probó en
`smash-point-prueba`: reservas, cuentas con mail y contraseña (jugadores, empleados y organizadores), colaboradores con permisos, buscador y
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
Y [`migrations/20261022_cobrar_todo.sql`](migrations/20261022_cobrar_todo.sql) (cobrar inscripción y consumos juntos) → **Run** → **Success**.
Y [`migrations/20261023_modulos_complejo.sql`](migrations/20261023_modulos_complejo.sql) (qué módulos usa cada complejo: Torneos, Reservas, Cantina) → **Run** → **Success**.
Y [`migrations/20261024_mostrador.sql`](migrations/20261024_mostrador.sql) (ventas del mostrador, rubros y costos) → **Run** → **Success**.
Y [`migrations/20261025_cierre_caja.sql`](migrations/20261025_cierre_caja.sql) (caja del día: abrir y cerrar con arqueo) → **Run** → **Success**.
Y [`migrations/20261026_compras_gastos_fijos.sql`](migrations/20261026_compras_gastos_fijos.sql) (compras a proveedores y gastos fijos) → **Run** → **Success**.
Y [`migrations/20261027_turnos_fijos.sql`](migrations/20261027_turnos_fijos.sql) (turnos fijos agrupados) → **Run** → **Success**.
Y [`migrations/20261028_clases.sql`](migrations/20261028_clases.sql) (clases con profes, alumnos y cuotas) → **Run** → **Success**.
Y [`migrations/20261029_cargar_a_turno.sql`](migrations/20261029_cargar_a_turno.sql) (mostrador: cargar consumos al turno de una cancha; débito y transferencia en turnos y cuentas) → **Run** → **Success**.
Y [`migrations/20261030_talles_codigo_rubros.sql`](migrations/20261030_talles_codigo_rubros.sql) (talles con stock propio, código de barras y categorías del mostrador) → **Run** → **Success**.
Y [`migrations/20261031_fichas_complejos.sql`](migrations/20261031_fichas_complejos.sql) (ficha pública de cada complejo: portada, fotos, canchas y servicios) → **Run** → **Success**.

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
  to_regclass('public.cuenta_jugadores') is not null as cobrar_todo,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'complejos' and column_name = 'modulo_cantina') as modulos,
  to_regclass('public.ventas') is not null as mostrador,
  to_regclass('public.caja_turnos') is not null as caja_del_dia,
  to_regclass('public.compras') is not null as compras,
  to_regclass('public.profes_complejo') is not null as clases,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('pedir_turno', 'disponibilidad_canchas', 'cancelar_mi_reserva', 'vencer_pedidos',
     'es_organizador', 'es_colaborador', 'colaborador_permiso', 'colaborador_de',
     'mis_complejos_colaborador', 'puede_subir_imagenes')) as funciones,
  (select string_agg(policyname, ', ') from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'INSERT') as subir_imagenes;
```

- [ ] Las quince primeras columnas en `true`, **funciones = 10**.
- [ ] `subir_imagenes` dice **solo** `Solo organizadores suben imagenes`. Si aparece otra política,
      avisar antes de seguir.

### Control rápido del sitio publicado (todavía la versión vieja)

- [ ] Entrar al sitio publicado como organizador, abrir un torneo y cargar/borrar un resultado de
      prueba en un partido: tiene que guardarse como siempre.

---

## Paso 5 — Envío de mails (confirmar cuenta y contraseña nueva)

Sin esto, los que se crean una cuenta **no reciben el mail para confirmarla** (ni el de "Olvidé mi contraseña") (el servicio de Supabase solo manda
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

**Plantillas** (Authentication → Emails → Templates). Cada persona entra con su mail y contraseña;
el mail solo se usa para confirmar la cuenta la primera vez y para elegir una contraseña nueva.

**"Confirm sign up"** · asunto: `Confirmá tu cuenta de Smash Point`

```html
<h2>¡Bienvenido a Smash Point!</h2>
<p>Tocá el botón para confirmar tu cuenta. Después entrás siempre con tu mail y tu contraseña.</p>
<p><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 20px;background:#9fe022;color:#14181f;font-weight:bold;text-decoration:none;border-radius:8px">Confirmar mi cuenta</a></p>
<p>Si no creaste una cuenta en Smash Point, ignorá este mail.</p>
```

**"Reset password"** · asunto: `Elegí tu contraseña de Smash Point`

```html
<h2>Elegí tu contraseña nueva</h2>
<p>Pediste cambiar la contraseña de tu cuenta de Smash Point (o crearte una, si antes entrabas con un código). Tocá el botón para elegirla:</p>
<p><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 20px;background:#9fe022;color:#14181f;font-weight:bold;text-decoration:none;border-radius:8px">Elegir contraseña</a></p>
<p>Si no lo pediste, ignorá este mail: tu contraseña sigue igual.</p>
```

- [ ] Las dos plantillas guardadas (la de "Magic link or OTP" ya no se usa).
- [ ] Authentication → **URL Configuration**: en **Site URL**, la dirección del sitio publicado; en
      **Redirect URLs**, agregar esa misma dirección con `/**` al final (por ejemplo
      `https://smashpoint.netlify.app/**`). Sin esto, los links de los mails no vuelven al sitio.

## Paso 6 — Altas de usuarios (recién después del Paso 2)

Authentication → **Sign In / Providers**:

- [ ] **Allow new users to sign up**: activado (cualquiera se crea su cuenta con mail y contraseña).
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

- [ ] **Jugador** (ventana de incógnito): Complejos → buscador → tocar un horario → Crear cuenta →
      confirmar con el link del mail → ingresar → datos → **Pedir turno**.
- [ ] **Dueño**: el pedido aparece arriba de la agenda y "Reservas (1)" en la pestaña → **Confirmar** →
      "Avisarle por WhatsApp".
- [ ] **Jugador**: en "Mis reservas" figura **Confirmado**.
- [ ] **Empleado**: con el mail que cargó el dueño: Ingresar (o Crear cuenta) → Mi cuenta → Panel del
      complejo → ve solo lo que tiene permitido. Con la misma cuenta puede reservar en otro complejo.
- [ ] Un torneo: cargar un resultado y verlo en la página pública.
- [ ] Cancelar o rechazar los turnos de prueba para que no queden en la agenda.

---

## Si algo sale mal

- **El sitio nuevo falla:** en Netlify → **Deploys** → elegir el deploy anterior → **Publish deploy**.
  Vuelve la versión de antes al instante. Las migraciones pueden quedar: la versión vieja funciona con
  ellas.
- **No llegan los mails:** Supabase → **Logs → Auth** → buscar `/signup` o `/recover` con ERROR y abrir el detalle
  (por ejemplo, `535` = clave SMTP mal cargada; `550 … verify a domain` = falta verificar el dominio).
- **Un organizador no puede guardar:** revisar que su cuenta esté en la tabla `organizers` (las
  cuentas de jugadores no pueden crear torneos a propósito).
