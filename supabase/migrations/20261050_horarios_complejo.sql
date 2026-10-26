-- Horario del complejo y horario de reservas online, por día de la semana.
--
-- - complejos.horario: cuándo abre el complejo cada día. Arma la agenda de todas las canchas.
--   {"0": [540, 1320], "1": [420, 1440], ..., "6": null}  (0 = domingo; minutos desde las 00:00;
--   el "hasta" puede pasar de 1440 si cierra después de medianoche; null = cerrado ese día).
--   Si es null (sin cargar), cada cancha usa su apertura/cierre como hasta ahora.
-- - complejos.horario_online: qué horarios se pueden pedir online (mismo formato). Si es null, se
--   puede pedir en todo el horario del complejo. Online = lo que se cruza de los dos.
-- - canchas.horario_propio: la cancha abre en otro horario (usa su apertura/cierre todos los días).
-- - pedir_turno() valida con el horario online de ese día.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261049.

-- Formato válido: objeto con las claves "0".."6", cada una null o [desde, hasta] en múltiplos de 30
create or replace function public._horario_semanal_valido(p jsonb) returns boolean
language plpgsql immutable as $$
declare k text; v jsonb; d int; h int;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(p) loop
    if k not in ('0', '1', '2', '3', '4', '5', '6') then return false; end if;
    continue when jsonb_typeof(v) = 'null';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) <> 2 then return false; end if;
    d := (v->>0)::int; h := (v->>1)::int;
    if d is null or h is null or d < 0 or d >= 1440 or h <= d or h > d + 1440 or d % 30 <> 0 or h % 30 <> 0 then return false; end if;
  end loop;
  return true;
exception when others then return false;
end; $$;

alter table public.complejos add column if not exists horario jsonb;
alter table public.complejos add column if not exists horario_online jsonb;
alter table public.complejos drop constraint if exists complejos_horario_check;
alter table public.complejos add constraint complejos_horario_check check (public._horario_semanal_valido(horario) and public._horario_semanal_valido(horario_online));
alter table public.canchas add column if not exists horario_propio boolean not null default false;

-- Horario de una cancha un día: desde/hasta en minutos (null = cerrada). p_online: el que se puede pedir online.
create or replace function public._horario_dia(p_cancha uuid, p_fecha date, p_online boolean default false, out desde int, out hasta int)
language plpgsql stable security definer set search_path = public as $$
declare c canchas%rowtype; x complejos%rowtype; v_dia text := extract(dow from p_fecha)::int::text; e jsonb; o jsonb;
begin
  select * into c from canchas where id = p_cancha;
  if not found then return; end if;
  select * into x from complejos where id = c.complejo_id;
  if x.horario is null or c.horario_propio then
    desde := extract(hour from c.apertura)::int * 60 + extract(minute from c.apertura)::int;
    hasta := extract(hour from c.cierre)::int * 60 + extract(minute from c.cierre)::int;
    if hasta <= desde then hasta := hasta + 1440; end if;
  else
    e := x.horario -> v_dia;
    if e is null or jsonb_typeof(e) <> 'array' then desde := null; hasta := null; return; end if;
    desde := (e->>0)::int; hasta := (e->>1)::int;
  end if;
  if p_online and x.horario_online is not null then
    o := x.horario_online -> v_dia;
    if o is null or jsonb_typeof(o) <> 'array' then desde := null; hasta := null; return; end if;
    desde := greatest(desde, (o->>0)::int);
    hasta := least(hasta, (o->>1)::int);
    if hasta <= desde then desde := null; hasta := null; end if;
  end if;
end; $$;
revoke all on function public._horario_dia(uuid, date, boolean) from public, anon, authenticated;

-- Guardar los horarios (solo el dueño del complejo)
create or replace function public.guardar_horarios_complejo(p_complejo text, p_horario jsonb, p_horario_online jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_dueno_complejo(p_complejo) then raise exception 'no_autorizado'; end if;
  if not (public._horario_semanal_valido(p_horario) and public._horario_semanal_valido(p_horario_online)) then raise exception 'horario_invalido'; end if;
  update complejos set horario = p_horario, horario_online = p_horario_online where id = p_complejo;
end; $$;
revoke all on function public.guardar_horarios_complejo(text, jsonb, jsonb) from public, anon;
grant execute on function public.guardar_horarios_complejo(text, jsonb, jsonb) to authenticated;

-- pedir_turno (de 20261032) con el horario online del día
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
  where c.id = p_cancha and c.activa and c.reserva_online and x.reservas_habilitadas and x.modulo_reservas;
  if not found then
    raise exception 'cancha_invalida';
  end if;

  v_precio := case p_duracion when 60 then v_cancha.precio_60 when 90 then v_cancha.precio_90 when 120 then v_cancha.precio_120 end;
  if v_precio is null then
    raise exception 'duracion_invalida';
  end if;

  select desde, hasta into v_abre, v_cierra from public._horario_dia(p_cancha, p_fecha, true);
  if v_abre is null or p_minuto is null or p_minuto % 30 <> 0 or p_minuto < v_abre or p_minuto + p_duracion > v_cierra then
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

  -- Un jugador no puede tener tomadas muchas canchas sin confirmar
  if (select count(*) from reservas where complejo_id = v_cancha.complejo_id and jugador_id = auth.uid() and estado = 'pendiente') >= 2 then
    raise exception 'demasiados_pedidos';
  end if;

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

-- Vuelta atrás (si hiciera falta): volver a correr pedir_turno() de 20261032_auditoria.sql y
--   drop function if exists public.guardar_horarios_complejo(text, jsonb, jsonb), public._horario_dia(uuid, date, boolean);
--   alter table public.complejos drop constraint if exists complejos_horario_check, drop column if exists horario, drop column if exists horario_online;
--   alter table public.canchas drop column if exists horario_propio;
--   drop function if exists public._horario_semanal_valido(jsonb);
