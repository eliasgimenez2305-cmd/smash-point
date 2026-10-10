-- Reserva de canchas, etapa 2: el jugador entra con un código que le llega por mail y pide turnos.
-- Necesita 20261014_reservas_canchas.sql.
--
-- 1. Permisos: hasta ahora solo había cuentas de organizadores, así que "estar logueado" alcanzaba
--    para crear torneos, eventos y circuitos a nombre propio, guardar una portada o subir imágenes.
--    Con el login de jugadores cualquiera puede tener una cuenta: todo eso pasa a pedir que la
--    cuenta sea de un organizador (o del creador).
-- 2. jugadores: el perfil del jugador (nombre, apellido, WhatsApp, fecha de nacimiento opcional).
--    El mail sale del login. Cada uno ve y edita solo el suyo.
-- 3. Pedido de turno (pedir_turno): solo por esta función, que controla todo (cancha con reserva
--    online, duración ofrecida, horario de la cancha, que no sea pasado ni a más de 30 días, que el
--    jugador no esté bloqueado por el complejo). Queda pendiente hasta que el complejo lo confirme;
--    si no lo confirma, vence a las 24 h o al empezar el turno, lo que pase primero.
-- 4. Disponibilidad pública (disponibilidad_canchas): solo los horarios ocupados, sin nombres.
-- 5. Cancelación del jugador (cancelar_mi_reserva): dentro de los 30 minutos de pedirlo, sin aviso
--    al complejo; después, hasta 24 h antes del turno, y el complejo lo ve como cancelación.
-- 6. jugadores_bloqueados: el complejo puede bloquear a un jugador para que no le pida más turnos.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

-- ============================================================
-- 1. Permisos: crear cosas a nombre propio solo si la cuenta es de un organizador
-- ============================================================

create or replace function public.es_organizador()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from organizers where id = auth.uid());
$$;

revoke all on function public.es_organizador() from public, anon;
grant execute on function public.es_organizador() to authenticated;

-- Igual que en 20261009_tabla_torneos.sql, con el control de organizador al principio
create or replace function public.guardar_torneo(p_torneo jsonb, p_rev int, p_resumen jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actual torneos%rowtype;
  v_yo text := auth.uid()::text;
  v_creador boolean := public.es_creador();
  v_rev int;
begin
  if v_yo is null or not public.es_organizador() then
    raise exception 'no_autorizado';
  end if;
  if jsonb_typeof(p_torneo) <> 'object' or coalesce(p_torneo->>'id', '') = '' then
    raise exception 'datos_invalidos';
  end if;

  select * into v_actual from torneos where id = p_torneo->>'id' for update;

  if not found then
    -- Torneo nuevo: a nombre de quien lo crea (salvo el creador)
    if not v_creador and p_torneo->>'organizerId' is distinct from v_yo then
      raise exception 'no_autorizado';
    end if;
    insert into torneos (id, organizador_id, datos, resumen, rev)
    values (
      p_torneo->>'id',
      case when coalesce(p_torneo->>'organizerId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_torneo->>'organizerId')::uuid end,
      p_torneo - 'rev', p_resumen, 1
    );
    v_rev := 1;
  else
    -- Torneo existente: solo su organizador (y no puede pasárselo a otro), o el creador
    if not v_creador and (v_actual.datos->>'organizerId' is distinct from v_yo or p_torneo->>'organizerId' is distinct from v_yo) then
      raise exception 'no_autorizado';
    end if;
    if v_actual.rev <> coalesce(p_rev, 0) then
      return jsonb_build_object('estado', 'conflicto', 'torneo', v_actual.datos || jsonb_build_object('rev', v_actual.rev));
    end if;
    v_rev := v_actual.rev + 1;
    update torneos
    set datos = p_torneo - 'rev', resumen = coalesce(p_resumen, resumen), rev = v_rev, actualizado = now(),
        organizador_id = case when coalesce(p_torneo->>'organizerId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_torneo->>'organizerId')::uuid end
    where id = v_actual.id;
  end if;

  perform public.espejar_torneos();
  return jsonb_build_object('estado', 'ok', 'rev', v_rev);
end;
$$;

-- Igual que en 20261005_guardar_eventos_circuitos_portadas.sql, con el control de organizador
create or replace function public.guardar_en_lista(p_clave text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lista jsonb;
  v_i int;
  v_actual jsonb;
  v_yo text := auth.uid()::text;
  v_creador boolean := public.es_creador();
begin
  if v_yo is null or not public.es_organizador() then
    raise exception 'no_autorizado';
  end if;
  if p_clave not in ('sp:events', 'sp:circuits') then
    raise exception 'clave_invalida';
  end if;
  if jsonb_typeof(p_item) <> 'object' or coalesce(p_item->>'id', '') = '' then
    raise exception 'datos_invalidos';
  end if;

  select value into v_lista from app_data where key = p_clave for update;
  v_lista := coalesce(v_lista, '[]'::jsonb);

  select t.ord - 1, t.val into v_i, v_actual
  from jsonb_array_elements(v_lista) with ordinality as t(val, ord)
  where t.val->>'id' = p_item->>'id';

  if not v_creador and (p_item->>'organizerId' is distinct from v_yo or (v_actual is not null and v_actual->>'organizerId' is distinct from v_yo)) then
    raise exception 'no_autorizado';
  end if;

  if v_actual is null then
    v_lista := v_lista || jsonb_build_array(p_item);
  else
    v_lista := jsonb_set(v_lista, array[v_i::text], p_item);
  end if;

  insert into app_data (key, value, updated_at) values (p_clave, v_lista, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('estado', 'ok');
end;
$$;

create or replace function public.guardar_portada(p_organizador uuid, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portadas jsonb;
begin
  if auth.uid() is null or not public.es_organizador() or (p_organizador is distinct from auth.uid() and not public.es_creador()) then
    raise exception 'no_autorizado';
  end if;

  select value into v_portadas from app_data where key = 'sp:organizer_covers' for update;
  v_portadas := coalesce(v_portadas, '{}'::jsonb) || jsonb_build_object(p_organizador::text, coalesce(p_url, ''));

  insert into app_data (key, value, updated_at) values ('sp:organizer_covers', v_portadas, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('estado', 'ok');
end;
$$;

-- Imágenes: suben solo los organizadores (antes, cualquier logueado). Se borran las políticas que
-- dejaban subir, modificar o borrar en el bucket 'images' a cualquier logueado (en el proyecto real
-- puede tener otro nombre que en el de prueba); la app solo sube archivos nuevos.
do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and policyname <> 'Solo organizadores suben imagenes'
      and (coalesce(with_check, '') || coalesce(qual, '')) like '%images%'
  loop
    raise notice 'Se borra la política de storage: %', p.policyname;
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
drop policy if exists "Solo organizadores suben imagenes" on storage.objects;
create policy "Solo organizadores suben imagenes" on storage.objects
  for insert to authenticated with check (bucket_id = 'images' and public.es_organizador());

-- ============================================================
-- 2. Jugadores
-- ============================================================

create table if not exists public.jugadores (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 40),
  apellido text not null check (char_length(btrim(apellido)) between 1 and 40),
  telefono text not null check (telefono ~ '^549[0-9]{10}$'),
  fecha_nacimiento date check (fecha_nacimiento is null or fecha_nacimiento > '1920-01-01'),
  created_at timestamptz not null default now()
);

alter table public.jugadores enable row level security;
revoke all on public.jugadores from public, anon, authenticated;
grant select, insert, update on public.jugadores to authenticated;

drop policy if exists "El jugador ve su perfil" on public.jugadores;
create policy "El jugador ve su perfil" on public.jugadores for select to authenticated using (id = auth.uid());
drop policy if exists "El jugador crea su perfil" on public.jugadores;
create policy "El jugador crea su perfil" on public.jugadores for insert to authenticated with check (id = auth.uid());
drop policy if exists "El jugador edita su perfil" on public.jugadores;
create policy "El jugador edita su perfil" on public.jugadores for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ============================================================
-- Reservas: quién canceló, y los jugadores bloqueados por cada complejo
-- ============================================================

alter table public.reservas
  add column if not exists cancelada_por text check (cancelada_por is null or cancelada_por in ('complejo', 'jugador')),
  add column if not exists cancelacion_silenciosa boolean not null default false;

create index if not exists reservas_pendientes on public.reservas (complejo_id, estado) where estado = 'pendiente';
create index if not exists reservas_por_jugador on public.reservas (jugador_id) where jugador_id is not null;

drop policy if exists "El jugador ve sus reservas" on public.reservas;
create policy "El jugador ve sus reservas" on public.reservas for select to authenticated using (jugador_id = auth.uid());

create table if not exists public.jugadores_bloqueados (
  complejo_id text not null references public.complejos(id) on delete cascade,
  jugador_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (complejo_id, jugador_id)
);

alter table public.jugadores_bloqueados enable row level security;
revoke all on public.jugadores_bloqueados from public, anon, authenticated;
grant select, insert, delete on public.jugadores_bloqueados to authenticated;

drop policy if exists "El dueño ve sus bloqueados" on public.jugadores_bloqueados;
create policy "El dueño ve sus bloqueados" on public.jugadores_bloqueados for select to authenticated using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño bloquea" on public.jugadores_bloqueados;
create policy "El dueño bloquea" on public.jugadores_bloqueados for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño desbloquea" on public.jugadores_bloqueados;
create policy "El dueño desbloquea" on public.jugadores_bloqueados for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- ============================================================
-- 3. Vencimiento de pedidos sin confirmar
-- ============================================================

-- Pasa a "vencida" los pedidos pendientes cuyo plazo ya pasó, así liberan el horario. Se llama al
-- consultar la disponibilidad, al pedir un turno y al abrir la agenda del complejo.
create or replace function public.vencer_pedidos()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update reservas set estado = 'vencida' where estado = 'pendiente' and vence_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.vencer_pedidos() from public;
grant execute on function public.vencer_pedidos() to anon, authenticated;

-- ============================================================
-- 4. Disponibilidad pública: horarios ocupados de un día, sin datos de nadie
-- ============================================================

-- Todo lo que ocupa las canchas del complejo entre las 00:00 del día y las 00:00 de dos días
-- después (por las canchas que cierran pasada la medianoche).
create or replace function public.disponibilidad_canchas(p_complejo text, p_fecha date)
returns table (cancha_id uuid, inicio timestamptz, fin timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desde timestamptz := p_fecha::timestamp at time zone 'America/Argentina/Buenos_Aires';
begin
  if not exists (select 1 from complejos where id = p_complejo and reservas_habilitadas) then
    return;
  end if;
  perform public.vencer_pedidos();
  return query
    select r.cancha_id, r.inicio, r.fin
    from reservas r
    where r.complejo_id = p_complejo
      and r.estado in ('pendiente', 'confirmada')
      and r.inicio < v_desde + interval '2 days'
      and r.fin > v_desde;
end;
$$;

revoke all on function public.disponibilidad_canchas(text, date) from public;
grant execute on function public.disponibilidad_canchas(text, date) to anon, authenticated;

-- ============================================================
-- 5. Pedido de turno del jugador
-- ============================================================

-- p_minuto: minutos desde las 00:00 del día de la grilla (puede pasar de 1440 si la cancha cierra
-- pasada la medianoche). Devuelve el id de la reserva, o corta con un error que la app traduce:
-- sin_sesion, sin_perfil, cancha_invalida, duracion_invalida, fuera_de_horario, horario_pasado,
-- muy_adelante, bloqueado, ocupado.
create or replace function public.pedir_turno(p_cancha uuid, p_fecha date, p_minuto int, p_duracion int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador jugadores%rowtype;
  v_cancha canchas%rowtype;
  v_precio numeric;
  v_abre int;
  v_cierra int;
  v_inicio timestamptz;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sin_sesion';
  end if;
  select * into v_jugador from jugadores where id = auth.uid();
  if not found then
    raise exception 'sin_perfil';
  end if;

  select c.* into v_cancha
  from canchas c join complejos x on x.id = c.complejo_id
  where c.id = p_cancha and c.activa and c.reserva_online and x.reservas_habilitadas;
  if not found then
    raise exception 'cancha_invalida';
  end if;

  v_precio := case p_duracion when 60 then v_cancha.precio_60 when 90 then v_cancha.precio_90 when 120 then v_cancha.precio_120 end;
  if v_precio is null then
    raise exception 'duracion_invalida';
  end if;

  v_abre := extract(hour from v_cancha.apertura)::int * 60 + extract(minute from v_cancha.apertura)::int;
  v_cierra := extract(hour from v_cancha.cierre)::int * 60 + extract(minute from v_cancha.cierre)::int;
  if v_cierra <= v_abre then
    v_cierra := v_cierra + 1440;
  end if;
  if p_minuto is null or p_minuto % 30 <> 0 or p_minuto < v_abre or p_minuto + p_duracion > v_cierra then
    raise exception 'fuera_de_horario';
  end if;

  v_inicio := (p_fecha::timestamp + make_interval(mins => p_minuto)) at time zone 'America/Argentina/Buenos_Aires';
  if v_inicio <= now() then
    raise exception 'horario_pasado';
  end if;
  if p_fecha > v_hoy + 30 then
    raise exception 'muy_adelante';
  end if;

  if exists (select 1 from jugadores_bloqueados where complejo_id = v_cancha.complejo_id and jugador_id = auth.uid()) then
    raise exception 'bloqueado';
  end if;

  perform public.vencer_pedidos();

  begin
    insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, origen, nombre, telefono, jugador_id, precio, vence_at, creada_por)
    values (v_cancha.complejo_id, v_cancha.id, 'turno', p_fecha, v_inicio, v_inicio + make_interval(mins => p_duracion), 'pendiente', 'online',
            left(btrim(v_jugador.nombre) || ' ' || btrim(v_jugador.apellido), 80), v_jugador.telefono, auth.uid(), v_precio,
            least(now() + interval '24 hours', v_inicio), auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'ocupado';
  end;

  return v_id;
end;
$$;

revoke all on function public.pedir_turno(uuid, date, int, int) from public, anon;
grant execute on function public.pedir_turno(uuid, date, int, int) to authenticated;

-- ============================================================
-- 6. Cancelación del jugador
-- ============================================================

-- Dentro de los 30 minutos de pedirlo: se cancela sin aviso al complejo (para corregir un error).
-- Después: solo hasta 24 h antes del turno, y el complejo lo ve en su panel. Devuelve
-- 'silenciosa' o 'avisada'; corta con no_encontrada, no_cancelable o fuera_de_plazo.
create or replace function public.cancelar_mi_reserva(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r reservas%rowtype;
  v_silenciosa boolean;
begin
  select * into v_r from reservas where id = p_id and jugador_id = auth.uid() for update;
  if not found then
    raise exception 'no_encontrada';
  end if;
  if v_r.estado not in ('pendiente', 'confirmada') or v_r.inicio <= now() then
    raise exception 'no_cancelable';
  end if;

  if now() <= v_r.created_at + interval '30 minutes' then
    v_silenciosa := true;
  elsif v_r.inicio - now() >= interval '24 hours' then
    v_silenciosa := false;
  else
    raise exception 'fuera_de_plazo';
  end if;

  update reservas
  set estado = 'cancelada', cancelada_at = now(), cancelada_por = 'jugador', cancelacion_silenciosa = v_silenciosa
  where id = p_id;
  return case when v_silenciosa then 'silenciosa' else 'avisada' end;
end;
$$;

revoke all on function public.cancelar_mi_reserva(uuid) from public, anon;
grant execute on function public.cancelar_mi_reserva(uuid) to authenticated;
