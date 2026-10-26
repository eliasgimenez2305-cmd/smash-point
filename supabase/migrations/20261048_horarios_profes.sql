-- Horario fijo de un profe: "lunes, miércoles y viernes de 7 a 12 en la Cancha 1".
--
-- - horarios_profe: la regla (días, desde-hasta, cancha, desde qué fecha y, si se terminó, hasta cuándo).
-- - Cada día del horario es UNA reserva tipo 'clase' (un solo bloque, del largo que sea) con
--   horario_id. Se mantienen reservadas siempre las próximas 8 semanas: al crear el horario y todas
--   las mañanas (tarea 'smashpoint-horarios'). Si una cancha está ocupada ese día no se pisa nada:
--   se avisa al dueño en la campanita.
-- - Si el profe falta, se cancela la clase de ese día en la agenda y el horario queda libre: como
--   la reserva cancelada sigue existiendo, no se vuelve a generar.
-- - Cambiar el horario: las clases que vienen (sin cobrar) se rehacen con el horario nuevo.
--   Terminar: desde esa fecha se liberan las canchas.
-- - Si el profe alquila la cancha, cada bloque vale sus horas por el precio por hora.
--
-- Lo manejan el dueño y los empleados con permiso de agenda.
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261047.

create table if not exists public.horarios_profe (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  profe_id uuid not null,
  cancha_id uuid not null,
  dias smallint[] not null check (cardinality(dias) between 1 and 7 and dias <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]), -- 0 domingo … 6 sábado
  desde smallint not null check (desde between 0 and 1410),   -- minutos desde las 00:00
  hasta smallint not null check (hasta between 30 and 1440),
  vigente_desde date not null,
  vigente_hasta date,                                          -- null = sigue hasta que se termine
  created_at timestamptz not null default now(),
  check (hasta > desde),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde - 1),
  foreign key (profe_id, complejo_id) references public.profes_complejo (id, complejo_id) on delete cascade,
  foreign key (cancha_id, complejo_id) references public.canchas (id, complejo_id) on delete cascade
);
create index if not exists horarios_por_profe on public.horarios_profe (profe_id);

alter table public.reservas add column if not exists horario_id uuid references public.horarios_profe(id) on delete set null;
create index if not exists reservas_por_horario on public.reservas (horario_id, fecha) where horario_id is not null;

alter table public.horarios_profe enable row level security;
revoke all on public.horarios_profe from public, anon, authenticated;
grant select on public.horarios_profe to authenticated;
drop policy if exists "Ven horarios de profes" on public.horarios_profe;
create policy "Ven horarios de profes" on public.horarios_profe for select to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));

create or replace function public._puede_horarios(p_complejo text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.es_dueno_complejo(p_complejo) or public.colaborador_permiso(p_complejo, 'agenda');
$$;
revoke all on function public._puede_horarios(text) from public, anon, authenticated;

-- Reserva las clases del horario que falten hasta p_hasta (sin pisar nada). Devuelve las fechas que no
-- se pudieron reservar porque la cancha estaba ocupada (y le avisa al dueño).
create or replace function public._generar_horario(p_horario uuid, p_hasta date)
returns date[]
language plpgsql security definer set search_path = public as $$
declare
  h horarios_profe%rowtype;
  p profes_complejo%rowtype;
  d date;
  v_ocupadas date[] := '{}';
  v_dueno uuid;
  v_cancha text;
begin
  select * into h from horarios_profe where id = p_horario;
  if not found then return v_ocupadas; end if;
  select * into p from profes_complejo where id = h.profe_id;
  if not p.activo then return v_ocupadas; end if;
  for d in
    select g::date from generate_series(greatest(h.vigente_desde, _fecha_ar(now())), least(coalesce(h.vigente_hasta, p_hasta), p_hasta), interval '1 day') g
    where extract(dow from g)::smallint = any(h.dias)
  loop
    continue when exists (select 1 from reservas where horario_id = h.id and fecha = d);
    -- el bloque de hoy que ya empezó no se reserva
    continue when ((d + make_interval(mins => h.desde))::timestamp at time zone 'America/Argentina/Buenos_Aires') <= now();
    begin
      insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, origen, nombre, telefono, precio, profe_id, horario_id, serie_id)
      values (h.complejo_id, h.cancha_id, 'clase', d,
              (d + make_interval(mins => h.desde))::timestamp at time zone 'America/Argentina/Buenos_Aires',
              (d + make_interval(mins => h.hasta))::timestamp at time zone 'America/Argentina/Buenos_Aires',
              'confirmada', 'manual', left('Clase · ' || p.nombre, 80), p.telefono,
              case when p.modo = 'alquila' and p.precio_hora is not null then round(p.precio_hora * (h.hasta - h.desde) / 60.0) end,
              p.id, h.id, h.id);
    exception
      when exclusion_violation then
        v_ocupadas := v_ocupadas || d;
        select dueno_id into v_dueno from complejos where id = h.complejo_id;
        select nombre into v_cancha from canchas where id = h.cancha_id;
        perform _avisar(array[v_dueno], 'clase_no_reservada', 'No se pudo reservar una clase',
          'La clase de ' || p.nombre || ' del ' || _dia_hora((d + make_interval(mins => h.desde))::timestamp at time zone 'America/Argentina/Buenos_Aires')
            || ' no se reservó: ' || coalesce(v_cancha, 'la cancha') || ' estaba ocupada.',
          jsonb_build_object('ir', 'agenda', 'complejo', h.complejo_id, 'fecha', d), h.id::text || ':' || d::text);
      when others then
        null; -- plan vencido o función apagada: no se reserva
    end;
  end loop;
  return v_ocupadas;
end; $$;
revoke all on function public._generar_horario(uuid, date) from public, anon, authenticated;

-- Las clases que vienen de un horario y se pueden rehacer (sin cobrar, todavía no empezadas)
create or replace function public._liberar_horario(p_horario uuid, p_desde date) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from reservas
  where horario_id = p_horario and fecha >= p_desde and estado = 'confirmada' and medio_pago is null and inicio > now();
  get diagnostics v_n = row_count;
  return v_n;
end; $$;
revoke all on function public._liberar_horario(uuid, date) from public, anon, authenticated;

create or replace function public._validar_horario(p_complejo text, p_profe uuid, p_cancha uuid, p_dias int[], p_desde int, p_hasta int) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not _puede_horarios(p_complejo) then raise exception 'no_autorizado'; end if;
  if not exists (select 1 from profes_complejo where id = p_profe and complejo_id = p_complejo) then raise exception 'profe_invalido'; end if;
  if not exists (select 1 from canchas where id = p_cancha and complejo_id = p_complejo) then raise exception 'cancha_invalida'; end if;
  if p_dias is null or cardinality(p_dias) = 0 or not (p_dias <@ array[0, 1, 2, 3, 4, 5, 6]) then raise exception 'faltan_dias'; end if;
  if p_desde is null or p_hasta is null or p_desde < 0 or p_hasta > 1440 or p_hasta <= p_desde then raise exception 'horario_invalido'; end if;
end; $$;
revoke all on function public._validar_horario(text, uuid, uuid, int[], int, int) from public, anon, authenticated;

-- Crear el horario y reservar las próximas 8 semanas
create or replace function public.crear_horario_profe(p_profe uuid, p_cancha uuid, p_dias int[], p_desde int, p_hasta int, p_vigente_desde date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_complejo text; v_id uuid; v_ocupadas date[];
begin
  select complejo_id into v_complejo from profes_complejo where id = p_profe;
  perform _validar_horario(v_complejo, p_profe, p_cancha, p_dias, p_desde, p_hasta);
  insert into horarios_profe (complejo_id, profe_id, cancha_id, dias, desde, hasta, vigente_desde)
  values (v_complejo, p_profe, p_cancha, (select array_agg(distinct x::smallint order by x::smallint) from unnest(p_dias) x), p_desde, p_hasta,
          coalesce(p_vigente_desde, _fecha_ar(now())))
  returning id into v_id;
  v_ocupadas := _generar_horario(v_id, _fecha_ar(now()) + 56);
  return jsonb_build_object('id', v_id, 'creadas', (select count(*) from reservas where horario_id = v_id), 'ocupadas', to_jsonb(v_ocupadas));
end; $$;
revoke all on function public.crear_horario_profe(uuid, uuid, int[], int, int, date) from public, anon;
grant execute on function public.crear_horario_profe(uuid, uuid, int[], int, int, date) to authenticated;

-- Cambiar el horario desde una fecha: las clases que vienen (sin cobrar) se rehacen
create or replace function public.cambiar_horario_profe(p_id uuid, p_cancha uuid, p_dias int[], p_desde int, p_hasta int, p_desde_fecha date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare h horarios_profe%rowtype; v_desde date := coalesce(p_desde_fecha, _fecha_ar(now())); v_ocupadas date[];
begin
  select * into h from horarios_profe where id = p_id;
  if not found then raise exception 'no_encontrado'; end if;
  perform _validar_horario(h.complejo_id, h.profe_id, p_cancha, p_dias, p_desde, p_hasta);
  perform _liberar_horario(h.id, v_desde);
  update horarios_profe set cancha_id = p_cancha, dias = (select array_agg(distinct x::smallint order by x::smallint) from unnest(p_dias) x),
    desde = p_desde, hasta = p_hasta, vigente_desde = greatest(vigente_desde, v_desde), vigente_hasta = null
  where id = h.id;
  -- (los días cancelados a propósito siguen cancelados: no se vuelven a reservar)
  v_ocupadas := _generar_horario(h.id, _fecha_ar(now()) + 56);
  return jsonb_build_object('ocupadas', to_jsonb(v_ocupadas));
end; $$;
revoke all on function public.cambiar_horario_profe(uuid, uuid, int[], int, int, date) from public, anon;
grant execute on function public.cambiar_horario_profe(uuid, uuid, int[], int, int, date) to authenticated;

-- Terminar: desde esa fecha no hay más clases (se liberan las canchas)
create or replace function public.terminar_horario_profe(p_id uuid, p_desde date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare h horarios_profe%rowtype; v_desde date := coalesce(p_desde, _fecha_ar(now()));
begin
  select * into h from horarios_profe where id = p_id;
  if not found then raise exception 'no_encontrado'; end if;
  if not _puede_horarios(h.complejo_id) then raise exception 'no_autorizado'; end if;
  update horarios_profe set vigente_hasta = greatest(v_desde - 1, vigente_desde - 1) where id = h.id;
  return _liberar_horario(h.id, v_desde);
end; $$;
revoke all on function public.terminar_horario_profe(uuid, date) from public, anon;
grant execute on function public.terminar_horario_profe(uuid, date) to authenticated;

-- Todas las mañanas: completar las próximas 8 semanas de cada horario vigente
create or replace function public.generar_horarios() returns int
language plpgsql security definer set search_path = public as $$
declare h record; v_n int := 0;
begin
  for h in select id from horarios_profe where vigente_hasta is null or vigente_hasta >= _fecha_ar(now()) loop
    perform _generar_horario(h.id, _fecha_ar(now()) + 56);
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;
revoke all on function public.generar_horarios() from public, anon, authenticated;

select cron.unschedule('smashpoint-horarios') where exists (select 1 from cron.job where jobname = 'smashpoint-horarios');
select cron.schedule('smashpoint-horarios', '0 9 * * *', 'select public.generar_horarios()'); -- 06:00 de Argentina

-- Vuelta atrás (si hiciera falta):
--   select cron.unschedule('smashpoint-horarios');
--   drop function if exists public.generar_horarios(), public.terminar_horario_profe(uuid, date),
--     public.cambiar_horario_profe(uuid, uuid, int[], int, int, date), public.crear_horario_profe(uuid, uuid, int[], int, int, date),
--     public._validar_horario(text, uuid, uuid, int[], int, int), public._liberar_horario(uuid, date),
--     public._generar_horario(uuid, date), public._puede_horarios(text);
--   alter table public.reservas drop column if exists horario_id;
--   drop table if exists public.horarios_profe;
