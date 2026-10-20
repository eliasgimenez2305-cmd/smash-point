-- Perfiles de jugador: cada jugador tiene un ID fijo que no cambia nunca, con su teléfono asociado.
-- Sirven para el ranking de los circuitos (suma por jugador aunque cambie de compañero o se escriba
-- distinto su nombre) y, más adelante, para que el jugador entre con su teléfono y reclame su perfil.
--
-- - perfiles_jugador: apellido, nombre y teléfono (opcional). Lo crea el organizador al anotar una
--   pareja con teléfono. cuenta_id queda vacío hasta que el jugador se registre (paso siguiente).
-- - Los teléfonos son privados: la tabla no se lee directo. El organizador busca por teléfono
--   exacto con buscar_jugadores() y crea con crear_jugador().
-- - En el torneo (que es público) solo se guarda el ID y el nombre de cada jugador, nunca el teléfono.
-- - Un mismo teléfono puede estar en varios perfiles (un padre que anota a sus hijos con su número).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261037.

create table if not exists public.perfiles_jugador (
  id uuid primary key default gen_random_uuid(),
  apellido text not null check (char_length(btrim(apellido)) between 1 and 40),
  nombre text not null default '' check (char_length(btrim(nombre)) <= 40),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  cuenta_id uuid unique references auth.users(id) on delete set null,
  creado_por uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists perfiles_por_telefono on public.perfiles_jugador (telefono) where telefono is not null;

alter table public.perfiles_jugador enable row level security;
revoke all on public.perfiles_jugador from public, anon, authenticated;

-- Quién puede anotar jugadores: los organizadores y los empleados con permiso de torneos
create or replace function public.puede_anotar_jugadores()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_organizador()
      or exists (select 1 from public.mis_complejos_colaborador() m where m.p_torneos);
$$;
revoke all on function public.puede_anotar_jugadores() from public, anon;
grant execute on function public.puede_anotar_jugadores() to authenticated;

-- "  Juan  PÉREZ " -> "juan perez" (para no crear dos veces el mismo perfil)
create or replace function public._nombre_normal(p text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(lower(translate(coalesce(p, ''), 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUaeiouu')), '\s+', ' ', 'g'));
$$;

-- Los perfiles con ese teléfono (puede haber más de uno), sin el teléfono
create or replace function public.buscar_jugadores(p_telefono text)
returns table (id uuid, apellido text, nombre text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.puede_anotar_jugadores() then
    raise exception 'no_autorizado';
  end if;
  return query
    select p.id, p.apellido, p.nombre
      from perfiles_jugador p
     where p.telefono = p_telefono
     order by p.created_at;
end;
$$;
revoke all on function public.buscar_jugadores(text) from public, anon;
grant execute on function public.buscar_jugadores(text) to authenticated;

-- Crea el perfil (o devuelve el que ya existe con ese teléfono y ese mismo nombre)
create or replace function public.crear_jugador(p_apellido text, p_nombre text, p_telefono text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.puede_anotar_jugadores() then
    raise exception 'no_autorizado';
  end if;
  if p_telefono is null or p_telefono !~ '^549[0-9]{10}$'
     or char_length(btrim(coalesce(p_apellido, ''))) not between 1 and 40
     or char_length(btrim(coalesce(p_nombre, ''))) > 40 then
    raise exception 'datos_invalidos';
  end if;
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
revoke all on function public.crear_jugador(text, text, text) from public, anon;
grant execute on function public.crear_jugador(text, text, text) to authenticated;

-- Vuelta atrás (si hiciera falta):
--   drop function if exists public.crear_jugador(text, text, text), public.buscar_jugadores(text),
--     public._nombre_normal(text), public.puede_anotar_jugadores();
--   drop table if exists public.perfiles_jugador;
