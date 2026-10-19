-- Clases con profes, en los dos modos:
--   - "alquila": el profe le alquila la cancha al complejo. Cada clase es una reserva (tipo 'clase')
--     con el precio del alquiler; se cobra como un turno (medio_pago) y lo que no se cobró es lo que
--     debe el profe. Los alumnos le pagan al profe por fuera.
--   - "complejo": el complejo cobra la cuota a cada alumno (cuotas_alumnos, una por mes) y le paga
--     al profe por clase dictada (pagos_profes).
--
-- - reservas: tipo 'clase' y profe_id. La clase ocupa la cancha igual que un turno.
-- - profes_complejo: los profes de cada complejo, su modo y precios.
-- - alumnos, cuotas_alumnos, pagos_profes.
-- - _resumen_turno (caja del día) suma también las cuotas cobradas por cada persona.
--
-- Manejan profes y pagos a profes: el dueño. Ven profes y alumnos, cargan alumnos y cobran cuotas:
-- el dueño y los empleados con permiso de agenda. Las clases (reservas) las cargan los mismos que
-- cargan turnos.
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261027.

-- ============================================================
-- Profes y clases en la agenda
-- ============================================================

create table if not exists public.profes_complejo (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  modo text not null check (modo in ('alquila', 'complejo')),
  precio_hora numeric(10, 2) check (precio_hora is null or precio_hora >= 0), -- alquila: lo que paga por hora de cancha
  pago_clase numeric(10, 2) check (pago_clase is null or pago_clase >= 0),   -- complejo: lo que se le paga por clase dictada
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, complejo_id)
);

alter table public.reservas drop constraint if exists reservas_tipo_check;
alter table public.reservas add constraint reservas_tipo_check check (tipo in ('turno', 'bloqueo', 'clase'));
alter table public.reservas add column if not exists profe_id uuid;
alter table public.reservas drop constraint if exists reservas_profe_fk;
alter table public.reservas add constraint reservas_profe_fk foreign key (profe_id, complejo_id)
  references public.profes_complejo (id, complejo_id) on delete set null (profe_id);
create index if not exists reservas_por_profe on public.reservas (profe_id, fecha) where profe_id is not null;

-- ============================================================
-- Alumnos y cuotas (modo complejo)
-- ============================================================

create table if not exists public.alumnos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  profe_id uuid not null,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  cuota numeric(10, 2) not null check (cuota >= 0),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, complejo_id),
  foreign key (profe_id, complejo_id) references public.profes_complejo (id, complejo_id) on delete cascade
);

create table if not exists public.cuotas_alumnos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  alumno_id uuid not null,
  periodo text not null check (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  monto numeric(10, 2) not null check (monto > 0 and monto < 100000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  cobrado_por uuid not null default auth.uid(),
  cobrado_por_email text,
  created_at timestamptz not null default now(),
  unique (alumno_id, periodo),
  foreign key (alumno_id, complejo_id) references public.alumnos (id, complejo_id) on delete cascade
);
create index if not exists cuotas_por_complejo on public.cuotas_alumnos (complejo_id, created_at);

create table if not exists public.pagos_profes (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  profe_id uuid not null,
  periodo text not null check (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  monto numeric(12, 2) not null check (monto > 0 and monto < 1000000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  nota text check (nota is null or char_length(nota) <= 200),
  created_at timestamptz not null default now(),
  foreign key (profe_id, complejo_id) references public.profes_complejo (id, complejo_id) on delete cascade
);
create index if not exists pagos_profes_por_complejo on public.pagos_profes (complejo_id, created_at);

-- Quién cobró la cuota (de la sesión, no del navegador)
create or replace function public.cuota_quien()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.cobrado_por := auth.uid();
  new.cobrado_por_email := (select email from auth.users where id = auth.uid());
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists cuota_quien on public.cuotas_alumnos;
create trigger cuota_quien before insert on public.cuotas_alumnos
  for each row execute function public.cuota_quien();

-- ============================================================
-- Caja del día: también las cuotas que cobró cada persona
-- ============================================================

create or replace function public._resumen_turno(p_turno uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t caja_turnos%rowtype;
  v_dueno uuid;
  v_hasta timestamptz;
  v_por_medio jsonb;
  v_por_origen jsonb;
  v_efectivo numeric;
  v_ing numeric;
  v_ret numeric;
  v_gas numeric;
begin
  select * into t from caja_turnos where id = p_turno;
  v_hasta := coalesce(t.cerrada_at, now());
  select dueno_id into v_dueno from complejos where id = t.complejo_id;

  with cobros (origen, medio, monto) as (
    select 'mostrador', p.medio, p.monto
      from venta_pagos p join ventas v on v.id = p.venta_id
     where v.complejo_id = t.complejo_id and v.vendido_por = t.usuario and not v.anulada
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'cuentas', p.medio, p.monto
      from cuenta_pagos p
     where p.complejo_id = t.complejo_id and p.cobrado_por = t.usuario
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'inscripciones', p.medio, p.monto
      from pagos_inscripcion p
     where p.organizador_id = v_dueno and p.cobrado_por = t.usuario
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'turnos', r.medio_pago, r.precio
      from reservas r
     where r.complejo_id = t.complejo_id and r.cobrado_por = t.usuario and r.estado = 'confirmada'
       and r.precio is not null and r.precio > 0
       and r.cobrado_at >= t.abierta_at and r.cobrado_at <= v_hasta
    union all
    select 'clases', q.medio, q.monto
      from cuotas_alumnos q
     where q.complejo_id = t.complejo_id and q.cobrado_por = t.usuario
       and q.created_at >= t.abierta_at and q.created_at <= v_hasta
  )
  select
    (select coalesce(jsonb_object_agg(medio, total), '{}'::jsonb) from (select medio, sum(monto) as total from cobros group by medio) a),
    (select coalesce(jsonb_object_agg(origen, total), '{}'::jsonb) from (select origen, sum(monto) as total from cobros group by origen) b),
    (select coalesce(sum(monto), 0) from cobros where medio = 'efectivo')
  into v_por_medio, v_por_origen, v_efectivo;

  select coalesce(sum(monto) filter (where tipo = 'ingreso'), 0),
         coalesce(sum(monto) filter (where tipo = 'retiro'), 0),
         coalesce(sum(monto) filter (where tipo = 'gasto'), 0)
    into v_ing, v_ret, v_gas
    from caja_movimientos_turno where turno_id = t.id;

  return jsonb_build_object(
    'por_medio', v_por_medio, 'por_origen', v_por_origen,
    'fondo', t.fondo, 'efectivo_cobrado', v_efectivo,
    'ingresos', v_ing, 'retiros', v_ret, 'gastos', v_gas,
    'efectivo_esperado', t.fondo + v_efectivo + v_ing - v_ret - v_gas
  );
end;
$$;

revoke all on function public._resumen_turno(uuid) from public, anon, authenticated;

-- ============================================================
-- Permisos
-- ============================================================

alter table public.profes_complejo enable row level security;
alter table public.alumnos enable row level security;
alter table public.cuotas_alumnos enable row level security;
alter table public.pagos_profes enable row level security;
revoke all on public.profes_complejo, public.alumnos, public.cuotas_alumnos, public.pagos_profes from public, anon, authenticated;
grant select, insert, update, delete on public.profes_complejo, public.alumnos, public.pagos_profes to authenticated;
grant select, insert, delete on public.cuotas_alumnos to authenticated;

-- profes: los ven el dueño y los empleados con agenda; los maneja el dueño
drop policy if exists "Ven profes" on public.profes_complejo;
create policy "Ven profes" on public.profes_complejo for select to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "El dueño carga profes" on public.profes_complejo;
create policy "El dueño carga profes" on public.profes_complejo for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia profes" on public.profes_complejo;
create policy "El dueño cambia profes" on public.profes_complejo for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra profes" on public.profes_complejo;
create policy "El dueño borra profes" on public.profes_complejo for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- alumnos: los ven, cargan y corrigen el dueño y los empleados con agenda; borrarlos, el dueño
drop policy if exists "Ven alumnos" on public.alumnos;
create policy "Ven alumnos" on public.alumnos for select to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "Cargan alumnos" on public.alumnos;
create policy "Cargan alumnos" on public.alumnos for insert to authenticated
  with check (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "Corrigen alumnos" on public.alumnos;
create policy "Corrigen alumnos" on public.alumnos for update to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'))
  with check (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "El dueño borra alumnos" on public.alumnos;
create policy "El dueño borra alumnos" on public.alumnos for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- cuotas: las ven y cobran el dueño y los empleados con agenda; anularlas, el dueño
drop policy if exists "Ven cuotas" on public.cuotas_alumnos;
create policy "Ven cuotas" on public.cuotas_alumnos for select to authenticated
  using (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "Cobran cuotas" on public.cuotas_alumnos;
create policy "Cobran cuotas" on public.cuotas_alumnos for insert to authenticated
  with check (public.es_dueno_complejo(complejo_id) or public.colaborador_permiso(complejo_id, 'agenda'));
drop policy if exists "El dueño anula cuotas" on public.cuotas_alumnos;
create policy "El dueño anula cuotas" on public.cuotas_alumnos for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- pagos a profes: solo el dueño
drop policy if exists "El dueño paga a los profes" on public.pagos_profes;
create policy "El dueño paga a los profes" on public.pagos_profes for all to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));

-- Vuelta atrás (si hiciera falta; antes, borrar o pasar a 'turno' las reservas de tipo 'clase'):
--   drop table if exists public.pagos_profes, public.cuotas_alumnos, public.alumnos;
--   alter table public.reservas drop constraint if exists reservas_profe_fk, drop column if exists profe_id;
--   alter table public.reservas drop constraint if exists reservas_tipo_check;
--   alter table public.reservas add constraint reservas_tipo_check check (tipo in ('turno', 'bloqueo'));
--   drop table if exists public.profes_complejo;
--   (y volver a correr _resumen_turno de 20261025_cierre_caja.sql)
