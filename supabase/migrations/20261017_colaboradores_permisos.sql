-- Colaboradores con permisos por empleado. Necesita 20261014, 20261015 y 20261016.
--
-- Cada colaborador tiene sus interruptores (los elige el dueño):
--   p_agenda      Agenda de reservas: cargar, confirmar, cancelar, bloquear, "no vino", cobro.
--   p_resultados  Cargar resultados en los torneos del dueño (sets, W.O., retiro, en curso, horario
--                 de cada partido), sin cambiar la estructura del torneo.
--   p_torneos     Gestionar torneos del dueño: crearlos y editarlos (Súper 8, clásicos, grupos,
--                 llaves, horarios), eventos y circuitos, e inscripciones. Incluye cargar resultados.
--   p_canchas     Canchas y precios: horarios, precios, alta y baja de reserva online.
-- Siempre del dueño: borrar torneos, eventos y circuitos, la lista de colaboradores y sus permisos,
-- bloquear jugadores y el perfil del organizador. Lo que hace un colaborador en un torneo queda a
-- nombre del organizador dueño del complejo.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

alter table public.colaboradores
  add column if not exists p_agenda boolean not null default true,
  add column if not exists p_resultados boolean not null default false,
  add column if not exists p_torneos boolean not null default false,
  add column if not exists p_canchas boolean not null default false;

-- ¿El usuario logueado es colaborador de este complejo con ese permiso? ('resultados' también lo
-- tiene quien puede gestionar torneos)
create or replace function public.colaborador_permiso(p_complejo text, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from colaboradores c
    join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
    join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email
    where c.complejo_id = p_complejo
      and case p_permiso
            when 'agenda' then c.p_agenda
            when 'canchas' then c.p_canchas
            when 'resultados' then c.p_resultados or c.p_torneos
            when 'torneos' then c.p_torneos
            else false
          end
  );
$$;

-- ¿Es colaborador, con ese permiso, de algún complejo de este organizador? (para sus torneos)
create or replace function public.colaborador_de(p_organizador text, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from complejos x
    where x.dueno_id::text = p_organizador and public.colaborador_permiso(x.id, p_permiso)
  );
$$;

-- La agenda (políticas de reservas de 20261016) pasa a pedir el permiso de agenda
create or replace function public.es_colaborador(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.colaborador_permiso(p_complejo, 'agenda');
$$;

revoke all on function public.colaborador_permiso(text, text) from public, anon;
revoke all on function public.colaborador_de(text, text) from public, anon;
grant execute on function public.colaborador_permiso(text, text) to authenticated;
grant execute on function public.colaborador_de(text, text) to authenticated;

-- Complejos donde el usuario logueado es colaborador, con su dueño y sus permisos (arma su panel)
drop function if exists public.mis_complejos_colaborador();
create function public.mis_complejos_colaborador()
returns table (complejo_id text, dueno_id uuid, p_agenda boolean, p_resultados boolean, p_torneos boolean, p_canchas boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.complejo_id, x.dueno_id, c.p_agenda, c.p_resultados, c.p_torneos, c.p_canchas
  from colaboradores c
  join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
  join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email;
$$;

revoke all on function public.mis_complejos_colaborador() from public, anon;
grant execute on function public.mis_complejos_colaborador() to authenticated;

-- ============================================================
-- Canchas y precios
-- ============================================================

drop policy if exists "El colaborador crea canchas" on public.canchas;
create policy "El colaborador crea canchas" on public.canchas for insert to authenticated
  with check (public.colaborador_permiso(complejo_id, 'canchas'));
drop policy if exists "El colaborador cambia canchas" on public.canchas;
create policy "El colaborador cambia canchas" on public.canchas for update to authenticated
  using (public.colaborador_permiso(complejo_id, 'canchas')) with check (public.colaborador_permiso(complejo_id, 'canchas'));

-- ============================================================
-- Torneos (igual que en 20261015_reservas_jugadores.sql, más los colaboradores)
-- ============================================================

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
  if v_yo is null then
    raise exception 'no_autorizado';
  end if;
  if jsonb_typeof(p_torneo) <> 'object' or coalesce(p_torneo->>'id', '') = '' then
    raise exception 'datos_invalidos';
  end if;

  select * into v_actual from torneos where id = p_torneo->>'id' for update;

  if not found then
    -- Torneo nuevo: a nombre de quien lo crea, o del dueño si lo crea un colaborador (o el creador)
    if not v_creador
       and not (p_torneo->>'organizerId' = v_yo and public.es_organizador())
       and not public.colaborador_de(p_torneo->>'organizerId', 'torneos') then
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
    -- Torneo existente: su organizador o un colaborador con permiso (sin pasárselo a otro), o el creador
    if not v_creador and (
         p_torneo->>'organizerId' is distinct from v_actual.datos->>'organizerId'
         or not ((v_actual.datos->>'organizerId' = v_yo and public.es_organizador())
                 or public.colaborador_de(v_actual.datos->>'organizerId', 'torneos'))
       ) then
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

-- Igual que en 20261009_tabla_torneos.sql, con los colaboradores que cargan resultados
create or replace function public.guardar_partidos(p_torneo_id text, p_cambios jsonb, p_rev_conocida int default null, p_resumen jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actual torneos%rowtype;
  v_datos jsonb;
  v_yo text := auth.uid()::text;
  v_cambio jsonb;
  v_ci int;
  v_path text[];
  v_clave text;
  v_omitidos jsonb := '[]'::jsonb;
  v_rev int;
  v_permitidas text[] := array['sets', 'walkover', 'retired', 'liveStatus', 'schedule'];
begin
  if v_yo is null then
    raise exception 'no_autorizado';
  end if;
  if jsonb_typeof(p_cambios) <> 'array' then
    raise exception 'datos_invalidos';
  end if;

  select * into v_actual from torneos where id = p_torneo_id for update;
  if not found then
    raise exception 'torneo_no_encontrado';
  end if;
  if not public.es_creador() and v_actual.datos->>'organizerId' is distinct from v_yo
     and not public.colaborador_de(v_actual.datos->>'organizerId', 'resultados') then
    raise exception 'no_autorizado';
  end if;

  v_datos := v_actual.datos;
  for v_cambio in select value from jsonb_array_elements(p_cambios) loop
    v_path := null;
    select c.ord - 1 into v_ci
    from jsonb_array_elements(coalesce(v_datos->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
    where c.val->>'id' = v_cambio->>'categoria';

    if v_ci is not null then
      -- En los grupos
      select array['categories', v_ci::text, 'groups', (g.ord - 1)::text, 'matches', (m.ord - 1)::text] into v_path
      from jsonb_array_elements(coalesce(v_datos->'categories'->v_ci->'groups', '[]'::jsonb)) with ordinality as g(val, ord),
           jsonb_array_elements(coalesce(g.val->'matches', '[]'::jsonb)) with ordinality as m(val, ord)
      where m.val->>'id' = v_cambio->>'partido'
      limit 1;
      -- O en la llave
      if v_path is null and jsonb_typeof(v_datos->'categories'->v_ci->'bracket') = 'array' then
        select array['categories', v_ci::text, 'bracket', (r.ord - 1)::text, (m.ord - 1)::text] into v_path
        from jsonb_array_elements(v_datos->'categories'->v_ci->'bracket') with ordinality as r(val, ord),
             jsonb_array_elements(r.val) with ordinality as m(val, ord)
        where m.val->>'id' = v_cambio->>'partido'
        limit 1;
      end if;
    end if;

    if v_path is null then
      v_omitidos := v_omitidos || jsonb_build_array(v_cambio->>'partido');
      continue;
    end if;

    for v_clave in select jsonb_object_keys(coalesce(v_cambio->'cambios', '{}'::jsonb)) loop
      if v_clave = any(v_permitidas) then
        v_datos := jsonb_set(v_datos, v_path || v_clave, v_cambio->'cambios'->v_clave, true);
      end if;
    end loop;
  end loop;

  v_rev := v_actual.rev + 1;
  update torneos set datos = v_datos, resumen = coalesce(p_resumen, resumen), rev = v_rev, actualizado = now()
  where id = v_actual.id;
  perform public.espejar_torneos();

  return jsonb_build_object(
    'estado', 'ok',
    'rev', v_rev,
    'omitidos', v_omitidos,
    -- Si alguien más guardó desde la versión que tenía el celular, el torneo entero
    'torneo', case when p_rev_conocida is distinct from v_actual.rev then v_datos || jsonb_build_object('rev', v_rev) end
  );
end;
$$;

-- Eventos y circuitos: igual que en 20261015, más los colaboradores que gestionan torneos (a nombre
-- del dueño). Borrarlos sigue siendo solo del dueño (borrar_de_lista no cambia).
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
  if v_yo is null then
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

  if not v_creador and (
       (v_actual is not null and v_actual->>'organizerId' is distinct from p_item->>'organizerId')
       or not ((p_item->>'organizerId' = v_yo and public.es_organizador())
               or public.colaborador_de(p_item->>'organizerId', 'torneos'))
     ) then
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

-- ============================================================
-- Inscripciones: las ve y resuelve también el colaborador que gestiona torneos
-- ============================================================

drop policy if exists "colaborador ve inscripciones" on public.inscripciones;
create policy "colaborador ve inscripciones" on public.inscripciones for select to authenticated
  using (public.colaborador_de(organizador_id::text, 'torneos'));

-- Igual que en 20261013_resumen_al_aceptar.sql, con el colaborador
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

  -- Misma forma que una pareja cargada a mano. El teléfono NO se copia: los torneos son públicos.
  v_pareja := jsonb_build_object(
    'id', substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    'name', case when v_ins.jugador2_nombre is null then v_ins.jugador1_nombre else v_ins.jugador1_nombre || ' / ' || v_ins.jugador2_nombre end,
    'availability', coalesce(v_ins.disponibilidad, '[]'::jsonb),
    'inscripcionId', v_ins.id
  );
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

create or replace function public.rechazar_inscripcion(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ins inscripciones%rowtype;
begin
  select * into v_ins from inscripciones where id = p_id for update;
  if not found or (v_ins.organizador_id is distinct from auth.uid() and not public.colaborador_de(v_ins.organizador_id::text, 'torneos')) then
    raise exception 'no_autorizado';
  end if;
  if v_ins.estado <> 'pendiente' then
    raise exception 'ya_resuelta';
  end if;
  update inscripciones set estado = 'rechazada', resuelta_at = now() where id = p_id;
  return 'ok';
end;
$$;

-- ============================================================
-- Imágenes: también las suben los colaboradores que gestionan torneos (portadas de torneos y eventos)
-- ============================================================

create or replace function public.puede_subir_imagenes()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_organizador()
      or exists (select 1 from complejos x where public.colaborador_permiso(x.id, 'torneos'));
$$;

revoke all on function public.puede_subir_imagenes() from public, anon;
grant execute on function public.puede_subir_imagenes() to authenticated;

drop policy if exists "Solo organizadores suben imagenes" on storage.objects;
create policy "Solo organizadores suben imagenes" on storage.objects
  for insert to authenticated with check (bucket_id = 'images' and public.puede_subir_imagenes());
