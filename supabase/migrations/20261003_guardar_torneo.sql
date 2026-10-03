-- Guardado de a un torneo por vez, con número de versión (rev), para que dos personas guardando a
-- la vez no se pisen. Hasta ahora la app subía la lista entera de torneos (app_data
-- 'sp:tournaments') y el último en guardar borraba lo que habían guardado los demás.
--
-- guardar_torneo(p_torneo, p_rev): reemplaza solo ese torneo dentro de la lista. Si la versión
--   guardada no es p_rev (alguien guardó antes), no escribe y devuelve la versión actual para que
--   la app mezcle los cambios (ver src/merge.js). Un organizador solo puede guardar sus torneos; el
--   creador, cualquiera (incluidos los informativos, que no tienen organizador).
-- borrar_torneo(p_id): lo mismo para borrar.
-- aceptar_inscripcion: igual que antes, y además sube la versión del torneo al agregar la pareja.
--
-- Se corre una vez en Supabase > SQL Editor, ANTES de publicar la versión de la app que lo usa.

-- ¿El usuario logueado es el creador (administración)?
create or replace function public.es_creador()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from organizers where id = auth.uid() and role = 'creador');
$$;

create or replace function public.guardar_torneo(p_torneo jsonb, p_rev int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_torneos jsonb;
  v_ti int;
  v_actual jsonb;
  v_rev int;
  v_nuevo jsonb;
  v_yo text := auth.uid()::text;
  v_creador boolean := public.es_creador();
begin
  if v_yo is null then
    raise exception 'no_autorizado';
  end if;
  if jsonb_typeof(p_torneo) <> 'object' or coalesce(p_torneo->>'id', '') = '' then
    raise exception 'datos_invalidos';
  end if;

  -- Se bloquea la fila de torneos mientras se guarda (como en aceptar_inscripcion)
  select value into v_torneos from app_data where key = 'sp:tournaments' for update;
  v_torneos := coalesce(v_torneos, '[]'::jsonb);

  select t.ord - 1, t.val into v_ti, v_actual
  from jsonb_array_elements(v_torneos) with ordinality as t(val, ord)
  where t.val->>'id' = p_torneo->>'id';

  if v_actual is null then
    -- Torneo nuevo: a nombre de quien lo crea (salvo el creador)
    if not v_creador and p_torneo->>'organizerId' is distinct from v_yo then
      raise exception 'no_autorizado';
    end if;
    v_nuevo := p_torneo || jsonb_build_object('rev', 1);
    v_torneos := v_torneos || jsonb_build_array(v_nuevo);
  else
    -- Torneo existente: solo su organizador (y no puede pasárselo a otro), o el creador
    if not v_creador and (v_actual->>'organizerId' is distinct from v_yo or p_torneo->>'organizerId' is distinct from v_yo) then
      raise exception 'no_autorizado';
    end if;
    v_rev := coalesce((v_actual->>'rev')::int, 0);
    if v_rev <> coalesce(p_rev, 0) then
      return jsonb_build_object('estado', 'conflicto', 'torneo', v_actual);
    end if;
    v_nuevo := p_torneo || jsonb_build_object('rev', v_rev + 1);
    v_torneos := jsonb_set(v_torneos, array[v_ti::text], v_nuevo);
  end if;

  insert into app_data (key, value, updated_at) values ('sp:tournaments', v_torneos, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return jsonb_build_object('estado', 'ok', 'rev', (v_nuevo->>'rev')::int);
end;
$$;

create or replace function public.borrar_torneo(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_torneos jsonb;
  v_actual jsonb;
  v_yo text := auth.uid()::text;
begin
  if v_yo is null then
    raise exception 'no_autorizado';
  end if;

  select value into v_torneos from app_data where key = 'sp:tournaments' for update;
  select t.val into v_actual from jsonb_array_elements(coalesce(v_torneos, '[]'::jsonb)) as t(val) where t.val->>'id' = p_id;
  if v_actual is null then
    return jsonb_build_object('estado', 'ok'); -- ya no estaba
  end if;
  if not public.es_creador() and v_actual->>'organizerId' is distinct from v_yo then
    raise exception 'no_autorizado';
  end if;

  update app_data
  set value = (select coalesce(jsonb_agg(t.val order by t.ord), '[]'::jsonb)
               from jsonb_array_elements(v_torneos) with ordinality as t(val, ord)
               where t.val->>'id' <> p_id),
      updated_at = now()
  where key = 'sp:tournaments';

  return jsonb_build_object('estado', 'ok');
end;
$$;

-- Aceptar: igual que en 20260929_inscripciones_disponibilidad.sql, y además sube la versión del
-- torneo, para que un guardado hecho sobre la versión anterior no borre la pareja recién aceptada.
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
  v_torneos := jsonb_set(v_torneos, array[v_ti::text, 'rev'], to_jsonb(coalesce((v_torneos->v_ti->>'rev')::int, 0) + 1));

  update app_data set value = v_torneos, updated_at = now() where key = 'sp:tournaments';
  update inscripciones set estado = 'aceptada', pareja_id = v_pareja->>'id', resuelta_at = now() where id = p_id;

  return v_pareja;
end;
$$;

-- Permisos: guardar y borrar torneos es de usuarios logueados (la función controla de quién es cada torneo)
revoke all on function public.es_creador() from public, anon;
revoke all on function public.guardar_torneo(jsonb, int) from public, anon, authenticated;
revoke all on function public.borrar_torneo(text) from public, anon, authenticated;
grant execute on function public.es_creador() to authenticated;
grant execute on function public.guardar_torneo(jsonb, int) to authenticated;
grant execute on function public.borrar_torneo(text) to authenticated;
