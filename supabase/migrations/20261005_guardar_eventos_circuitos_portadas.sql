-- Eventos, circuitos y portadas de organizadores: guardado de a un elemento, controlando de quién es.
--
-- Igual que pasaba con los torneos (ver 20261003_guardar_torneo.sql), la app subía la lista entera
-- de eventos o circuitos de todos los organizadores, o el mapa entero de portadas: el último en
-- guardar borraba lo de los demás, y cualquier usuario logueado podía cambiar lo de otro.
--
-- guardar_en_lista(p_clave, p_item): agrega o reemplaza un evento o circuito (por id) en su lista.
--   Un organizador solo puede guardar los suyos (organizerId); el creador, cualquiera.
-- borrar_de_lista(p_clave, p_id): lo mismo para borrar.
-- guardar_portada(p_organizador, p_url): la portada de un organizador (él mismo o el creador).
--
-- Se corre una vez en Supabase > SQL Editor, ANTES de publicar la versión de la app que lo usa.
-- Necesita public.es_creador(), de 20261003_guardar_torneo.sql.

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

create or replace function public.borrar_de_lista(p_clave text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lista jsonb;
  v_actual jsonb;
  v_yo text := auth.uid()::text;
begin
  if v_yo is null then
    raise exception 'no_autorizado';
  end if;
  if p_clave not in ('sp:events', 'sp:circuits') then
    raise exception 'clave_invalida';
  end if;

  select value into v_lista from app_data where key = p_clave for update;
  select t.val into v_actual from jsonb_array_elements(coalesce(v_lista, '[]'::jsonb)) as t(val) where t.val->>'id' = p_id;
  if v_actual is null then
    return jsonb_build_object('estado', 'ok'); -- ya no estaba
  end if;
  if not public.es_creador() and v_actual->>'organizerId' is distinct from v_yo then
    raise exception 'no_autorizado';
  end if;

  update app_data
  set value = (select coalesce(jsonb_agg(t.val order by t.ord), '[]'::jsonb)
               from jsonb_array_elements(v_lista) with ordinality as t(val, ord)
               where t.val->>'id' <> p_id),
      updated_at = now()
  where key = p_clave;
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
  if auth.uid() is null or (p_organizador is distinct from auth.uid() and not public.es_creador()) then
    raise exception 'no_autorizado';
  end if;

  select value into v_portadas from app_data where key = 'sp:organizer_covers' for update;
  v_portadas := coalesce(v_portadas, '{}'::jsonb) || jsonb_build_object(p_organizador::text, coalesce(p_url, ''));

  insert into app_data (key, value, updated_at) values ('sp:organizer_covers', v_portadas, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('estado', 'ok');
end;
$$;

revoke all on function public.guardar_en_lista(text, jsonb) from public, anon, authenticated;
revoke all on function public.borrar_de_lista(text, text) from public, anon, authenticated;
revoke all on function public.guardar_portada(uuid, text) from public, anon, authenticated;
grant execute on function public.guardar_en_lista(text, jsonb) to authenticated;
grant execute on function public.borrar_de_lista(text, text) to authenticated;
grant execute on function public.guardar_portada(uuid, text) to authenticated;
