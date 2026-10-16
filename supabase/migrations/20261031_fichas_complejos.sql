-- Ficha pública de cada complejo (la tarjeta de "Reservá tu cancha"): portada propia, galería de
-- hasta 5 fotos, tipo de canchas, si son techadas, iluminación y servicios. La carga el dueño del
-- complejo desde Perfil (o el creador); la ve todo el mundo.
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261030_talles_codigo_rubros.sql. Vuelta atrás: al final.

create table if not exists public.complejo_fichas (
  complejo_id text primary key references public.complejos(id) on delete cascade,
  portada_url text check (portada_url is null or (portada_url ~ '^https://' and char_length(portada_url) <= 500)),
  fotos text[] not null default '{}' check (cardinality(fotos) <= 5),
  tipo_canchas text check (tipo_canchas is null or tipo_canchas in ('cristal', 'muro', 'mixto')),
  techadas text check (techadas is null or techadas in ('techadas', 'descubiertas', 'mixto')),
  iluminacion text check (iluminacion is null or iluminacion in ('led', 'comun', 'sin')),
  servicios text[] not null default '{}'
    check (servicios <@ array['cantina', 'vestuarios', 'duchas', 'estacionamiento', 'paletas', 'wifi']::text[]),
  updated_at timestamptz not null default now()
);

-- Cada foto de la galería, una dirección https
create or replace function public.ficha_al_guardar()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from unnest(new.fotos) f where f is null or f !~ '^https://' or char_length(f) > 500) then
    raise exception 'foto_invalida';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists ficha_al_guardar on public.complejo_fichas;
create trigger ficha_al_guardar before insert or update on public.complejo_fichas
  for each row execute function public.ficha_al_guardar();

alter table public.complejo_fichas enable row level security;
revoke all on public.complejo_fichas from public, anon, authenticated;
grant select on public.complejo_fichas to anon, authenticated;
grant insert, update, delete on public.complejo_fichas to authenticated;

drop policy if exists "Fichas visibles para todos" on public.complejo_fichas;
create policy "Fichas visibles para todos" on public.complejo_fichas for select to public using (true);
drop policy if exists "El dueño carga su ficha" on public.complejo_fichas;
create policy "El dueño carga su ficha" on public.complejo_fichas for insert to authenticated
  with check (public.es_dueno_complejo(complejo_id) or public.es_creador());
drop policy if exists "El dueño cambia su ficha" on public.complejo_fichas;
create policy "El dueño cambia su ficha" on public.complejo_fichas for update to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.es_creador())
  with check (public.es_dueno_complejo(complejo_id) or public.es_creador());
drop policy if exists "El dueño borra su ficha" on public.complejo_fichas;
create policy "El dueño borra su ficha" on public.complejo_fichas for delete to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.es_creador());

-- ============================================================
-- Vuelta atrás (correr a mano si hiciera falta):
--   drop table if exists public.complejo_fichas;
--   drop function if exists public.ficha_al_guardar();
-- ============================================================
