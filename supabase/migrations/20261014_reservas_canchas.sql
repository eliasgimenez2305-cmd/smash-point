-- Reserva de canchas, etapa 1: el complejo arma su agenda (canchas, horarios, precios, turnos
-- cargados a mano y bloqueos). Todavía no hay reservas del público: eso es la etapa 2 y va a entrar
-- por una función propia, sin abrir estas tablas.
--
-- - complejos: une la ficha pública del complejo (app_data 'sp:venues', mismo id) con la cuenta de
--   su dueño (un organizador) y dice si tiene la sección Reservas habilitada. Lo maneja el creador.
-- - canchas: cada cancha con su horario (apertura y cierre; si el cierre es igual o menor que la
--   apertura, cierra al día siguiente), y el precio de cada duración que ofrece (60, 90 o 120 min;
--   sin precio = no se ofrece). reserva_online = false para canchas que el público no puede pedir
--   (por ejemplo, las de clases); el complejo igual les carga turnos a mano.
-- - reservas: turnos y bloqueos (lluvia, mantenimiento, torneos) en la misma tabla, así la base
--   impide que se pisen: dos filas activas de la misma cancha no pueden superponerse. "fecha" es el
--   día de la grilla: un turno a la 1 de la mañana de una cancha que cierra pasada la medianoche es
--   del día anterior.
--
-- Seguridad: el público lee complejos y canchas (las va a necesitar la grilla pública), pero no
-- las reservas. Solo el dueño de un complejo habilitado modifica sus canchas y ve y maneja sus
-- reservas. Los bloqueos se pueden borrar; los turnos no (se cancelan, para que quede el registro).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create extension if not exists btree_gist;

create table if not exists public.complejos (
  id text primary key,
  dueno_id uuid references public.organizers(id) on delete set null,
  reservas_habilitadas boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.canchas (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 40),
  orden int not null default 0,
  activa boolean not null default true,
  reserva_online boolean not null default true,
  apertura time not null check (extract(minute from apertura) in (0, 30) and extract(second from apertura) = 0),
  cierre time not null check (extract(minute from cierre) in (0, 30) and extract(second from cierre) = 0),
  precio_60 numeric(10, 2) check (precio_60 is null or precio_60 >= 0),
  precio_90 numeric(10, 2) check (precio_90 is null or precio_90 >= 0),
  precio_120 numeric(10, 2) check (precio_120 is null or precio_120 >= 0),
  created_at timestamptz not null default now(),
  check (apertura <> cierre),
  unique (id, complejo_id)
);

create index if not exists canchas_por_complejo on public.canchas (complejo_id, orden);

create table if not exists public.reservas (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  cancha_id uuid not null,
  tipo text not null default 'turno' check (tipo in ('turno', 'bloqueo')),
  fecha date not null,
  inicio timestamptz not null,
  fin timestamptz not null,
  estado text not null default 'confirmada' check (estado in ('pendiente', 'confirmada', 'rechazada', 'cancelada', 'vencida')),
  origen text not null default 'manual' check (origen in ('manual', 'online')),
  nombre text check (nombre is null or char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  jugador_id uuid, -- etapa 2: el jugador logueado que la pidió
  precio numeric(10, 2) check (precio is null or precio >= 0),
  medio_pago text check (medio_pago is null or medio_pago in ('efectivo', 'mercado_pago')),
  no_vino boolean not null default false,
  nota text check (nota is null or char_length(nota) <= 200),
  vence_at timestamptz, -- etapa 2: hasta cuándo espera confirmación un pedido pendiente
  creada_por uuid default auth.uid(),
  created_at timestamptz not null default now(),
  cancelada_at timestamptz,
  foreign key (cancha_id, complejo_id) references public.canchas (id, complejo_id) on delete restrict,
  check (fin > inicio and fin - inicio <= interval '24 hours'),
  check (tipo = 'bloqueo' or nombre is not null),
  constraint reservas_sin_superponer exclude using gist (cancha_id with =, tstzrange(inicio, fin, '[)') with &&)
    where (estado in ('pendiente', 'confirmada'))
);

create index if not exists reservas_por_dia on public.reservas (complejo_id, fecha);

-- ¿El usuario logueado es el dueño de este complejo, y el complejo tiene Reservas habilitadas?
create or replace function public.es_dueno_complejo(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from complejos where id = p_complejo and dueno_id = auth.uid() and reservas_habilitadas);
$$;

revoke all on function public.es_dueno_complejo(text) from public, anon;
grant execute on function public.es_dueno_complejo(text) to authenticated;

alter table public.complejos enable row level security;
alter table public.canchas enable row level security;
alter table public.reservas enable row level security;

revoke all on public.complejos, public.canchas, public.reservas from public, anon, authenticated;
grant select on public.complejos, public.canchas to anon, authenticated;
grant insert, update, delete on public.complejos, public.canchas to authenticated;
grant select, insert, update, delete on public.reservas to authenticated;

-- complejos: lectura pública; altas, cambios y bajas solo el creador
drop policy if exists "Complejos visibles para todos" on public.complejos;
create policy "Complejos visibles para todos" on public.complejos for select to public using (true);
drop policy if exists "El creador administra los complejos" on public.complejos;
create policy "El creador administra los complejos" on public.complejos for all to authenticated
  using (public.es_creador()) with check (public.es_creador());

-- canchas: lectura pública; el dueño del complejo las administra
drop policy if exists "Canchas visibles para todos" on public.canchas;
create policy "Canchas visibles para todos" on public.canchas for select to public using (true);
drop policy if exists "El dueño crea canchas" on public.canchas;
create policy "El dueño crea canchas" on public.canchas for insert to authenticated
  with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia sus canchas" on public.canchas;
create policy "El dueño cambia sus canchas" on public.canchas for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra sus canchas" on public.canchas;
create policy "El dueño borra sus canchas" on public.canchas for delete to authenticated
  using (public.es_dueno_complejo(complejo_id));

-- reservas: solo el dueño del complejo; los turnos no se borran (se cancelan), los bloqueos sí
drop policy if exists "El dueño ve sus reservas" on public.reservas;
create policy "El dueño ve sus reservas" on public.reservas for select to authenticated
  using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño carga reservas" on public.reservas;
create policy "El dueño carga reservas" on public.reservas for insert to authenticated
  with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia sus reservas" on public.reservas;
create policy "El dueño cambia sus reservas" on public.reservas for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra sus bloqueos" on public.reservas;
create policy "El dueño borra sus bloqueos" on public.reservas for delete to authenticated
  using (public.es_dueno_complejo(complejo_id) and tipo = 'bloqueo');
