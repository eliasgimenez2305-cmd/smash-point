-- Inscripciones: disponibilidad horaria de la pareja (torneos clásicos).
-- Correr una sola vez en el SQL Editor de Supabase, después de 20260927_inscripciones.sql.
--
-- - disponibilidad: por cada día que el organizador cargó en el torneo (playDates), el rango en que
--   la pareja puede jugar: [{ "date": "2026-10-03", "from": "09:00", "to": "20:00" }, ...]. Un día
--   que no aparece es un día en que no puede. Mismo formato que la disponibilidad de una pareja
--   cargada a mano, así el armado automático de horarios la usa igual.
-- - cruce_mismo_dia: si clasifican, ¿pueden jugar el primer cruce de llave el mismo día que
--   terminan la zona?
-- Al aceptar, las dos cosas pasan a la pareja (availability y sameDayBracket). No hay teléfonos.

alter table public.inscripciones
  add column if not exists disponibilidad jsonb,
  add column if not exists cruce_mismo_dia boolean;

-- La firma cambia (dos parámetros nuevos): se borra la anterior para no dejar dos versiones
drop function if exists public.crear_inscripcion(text, text, text, text, text, text);

create or replace function public.crear_inscripcion(
  p_torneo_id text,
  p_categoria_id text,
  p_jugador1 text,
  p_jugador2 text,
  p_telefono text,
  p_honeypot text default null,
  p_disponibilidad jsonb default null,
  p_cruce_mismo_dia boolean default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_torneos jsonb;
  v_torneo jsonb;
  v_categoria jsonb;
  v_formato text;
  v_cupo int;
  v_disp jsonb;
  v_j1 text := nullif(btrim(regexp_replace(coalesce(p_jugador1, ''), '\s+', ' ', 'g')), '');
  v_j2 text := nullif(btrim(regexp_replace(coalesce(p_jugador2, ''), '\s+', ' ', 'g')), '');
  v_tel text := public.normalizar_telefono_ar(p_telefono);
begin
  -- Honeypot: un bot lo completó. Se responde "ok" para no darle pistas, pero no se guarda nada.
  if coalesce(p_honeypot, '') <> '' then
    return 'ok';
  end if;

  select value into v_torneos from app_data where key = 'sp:tournaments';
  select t.val into v_torneo from jsonb_array_elements(coalesce(v_torneos, '[]'::jsonb)) as t(val) where t.val->>'id' = p_torneo_id;

  if v_torneo is null
     or coalesce((v_torneo->>'inscripcionesAbiertas')::boolean, false) = false
     or v_torneo->>'status' = 'Finalizado'
     or coalesce((v_torneo->>'infoOnly')::boolean, false)
     or coalesce(v_torneo->>'organizerId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'inscripciones_cerradas';
  end if;

  select c.val into v_categoria from jsonb_array_elements(coalesce(v_torneo->'categories', '[]'::jsonb)) as c(val) where c.val->>'id' = p_categoria_id;
  if v_categoria is null then
    raise exception 'categoria_invalida';
  end if;

  v_formato := coalesce(v_categoria->>'format', 'zonas');
  -- Un Súper 8 con los partidos ya generados no admite más inscriptos
  if v_formato like 'super8%' and jsonb_array_length(coalesce(v_categoria->'groups', '[]'::jsonb)) > 0 then
    raise exception 'inscripciones_cerradas';
  end if;

  -- Súper 8 Individual: se anota un solo jugador. En el resto, los dos.
  if v_formato = 'super8_individual' then
    v_j2 := null;
  elsif v_j2 is null then
    raise exception 'datos_invalidos';
  end if;
  if v_j1 is null or char_length(v_j1) not between 3 and 80 or (v_j2 is not null and char_length(v_j2) not between 3 and 80) then
    raise exception 'datos_invalidos';
  end if;

  if v_tel is null then
    raise exception 'telefono_invalido';
  end if;

  -- Cupo por categoría: cuentan todas las parejas ya anotadas (a mano o aceptadas)
  v_cupo := case when v_formato like 'super8%' then 8 else nullif(v_categoria->>'cupo', '')::int end;
  if v_cupo is not null and jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) >= v_cupo then
    raise exception 'cupo_completo';
  end if;

  -- Disponibilidad: solo se guardan días que el organizador cargó en el torneo, con horas válidas
  if p_disponibilidad is not null and jsonb_typeof(p_disponibilidad) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('date', d->>'date', 'from', d->>'from', 'to', d->>'to') order by d->>'date'), '[]'::jsonb)
    into v_disp
    from jsonb_array_elements(p_disponibilidad) as d
    where d->>'date' in (select pd->>'date' from jsonb_array_elements(coalesce(v_torneo->'playDates', '[]'::jsonb)) as pd)
      and coalesce(d->>'from', '') ~ '^[0-9]{2}:[0-9]{2}$'
      and coalesce(d->>'to', '') ~ '^[0-9]{2}:[0-9]{2}$'
      and d->>'from' < d->>'to';
    if jsonb_array_length(v_disp) = 0 then
      raise exception 'disponibilidad_invalida';
    end if;
  end if;

  begin
    insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono, disponibilidad, cruce_mismo_dia)
    values (p_torneo_id, (v_torneo->>'organizerId')::uuid, p_categoria_id, v_j1, v_j2, v_tel, v_disp, p_cruce_mismo_dia);
  exception when unique_violation then
    raise exception 'duplicada';
  end;

  return 'ok';
end;
$$;

-- Aceptar: igual que antes, y además la pareja se lleva su disponibilidad y la respuesta del cruce
create or replace function public.aceptar_inscripcion(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ins inscripciones%rowtype;
  v_torneos jsonb;
  v_ti int;
  v_ci int;
  v_categoria jsonb;
  v_formato text;
  v_pareja jsonb;
begin
  select * into v_ins from inscripciones where id = p_id for update;
  if not found or v_ins.organizador_id is distinct from auth.uid() then
    raise exception 'no_autorizado';
  end if;
  if v_ins.estado <> 'pendiente' then
    raise exception 'ya_resuelta';
  end if;

  -- Se bloquea la fila de torneos para que nadie la cambie mientras se agrega la pareja
  select value into v_torneos from app_data where key = 'sp:tournaments' for update;

  select t.ord - 1 into v_ti
  from jsonb_array_elements(coalesce(v_torneos, '[]'::jsonb)) with ordinality as t(val, ord)
  where t.val->>'id' = v_ins.torneo_id and t.val->>'organizerId' = auth.uid()::text;
  if v_ti is null then
    raise exception 'torneo_no_encontrado';
  end if;

  select c.ord - 1, c.val into v_ci, v_categoria
  from jsonb_array_elements(coalesce(v_torneos->v_ti->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
  where c.val->>'id' = v_ins.categoria_id;
  if v_ci is null then
    raise exception 'categoria_invalida';
  end if;

  v_formato := coalesce(v_categoria->>'format', 'zonas');
  if v_formato like 'super8%' then
    if jsonb_array_length(coalesce(v_categoria->'groups', '[]'::jsonb)) > 0 then
      raise exception 'partidos_generados';
    end if;
    if jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) >= 8 then
      raise exception 'cupo_completo';
    end if;
  end if;

  -- Misma forma que una pareja cargada a mano. El teléfono NO se copia: app_data es público.
  v_pareja := jsonb_build_object(
    'id', substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    'name', case when v_ins.jugador2_nombre is null then v_ins.jugador1_nombre else v_ins.jugador1_nombre || ' / ' || v_ins.jugador2_nombre end,
    'availability', coalesce(v_ins.disponibilidad, '[]'::jsonb),
    'inscripcionId', v_ins.id
  );
  if v_ins.cruce_mismo_dia is not null then
    v_pareja := v_pareja || jsonb_build_object('sameDayBracket', v_ins.cruce_mismo_dia);
  end if;

  v_torneos := jsonb_set(
    v_torneos,
    array[v_ti::text, 'categories', v_ci::text, 'pairs'],
    coalesce(v_categoria->'pairs', '[]'::jsonb) || jsonb_build_array(v_pareja)
  );

  update app_data set value = v_torneos, updated_at = now() where key = 'sp:tournaments';
  update inscripciones set estado = 'aceptada', pareja_id = v_pareja->>'id', resuelta_at = now() where id = p_id;

  return v_pareja;
end;
$$;

-- Permisos: solo el público (y usuarios logueados) pueden inscribirse; aceptar es del organizador
revoke all on function public.crear_inscripcion(text, text, text, text, text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.aceptar_inscripcion(uuid) from public, anon, authenticated;
grant execute on function public.crear_inscripcion(text, text, text, text, text, text, jsonb, boolean) to anon, authenticated;
grant execute on function public.aceptar_inscripcion(uuid) to authenticated;
