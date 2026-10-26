-- Editar un turno ya cargado: nombre, teléfono, cancha, día, hora, duración, precio y nota.
--
-- - editar_turno(): lo usa el dueño o un empleado con permiso de agenda. En un turno fijo se puede
--   cambiar solo ese o ese y los que siguen de la serie (corridos la misma cantidad de días; el
--   precio de los que ya están cobrados no se toca). Si un horario se pisa con otro, no cambia nada.
-- - El precio de un turno cobrado lo cambia solo el dueño (sigue la regla de 20261032) y la Caja se
--   corrige sola (20261045).
-- - Si el turno lo pidió un jugador por la app y le cambian el día, la hora o la cancha, le llega el
--   aviso "Te cambiaron el turno" (campanita y celular).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261046.

create or replace function public.editar_turno(
  p_id uuid, p_fecha date, p_cancha uuid, p_minuto int, p_duracion int,
  p_nombre text, p_telefono text, p_precio numeric, p_nota text, p_siguientes boolean default false)
returns int
language plpgsql security definer set search_path = public as $$
declare
  r reservas%rowtype;
  x reservas%rowtype;
  v_corre int;
  v_fecha date;
  v_n int := 0;
begin
  select * into r from reservas where id = p_id;
  if not found or r.tipo = 'bloqueo' then raise exception 'no_encontrado'; end if;
  if not (public.es_dueno_complejo(r.complejo_id) or public.colaborador_permiso(r.complejo_id, 'agenda')) then raise exception 'no_autorizado'; end if;
  if r.estado not in ('confirmada', 'pendiente') then raise exception 'turno_no_vigente'; end if;
  if p_fecha is null or p_minuto is null or p_minuto < 0 or p_minuto >= 1440 or p_duracion is null or p_duracion < 30 or p_duracion > 360 then
    raise exception 'datos_invalidos';
  end if;
  if char_length(btrim(coalesce(p_nombre, ''))) = 0 then raise exception 'falta_nombre'; end if;
  if p_telefono is not null and p_telefono !~ '^549[0-9]{10}$' then raise exception 'telefono_invalido'; end if;
  if p_precio is not null and p_precio < 0 then raise exception 'datos_invalidos'; end if;
  if not exists (select 1 from canchas where id = p_cancha and complejo_id = r.complejo_id) then raise exception 'cancha_invalida'; end if;
  v_corre := p_fecha - r.fecha;

  for x in
    select * from reservas
    where (id = r.id) or (coalesce(p_siguientes, false) and r.serie_id is not null and serie_id = r.serie_id
          and fecha > r.fecha and estado in ('confirmada', 'pendiente'))
    -- si se corren para adelante, primero los más lejanos (así no se pisan entre ellos al moverse)
    order by (fecha - date '2000-01-01') * case when v_corre > 0 then -1 else 1 end
  loop
    v_fecha := x.fecha + v_corre;
    update reservas set
      fecha = v_fecha,
      cancha_id = p_cancha,
      inicio = (v_fecha + make_interval(mins => p_minuto))::timestamp at time zone 'America/Argentina/Buenos_Aires',
      fin = (v_fecha + make_interval(mins => p_minuto + p_duracion))::timestamp at time zone 'America/Argentina/Buenos_Aires',
      nombre = btrim(p_nombre),
      telefono = p_telefono,
      precio = case when x.id = r.id or x.medio_pago is null then p_precio else x.precio end,
      nota = nullif(btrim(coalesce(p_nota, '')), '')
    where id = x.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;
revoke all on function public.editar_turno(uuid, date, uuid, int, int, text, text, numeric, text, boolean) from public, anon;
grant execute on function public.editar_turno(uuid, date, uuid, int, int, text, text, numeric, text, boolean) to authenticated;

-- Aviso al jugador que lo pidió por la app cuando le cambian el día, la hora o la cancha
create or replace function public.avisos_turno_cambiado()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_complejo text; v_cancha text;
begin
  begin
    if new.jugador_id is null or new.origen <> 'online' or new.estado not in ('confirmada', 'pendiente') then return new; end if;
    if old.inicio = new.inicio and old.cancha_id = new.cancha_id then return new; end if;
    select coalesce((select v->>'name' from app_data a, jsonb_array_elements(a.value) v where a.key = 'sp:venues' and v->>'id' = x.id), 'El complejo')
      into v_complejo from complejos x where x.id = new.complejo_id;
    select nombre into v_cancha from canchas where id = new.cancha_id;
    perform public._avisar(array[new.jugador_id], 'turno_cambiado', 'Te cambiaron el turno',
      v_complejo || ' cambió tu turno: ahora es el ' || public._dia_hora(new.inicio) || ' (' || coalesce(v_cancha, 'cancha') || ').',
      jsonb_build_object('ir', 'mis-reservas'), new.id::text || ':' || extract(epoch from new.inicio)::bigint::text || ':' || new.cancha_id::text);
  exception when others then
    raise warning 'aviso de turno cambiado no anotado: %', sqlerrm;
  end;
  return new;
end; $$;
revoke all on function public.avisos_turno_cambiado() from public, anon, authenticated;
drop trigger if exists avisos_turno_cambiado on public.reservas;
create trigger avisos_turno_cambiado after update of inicio, cancha_id on public.reservas
  for each row execute function public.avisos_turno_cambiado();

-- Vuelta atrás (si hiciera falta):
--   drop trigger if exists avisos_turno_cambiado on public.reservas;
--   drop function if exists public.avisos_turno_cambiado(), public.editar_turno(uuid, date, uuid, int, int, text, text, numeric, text, boolean);
