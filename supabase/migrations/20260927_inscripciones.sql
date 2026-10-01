-- Inscripciones online de parejas (o jugadores sueltos en el Súper 8 Individual).
--
-- Contexto: los torneos NO están en tablas propias. Toda la lista de torneos vive en una sola fila de
-- app_data (key = 'sp:tournaments', value = jsonb con un array de torneos). Cada torneo trae su
-- organizerId (= auth.users.id del organizador), sus categorías y, dentro de cada categoría, sus
-- parejas. Por eso:
--   - "inscripciones abiertas" es un campo del torneo en ese JSON (inscripcionesAbiertas) y el cupo es
--     un campo de cada categoría (cupo). El Súper 8 tiene cupo fijo de 8.
--   - Las validaciones (abierto, cupo, categoría) y el alta de la pareja al aceptar se hacen en
--     funciones SECURITY DEFINER que leen y modifican ese JSON.
--
-- Seguridad:
--   - anon no puede leer, insertar, modificar ni borrar la tabla: solo puede llamar a
--     crear_inscripcion(), que guarda siempre en estado 'pendiente'.
--   - El organizador solo ve las inscripciones de sus torneos y solo puede aceptarlas o rechazarlas
--     con aceptar_inscripcion() / rechazar_inscripcion(). Nadie puede borrar inscripciones.
--
-- Correr una sola vez en el SQL Editor de Supabase.

create table if not exists public.inscripciones (
  id uuid primary key default gen_random_uuid(),
  torneo_id text not null,
  organizador_id uuid not null,
  categoria_id text not null,
  jugador1_nombre text not null check (char_length(jugador1_nombre) between 3 and 80),
  jugador2_nombre text check (jugador2_nombre is null or char_length(jugador2_nombre) between 3 and 80),
  telefono text not null check (telefono ~ '^549[0-9]{10}$'),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptada', 'rechazada')),
  pareja_id text,
  created_at timestamptz not null default now(),
  resuelta_at timestamptz
);

-- Sin duplicados: mismo WhatsApp, mismo torneo y misma categoría mientras esté pendiente o aceptada
create unique index if not exists inscripciones_sin_duplicados
  on public.inscripciones (torneo_id, categoria_id, telefono)
  where estado in ('pendiente', 'aceptada');

create index if not exists inscripciones_por_organizador on public.inscripciones (organizador_id, estado, created_at);

alter table public.inscripciones enable row level security;

revoke all on public.inscripciones from public, anon, authenticated;
grant select on public.inscripciones to authenticated;

drop policy if exists "organizador ve sus inscripciones" on public.inscripciones;
create policy "organizador ve sus inscripciones" on public.inscripciones
  for select to authenticated
  using (organizador_id = auth.uid());

-- Normaliza un WhatsApp argentino a 549 + característica + número (13 dígitos, formato wa.me).
-- El formulario ya manda el número limpio; esto es la última validación del lado del servidor.
create or replace function public.normalizar_telefono_ar(p text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d like '549%' and length(d) = 13 then return d; end if;
  if d like '54%' and length(d) = 12 then return '549' || substr(d, 3); end if;
  if d like '0%' then d := substr(d, 2); end if;
  if length(d) = 10 then return '549' || d; end if;
  return null;
end;
$$;

-- Alta pública de una inscripción. Devuelve 'ok' o corta con un error que la app traduce:
-- inscripciones_cerradas, categoria_invalida, cupo_completo, datos_invalidos, telefono_invalido, duplicada.
create or replace function public.crear_inscripcion(
  p_torneo_id text,
  p_categoria_id text,
  p_jugador1 text,
  p_jugador2 text,
  p_telefono text,
  p_honeypot text default null
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

  begin
    insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono)
    values (p_torneo_id, (v_torneo->>'organizerId')::uuid, p_categoria_id, v_j1, v_j2, v_tel);
  exception when unique_violation then
    raise exception 'duplicada';
  end;

  return 'ok';
end;
$$;

-- Aceptar: agrega la pareja a la categoría del torneo (dentro del JSON de app_data) y marca la
-- inscripción como aceptada, todo en la misma transacción. Solo el organizador dueño del torneo.
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
    'availability', '[]'::jsonb,
    'inscripcionId', v_ins.id
  );

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
  if not found or v_ins.organizador_id is distinct from auth.uid() then
    raise exception 'no_autorizado';
  end if;
  if v_ins.estado <> 'pendiente' then
    raise exception 'ya_resuelta';
  end if;
  update inscripciones set estado = 'rechazada', resuelta_at = now() where id = p_id;
  return 'ok';
end;
$$;

-- Permisos de ejecución: las funciones nacen ejecutables por PUBLIC y, en Supabase, además por anon y
-- authenticated (privilegios por defecto del esquema public), así que se restringen a mano
revoke all on function public.normalizar_telefono_ar(text) from public, anon, authenticated;
revoke all on function public.crear_inscripcion(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.aceptar_inscripcion(uuid) from public, anon, authenticated;
revoke all on function public.rechazar_inscripcion(uuid) from public, anon, authenticated;

grant execute on function public.crear_inscripcion(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.aceptar_inscripcion(uuid) to authenticated;
grant execute on function public.rechazar_inscripcion(uuid) to authenticated;
