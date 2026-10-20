-- Inscripción pública con los dos jugadores por separado (apellido, nombre y teléfono de cada uno)
-- y a quién contacta el organizador. Al aceptarla, cada jugador queda con su perfil (ver
-- 20261038_perfiles_jugador.sql) y la pareja entra al torneo con sus IDs, para el ranking.
--
-- - inscripciones: suma apellido, nombre de pila y teléfono de cada jugador y "contacto" (1 o 2).
--   jugador1_nombre / jugador2_nombre siguen guardando el nombre para mostrar ("Apellido Nombre") y
--   telefono, el del jugador al que se contacta (así el panel y el control de repetidos siguen igual).
-- - inscribir_pareja(): la inscripción nueva. crear_inscripcion() queda como estaba, para que el
--   sitio publicado siga andando hasta que se publique la versión nueva.
-- - aceptar_inscripcion(): igual que antes, más los jugadores con perfil en la pareja.
-- - _perfil_para(): busca o crea un perfil (uso interno); crear_jugador() la usa.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261038.

alter table public.inscripciones
  add column if not exists jugador1_apellido text,
  add column if not exists jugador1_pila text,
  add column if not exists telefono1 text,
  add column if not exists jugador2_apellido text,
  add column if not exists jugador2_pila text,
  add column if not exists telefono2 text,
  add column if not exists contacto smallint check (contacto is null or contacto in (1, 2));

-- ============================================================
-- Perfiles: buscar o crear (uso interno, sin chequeo de permisos)
-- ============================================================

create or replace function public._perfil_para(p_apellido text, p_nombre text, p_telefono text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from perfiles_jugador
   where telefono = p_telefono
     and public._nombre_normal(apellido) = public._nombre_normal(p_apellido)
     and public._nombre_normal(nombre) = public._nombre_normal(p_nombre)
   limit 1;
  if v_id is null then
    insert into perfiles_jugador (apellido, nombre, telefono)
    values (btrim(p_apellido), btrim(coalesce(p_nombre, '')), p_telefono)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public._perfil_para(text, text, text) from public, anon, authenticated;

create or replace function public.crear_jugador(p_apellido text, p_nombre text, p_telefono text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.puede_anotar_jugadores() then
    raise exception 'no_autorizado';
  end if;
  if p_telefono is null or p_telefono !~ '^549[0-9]{10}$'
     or char_length(btrim(coalesce(p_apellido, ''))) not between 1 and 40
     or char_length(btrim(coalesce(p_nombre, ''))) > 40 then
    raise exception 'datos_invalidos';
  end if;
  return public._perfil_para(p_apellido, p_nombre, p_telefono);
end;
$$;
revoke all on function public.crear_jugador(text, text, text) from public, anon;
grant execute on function public.crear_jugador(text, text, text) to authenticated;

-- ============================================================
-- Inscripción pública nueva
-- ============================================================

create or replace function public.inscribir_pareja(
  p_torneo_id text,
  p_categoria_id text,
  p_j1_apellido text,
  p_j1_nombre text,
  p_j1_telefono text,
  p_j2_apellido text default null,
  p_j2_nombre text default null,
  p_j2_telefono text default null,
  p_contacto smallint default 1,
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
  v_torneo jsonb;
  v_categoria jsonb;
  v_formato text;
  v_cupo int;
  v_disp jsonb;
  limpio text := '\s+';
  v_a1 text := nullif(btrim(regexp_replace(coalesce(p_j1_apellido, ''), limpio, ' ', 'g')), '');
  v_n1 text := nullif(btrim(regexp_replace(coalesce(p_j1_nombre, ''), limpio, ' ', 'g')), '');
  v_t1 text := public.normalizar_telefono_ar(p_j1_telefono);
  v_a2 text := nullif(btrim(regexp_replace(coalesce(p_j2_apellido, ''), limpio, ' ', 'g')), '');
  v_n2 text := nullif(btrim(regexp_replace(coalesce(p_j2_nombre, ''), limpio, ' ', 'g')), '');
  v_t2 text := public.normalizar_telefono_ar(p_j2_telefono);
  v_contacto smallint := coalesce(p_contacto, 1);
begin
  -- Honeypot: un bot lo completó. Se responde "ok" para no darle pistas, pero no se guarda nada.
  if coalesce(p_honeypot, '') <> '' then
    return 'ok';
  end if;

  select datos into v_torneo from torneos where id = p_torneo_id;
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
  if v_formato like 'super8%' and jsonb_array_length(coalesce(v_categoria->'groups', '[]'::jsonb)) > 0 then
    raise exception 'inscripciones_cerradas';
  end if;

  -- Súper 8 Individual: un solo jugador. En el resto, los dos con apellido, nombre y teléfono.
  if v_formato = 'super8_individual' then
    v_a2 := null; v_n2 := null; v_t2 := null; v_contacto := 1;
  elsif v_a2 is null or v_n2 is null then
    raise exception 'datos_invalidos';
  end if;
  if v_a1 is null or v_n1 is null
     or char_length(v_a1) > 40 or char_length(v_n1) > 40
     or char_length(coalesce(v_a2, '')) > 40 or char_length(coalesce(v_n2, '')) > 40
     or v_contacto not in (1, 2) then
    raise exception 'datos_invalidos';
  end if;
  if v_t1 is null or (v_formato <> 'super8_individual' and v_t2 is null) then
    raise exception 'telefono_invalido';
  end if;

  v_cupo := case when v_formato like 'super8%' then 8 else nullif(v_categoria->>'cupo', '')::int end;
  if v_cupo is not null and jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) >= v_cupo then
    raise exception 'cupo_completo';
  end if;

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
    insert into inscripciones (torneo_id, organizador_id, categoria_id,
      jugador1_nombre, jugador2_nombre, telefono,
      jugador1_apellido, jugador1_pila, telefono1, jugador2_apellido, jugador2_pila, telefono2, contacto,
      disponibilidad, cruce_mismo_dia)
    values (p_torneo_id, (v_torneo->>'organizerId')::uuid, p_categoria_id,
      v_a1 || ' ' || v_n1, case when v_a2 is null then null else v_a2 || ' ' || v_n2 end,
      case when v_contacto = 2 then v_t2 else v_t1 end,
      v_a1, v_n1, v_t1, v_a2, v_n2, v_t2, v_contacto,
      v_disp, p_cruce_mismo_dia);
  exception when unique_violation then
    raise exception 'duplicada';
  end;

  return 'ok';
end;
$$;
revoke all on function public.inscribir_pareja(text, text, text, text, text, text, text, text, smallint, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.inscribir_pareja(text, text, text, text, text, text, text, text, smallint, text, jsonb, boolean) to anon, authenticated;

-- ============================================================
-- Aceptar: igual que en 20261017_colaboradores_permisos.sql, más los jugadores con perfil
-- ============================================================

create or replace function public.aceptar_inscripcion(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ins inscripciones%rowtype;
  v_actual torneos%rowtype;
  v_ci int;
  v_ri int;
  v_categoria jsonb;
  v_formato text;
  v_pareja jsonb;
  v_resumen jsonb;
  v_players jsonb;
begin
  select * into v_ins from inscripciones where id = p_id for update;
  if not found or (v_ins.organizador_id is distinct from auth.uid() and not public.colaborador_de(v_ins.organizador_id::text, 'torneos')) then
    raise exception 'no_autorizado';
  end if;
  if v_ins.estado <> 'pendiente' then
    raise exception 'ya_resuelta';
  end if;

  -- Se bloquea el torneo para que nadie lo cambie mientras se agrega la pareja
  select * into v_actual from torneos where id = v_ins.torneo_id and datos->>'organizerId' = v_ins.organizador_id::text for update;
  if not found then
    raise exception 'torneo_no_encontrado';
  end if;

  select c.ord - 1, c.val into v_ci, v_categoria
  from jsonb_array_elements(coalesce(v_actual.datos->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
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

  -- Inscripción nueva (con apellido y teléfono de cada uno): cada jugador queda con su perfil.
  -- El teléfono NO se copia al torneo: los torneos son públicos; en la pareja va solo el ID.
  if v_ins.jugador1_apellido is not null and v_ins.telefono1 is not null then
    v_players := jsonb_build_array(jsonb_build_object(
      'id', public._perfil_para(v_ins.jugador1_apellido, v_ins.jugador1_pila, v_ins.telefono1),
      'name', v_ins.jugador1_nombre));
    if v_ins.jugador2_apellido is not null then
      v_players := v_players || jsonb_build_array(jsonb_build_object(
        'id', case when v_ins.telefono2 is null then null else public._perfil_para(v_ins.jugador2_apellido, v_ins.jugador2_pila, v_ins.telefono2) end,
        'name', v_ins.jugador2_nombre));
    end if;
  end if;

  -- Misma forma que una pareja cargada a mano
  v_pareja := jsonb_build_object(
    'id', substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    'name', case when v_ins.jugador2_nombre is null then v_ins.jugador1_nombre else v_ins.jugador1_nombre || ' / ' || v_ins.jugador2_nombre end,
    'availability', coalesce(v_ins.disponibilidad, '[]'::jsonb),
    'inscripcionId', v_ins.id
  );
  if v_players is not null then
    v_pareja := v_pareja || jsonb_build_object('players', v_players);
  end if;
  if v_ins.cruce_mismo_dia is not null then
    v_pareja := v_pareja || jsonb_build_object('sameDayBracket', v_ins.cruce_mismo_dia);
  end if;

  -- En el resumen, la categoría suma una pareja (si el torneo ya tiene resumen)
  v_resumen := v_actual.resumen;
  if v_resumen is not null then
    select c.ord - 1 into v_ri
    from jsonb_array_elements(coalesce(v_resumen->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
    where c.val->>'id' = v_ins.categoria_id;
    if v_ri is not null then
      v_resumen := jsonb_set(v_resumen, array['categories', v_ri::text, '_pairsCount'],
        to_jsonb(jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) + 1));
    end if;
  end if;

  update torneos
  set datos = jsonb_set(datos, array['categories', v_ci::text, 'pairs'], coalesce(v_categoria->'pairs', '[]'::jsonb) || jsonb_build_array(v_pareja)),
      resumen = v_resumen,
      rev = rev + 1, actualizado = now()
  where id = v_actual.id;
  perform public.espejar_torneos();

  update inscripciones set estado = 'aceptada', pareja_id = v_pareja->>'id', resuelta_at = now() where id = p_id;
  return v_pareja;
end;
$$;
revoke all on function public.aceptar_inscripcion(uuid) from public, anon, authenticated;
grant execute on function public.aceptar_inscripcion(uuid) to authenticated;

-- Vuelta atrás (si hiciera falta): volver a correr aceptar_inscripcion de 20261017 y crear_jugador
-- de 20261038, y
--   drop function if exists public.inscribir_pareja(text, text, text, text, text, text, text, text, smallint, text, jsonb, boolean);
--   drop function if exists public._perfil_para(text, text, text);
--   alter table public.inscripciones drop column if exists jugador1_apellido, drop column if exists jugador1_pila,
--     drop column if exists telefono1, drop column if exists jugador2_apellido, drop column if exists jugador2_pila,
--     drop column if exists telefono2, drop column if exists contacto;
