-- Caja de la plataforma (solo el creador): lo que cobra Smash Point a sus clientes y sus gastos.
-- Necesita es_creador() (20261003_guardar_torneo.sql).
--
-- - plataforma_clientes: cada cliente, vinculado si se puede con lo que ya está en la app (una
--   publicidad, un organizador, un profe o un complejo: tipo + ref_id), con su cuota mensual si
--   tiene (null = sin cuota, solo cobros sueltos) y desde qué mes la paga.
-- - plataforma_movimientos: ingresos (cuotas o cobros sueltos) y gastos (Netlify, dominio, mails…).
--   Un ingreso de cuota dice qué mes paga (periodo = 'AAAA-MM'); así se sabe quién debe cada mes.
-- Nadie más que el creador ve ni toca estas tablas.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create table if not exists public.plataforma_clientes (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('publicidad', 'organizador', 'profe', 'complejo', 'otro')),
  ref_id text, -- id de la publicidad, organizador, profe o complejo (null en "otro")
  nombre text not null check (char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  cuota_mensual numeric(12, 2) check (cuota_mensual is null or cuota_mensual > 0),
  desde text not null default to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM') check (desde ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  activo boolean not null default true,
  nota text check (nota is null or char_length(nota) <= 200),
  created_at timestamptz not null default now()
);

create table if not exists public.plataforma_movimientos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  cliente_id uuid references public.plataforma_clientes(id) on delete set null,
  periodo text check (periodo is null or periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), -- mes de cuota que paga
  concepto text not null check (char_length(btrim(concepto)) between 1 and 80),
  monto numeric(12, 2) not null check (monto > 0 and monto < 1000000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  fecha date not null,
  created_at timestamptz not null default now(),
  check (tipo = 'ingreso' or (cliente_id is null and periodo is null))
);

create index if not exists plataforma_movimientos_fecha on public.plataforma_movimientos (fecha);
create index if not exists plataforma_movimientos_periodo on public.plataforma_movimientos (cliente_id, periodo);

alter table public.plataforma_clientes enable row level security;
alter table public.plataforma_movimientos enable row level security;
revoke all on public.plataforma_clientes, public.plataforma_movimientos from public, anon, authenticated;
grant select, insert, update, delete on public.plataforma_clientes, public.plataforma_movimientos to authenticated;

drop policy if exists "Solo el creador: clientes" on public.plataforma_clientes;
create policy "Solo el creador: clientes" on public.plataforma_clientes for all to authenticated
  using (public.es_creador()) with check (public.es_creador());
drop policy if exists "Solo el creador: movimientos" on public.plataforma_movimientos;
create policy "Solo el creador: movimientos" on public.plataforma_movimientos for all to authenticated
  using (public.es_creador()) with check (public.es_creador());
