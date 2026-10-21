-- Avisos (la campanita): una bandeja en la base donde cada evento que entra por la app anota su
-- aviso EN EL MISMO MOMENTO (trigger en la misma transacción), así nunca se pierde. La app la muestra
-- en la campanita y, más adelante, la misma bandeja manda las notificaciones al celular.
--
-- Regla del usuario: solo lo que entra por la app genera avisos (lo cargado a mano, no).
-- - Al dueño del complejo y a sus empleados con agenda: pedido de turno online, cancelación del jugador.
-- - Al organizador y a sus empleados con torneos: inscripción online nueva.
-- - Al jugador con cuenta: turno confirmado, rechazado, vencido o cancelado por el complejo;
--   inscripción aceptada o rechazada (a la cuenta con alguno de los teléfonos de la inscripción);
--   recordatorio 2 horas antes del turno (tarea programada cada 10 minutos con pg_cron).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261041.

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  tipo text not null,
  titulo text not null,
  texto text not null default '',
  destino jsonb not null default '{}'::jsonb, -- adónde lleva al tocarlo: {"ir": "agenda" | "torneo" | "mis-reservas" | "torneo-publico", ...}
  ref text not null default '',               -- lo que lo originó (para no repetir el mismo aviso)
  creada_at timestamptz not null default now(),
  leida_at timestamptz,
  unique (usuario_id, tipo, ref)
);
create index if not exists notificaciones_por_usuario on public.notificaciones (usuario_id, creada_at desc);

alter table public.notificaciones enable row level security;
revoke all on public.notificaciones from public, anon, authenticated;
grant select on public.notificaciones to authenticated;
grant update (leida_at) on public.notificaciones to authenticated;
drop policy if exists "Cada uno ve sus avisos" on public.notificaciones;
create policy "Cada uno ve sus avisos" on public.notificaciones for select to authenticated using (usuario_id = auth.uid());
drop policy if exists "Cada uno marca sus avisos" on public.notificaciones;
create policy "Cada uno marca sus avisos" on public.notificaciones for update to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

-- ============================================================
-- Ayudas (uso interno)
-- ============================================================

-- "sábado 24/10 a las 20:00" (hora de Argentina)
create or replace function public._dia_hora(p timestamptz)
returns text
language sql
immutable
as $$
  select (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p at time zone 'America/Argentina/Buenos_Aires')::int + 1]
    || ' ' || to_char(p at time zone 'America/Argentina/Buenos_Aires', 'DD/MM')
    || ' a las ' || to_char(p at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI');
$$;

-- Las cuentas de los empleados de un complejo con un permiso (por mail o teléfono confirmados)
create or replace function public._empleados_con(p_complejo text, p_permiso text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id
    from colaboradores c
    join auth.users u on (u.email_confirmed_at is not null and lower(u.email) = c.email)
                      or (u.phone_confirmed_at is not null and u.phone = c.telefono)
   where c.complejo_id = p_complejo
     and public.funcion_activa('cuentas')
     and case p_permiso when 'agenda' then c.p_agenda when 'torneos' then c.p_torneos else false end;
$$;
revoke all on function public._empleados_con(text, text) from public, anon, authenticated;

-- Anota el mismo aviso para varias cuentas (sin repetir)
create or replace function public._avisar(p_usuarios uuid[], p_tipo text, p_titulo text, p_texto text, p_destino jsonb, p_ref text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into notificaciones (usuario_id, tipo, titulo, texto, destino, ref)
  select distinct u, p_tipo, p_titulo, coalesce(p_texto, ''), coalesce(p_destino, '{}'::jsonb), coalesce(p_ref, '')
    from unnest(p_usuarios) as u
   where u is not null and exists (select 1 from auth.users where id = u)
  on conflict (usuario_id, tipo, ref) do nothing;
$$;
revoke all on function public._avisar(uuid[], text, text, text, jsonb, text) from public, anon, authenticated;

-- ============================================================
-- Turnos
-- ============================================================

create or replace function public.avisos_reserva()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dueno uuid;
  v_complejo text;
  v_cancha text;
  v_cuando text;
  v_equipo uuid[];
  v_destino jsonb;
begin
  -- Si anotar el aviso falla, el turno o la inscripción se guardan igual (solo se pierde el aviso)
  begin
    if new.tipo <> 'turno' then return new; end if;
    select x.dueno_id, coalesce((select v->>'name' from app_data a, jsonb_array_elements(a.value) v where a.key = 'sp:venues' and v->>'id' = x.id), 'el complejo')
      into v_dueno, v_complejo
      from complejos x where x.id = new.complejo_id;
    select nombre into v_cancha from canchas where id = new.cancha_id;
    v_cuando := public._dia_hora(new.inicio);
    v_equipo := array_append(array(select public._empleados_con(new.complejo_id, 'agenda')), v_dueno);
    v_destino := jsonb_build_object('ir', 'agenda', 'complejo', new.complejo_id, 'fecha', new.fecha);

    if tg_op = 'INSERT' then
      if new.origen = 'online' and new.estado = 'pendiente' then
        perform public._avisar(v_equipo, 'turno_pedido', 'Nuevo pedido de turno',
          coalesce(new.nombre, 'Un jugador') || ' pidió ' || coalesce(v_cancha, 'una cancha') || ' el ' || v_cuando || '.', v_destino, new.id::text);
      end if;
      return new;
    end if;

    if old.estado is not distinct from new.estado then return new; end if;
    if new.jugador_id is not null and old.estado = 'pendiente' and new.estado = 'confirmada' then
      perform public._avisar(array[new.jugador_id], 'turno_confirmado', 'Turno confirmado',
        v_complejo || ' confirmó tu turno del ' || v_cuando || ' (' || coalesce(v_cancha, 'cancha') || ').', jsonb_build_object('ir', 'mis-reservas'), new.id::text);
    elsif new.jugador_id is not null and old.estado = 'pendiente' and new.estado = 'rechazada' then
      perform public._avisar(array[new.jugador_id], 'turno_rechazado', 'Turno no confirmado',
        v_complejo || ' no pudo darte el turno del ' || v_cuando || '. Probá con otro horario.', jsonb_build_object('ir', 'mis-reservas'), new.id::text);
    elsif new.jugador_id is not null and old.estado = 'pendiente' and new.estado = 'vencida' then
      perform public._avisar(array[new.jugador_id], 'turno_vencido', 'Tu pedido venció',
        v_complejo || ' no respondió tu pedido del ' || v_cuando || '. Probá con otro horario.', jsonb_build_object('ir', 'mis-reservas'), new.id::text);
    elsif new.estado = 'cancelada' and new.cancelada_por = 'complejo' and new.jugador_id is not null then
      perform public._avisar(array[new.jugador_id], 'turno_cancelado', 'El complejo canceló tu turno',
        v_complejo || ' canceló tu turno del ' || v_cuando || ' (' || coalesce(v_cancha, 'cancha') || ').', jsonb_build_object('ir', 'mis-reservas'), new.id::text);
    elsif new.estado = 'cancelada' and new.cancelada_por = 'jugador' and not new.cancelacion_silenciosa then
      perform public._avisar(v_equipo, 'turno_cancelado_jugador', 'Cancelaron un turno',
        coalesce(new.nombre, 'Un jugador') || ' canceló su turno del ' || v_cuando || ' (' || coalesce(v_cancha, 'cancha') || '). El horario quedó libre.', v_destino, new.id::text);
    end if;
    return new;
  exception when others then
    raise warning 'aviso no anotado: %', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists avisos_reserva on public.reservas;
create trigger avisos_reserva after insert or update of estado on public.reservas
  for each row execute function public.avisos_reserva();

-- ============================================================
-- Inscripciones a torneos
-- ============================================================

create or replace function public.avisos_inscripcion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_torneo text;
  v_categoria text;
  v_parejas text := case when new.jugador2_nombre is null then new.jugador1_nombre else new.jugador1_nombre || ' / ' || new.jugador2_nombre end;
  v_equipo uuid[];
  v_jugadores uuid[];
begin
  -- Si anotar el aviso falla, el turno o la inscripción se guardan igual (solo se pierde el aviso)
  begin
    select t.datos->>'name', (select c->>'name' from jsonb_array_elements(t.datos->'categories') c where c->>'id' = new.categoria_id)
      into v_torneo, v_categoria
      from torneos t where t.id = new.torneo_id;
    v_torneo := coalesce(v_torneo, 'tu torneo');

    if tg_op = 'INSERT' then
      v_equipo := array_append(array(
        select e from complejos x, public._empleados_con(x.id, 'torneos') e where x.dueno_id = new.organizador_id), new.organizador_id);
      perform public._avisar(v_equipo, 'inscripcion_nueva', 'Nueva inscripción',
        v_parejas || ' se anotó en ' || v_torneo || coalesce(' (' || v_categoria || ')', '') || '.',
        jsonb_build_object('ir', 'torneo', 'torneo', new.torneo_id, 'vista', 'inscripciones'), new.id::text);
      return new;
    end if;

    if old.estado is not distinct from new.estado or new.estado not in ('aceptada', 'rechazada') then return new; end if;
    -- A las cuentas con alguno de los teléfonos de la inscripción (teléfono confirmado)
    v_jugadores := array(select u.id from auth.users u
                          where u.phone_confirmed_at is not null
                            and u.phone in (new.telefono, new.telefono1, new.telefono2));
    if new.estado = 'aceptada' then
      perform public._avisar(v_jugadores, 'inscripcion_aceptada', 'Inscripción confirmada',
        'Ya estás en ' || v_torneo || coalesce(' (' || v_categoria || ')', '') || '. ¡Nos vemos en la cancha!',
        jsonb_build_object('ir', 'torneo-publico', 'torneo', new.torneo_id), new.id::text);
    else
      perform public._avisar(v_jugadores, 'inscripcion_rechazada', 'Inscripción no confirmada',
        'El organizador no pudo confirmar tu inscripción en ' || v_torneo || '. Cualquier consulta, escribile.',
        jsonb_build_object('ir', 'torneo-publico', 'torneo', new.torneo_id), new.id::text);
    end if;
    return new;
  exception when others then
    raise warning 'aviso no anotado: %', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists avisos_inscripcion on public.inscripciones;
create trigger avisos_inscripcion after insert or update of estado on public.inscripciones
  for each row execute function public.avisos_inscripcion();

-- ============================================================
-- Recordatorio 2 horas antes del turno (y limpieza de avisos viejos)
-- ============================================================

create or replace function public.avisar_recordatorios()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  if not public.funcion_activa('reservas') then return 0; end if;
  for r in
    select x.id, x.jugador_id, x.inicio, c.nombre as cancha,
           coalesce((select v->>'name' from app_data a, jsonb_array_elements(a.value) v where a.key = 'sp:venues' and v->>'id' = x.complejo_id), 'el complejo') as complejo
      from reservas x join canchas c on c.id = x.cancha_id
     where x.tipo = 'turno' and x.estado = 'confirmada' and x.jugador_id is not null
       and x.inicio > now() + interval '1 hour 45 minutes' and x.inicio <= now() + interval '2 hours 5 minutes'
  loop
    perform public._avisar(array[r.jugador_id], 'turno_recordatorio', 'Tu turno es en 2 horas',
      'Te esperan en ' || r.complejo || ' a las ' || to_char(r.inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') || ' (' || coalesce(r.cancha, 'cancha') || ').',
      jsonb_build_object('ir', 'mis-reservas'), r.id::text);
    n := n + 1;
  end loop;
  delete from notificaciones where creada_at < now() - interval '60 days';
  return n;
end;
$$;
revoke all on function public.avisar_recordatorios() from public, anon, authenticated;

-- Cada 10 minutos (pg_cron viene con Supabase; si ya estaba programada, se reemplaza)
create extension if not exists pg_cron;
select cron.schedule('smashpoint-recordatorios', '*/10 * * * *', 'select public.avisar_recordatorios()');

-- Vuelta atrás (si hiciera falta):
--   select cron.unschedule('smashpoint-recordatorios');
--   drop trigger if exists avisos_reserva on public.reservas;
--   drop trigger if exists avisos_inscripcion on public.inscripciones;
--   drop function if exists public.avisar_recordatorios(), public.avisos_inscripcion(), public.avisos_reserva(),
--     public._avisar(uuid[], text, text, text, jsonb, text), public._empleados_con(text, text), public._dia_hora(timestamptz);
--   drop table if exists public.notificaciones;
