-- Caja del día: cada persona que cobra (el dueño o un empleado) abre su caja con un fondo
-- inicial, y al irse la cierra contando el efectivo. La app le muestra cuánto debería haber según
-- lo que cobró ESA persona en ese rato (mostrador, cuentas, inscripciones y turnos), más los
-- movimientos de la caja (retiros, gastos pagados con la caja, otros ingresos), y guarda la
-- diferencia (sobra o falta).
--
-- - reservas: quién cobró el turno y cuándo (cobrado_por, cobrado_at), lo fija la base.
-- - caja_turnos: cada apertura y cierre. Una sola caja abierta por persona y complejo.
-- - caja_movimientos_turno: retiros de efectivo, gastos pagados con la caja y otros ingresos.
--   Los gastos y otros ingresos también aparecen en la Caja del dueño.
-- - abrir_caja(), mover_caja(), resumen_caja() y cerrar_caja(): todo pasa por acá.
--
-- Abren caja el dueño y los empleados con permiso de agenda o de cantina. Cada uno ve la suya; el
-- dueño ve todas y puede cerrar la de un empleado que se olvidó.
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261024.

-- ============================================================
-- Turnos: quién cobró
-- ============================================================

alter table public.reservas add column if not exists cobrado_por uuid;
alter table public.reservas add column if not exists cobrado_at timestamptz;

create or replace function public.reserva_cobro_quien()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.medio_pago is null then
    new.cobrado_por := null;
    new.cobrado_at := null;
  elsif tg_op = 'INSERT' or old.medio_pago is null or old.medio_pago is distinct from new.medio_pago then
    new.cobrado_por := auth.uid();
    new.cobrado_at := now();
  else
    new.cobrado_por := old.cobrado_por;
    new.cobrado_at := old.cobrado_at;
  end if;
  return new;
end;
$$;

drop trigger if exists reserva_cobro_quien on public.reservas;
create trigger reserva_cobro_quien before insert or update on public.reservas
  for each row execute function public.reserva_cobro_quien();

-- ============================================================
-- Tablas
-- ============================================================

create table if not exists public.caja_turnos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  usuario uuid not null,
  usuario_email text,
  fondo numeric(12, 2) not null default 0 check (fondo >= 0 and fondo < 100000000),
  abierta_at timestamptz not null default now(),
  cerrada_at timestamptz,
  cerrada_por_email text,
  contado numeric(12, 2) check (contado is null or contado >= 0),
  esperado numeric(12, 2),
  resumen jsonb,
  nota text check (nota is null or char_length(nota) <= 200)
);
create unique index if not exists caja_una_abierta on public.caja_turnos (complejo_id, usuario) where cerrada_at is null;
create index if not exists caja_turnos_por_complejo on public.caja_turnos (complejo_id, abierta_at desc);

create table if not exists public.caja_movimientos_turno (
  id uuid primary key default gen_random_uuid(),
  turno_id uuid not null references public.caja_turnos(id) on delete cascade,
  complejo_id text not null,
  tipo text not null check (tipo in ('retiro', 'gasto', 'ingreso')),
  concepto text not null check (char_length(btrim(concepto)) between 1 and 80),
  monto numeric(12, 2) not null check (monto > 0 and monto < 100000000),
  hecho_por_email text,
  created_at timestamptz not null default now()
);
create index if not exists caja_mov_por_turno on public.caja_movimientos_turno (turno_id);
create index if not exists caja_mov_por_complejo on public.caja_movimientos_turno (complejo_id, created_at);

-- ============================================================
-- Funciones
-- ============================================================

create or replace function public.puede_caja(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_dueno_complejo(p_complejo)
      or public.colaborador_permiso(p_complejo, 'agenda')
      or public.colaborador_permiso(p_complejo, 'consumos');
$$;

revoke all on function public.puede_caja(text) from public, anon;
grant execute on function public.puede_caja(text) to authenticated;

-- Lo que cobró la persona de la caja mientras estuvo abierta, por medio y por origen, y el
-- efectivo que debería haber (uso interno)
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

-- Abrir la caja propia con un fondo inicial
create or replace function public.abrir_caja(p_complejo text, p_fondo numeric default 0)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.puede_caja(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_fondo is null or p_fondo < 0 or p_fondo >= 100000000 then
    raise exception 'datos_invalidos';
  end if;
  if exists (select 1 from caja_turnos where complejo_id = p_complejo and usuario = auth.uid() and cerrada_at is null) then
    raise exception 'caja_ya_abierta';
  end if;
  insert into caja_turnos (complejo_id, usuario, usuario_email, fondo)
  values (p_complejo, auth.uid(), (select email from auth.users where id = auth.uid()), p_fondo)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.abrir_caja(text, numeric) from public, anon;
grant execute on function public.abrir_caja(text, numeric) to authenticated;

-- Retiro, gasto u otro ingreso en una caja abierta (la propia, o cualquiera si es el dueño)
create or replace function public.mover_caja(p_turno uuid, p_tipo text, p_monto numeric, p_concepto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t caja_turnos%rowtype;
begin
  select * into t from caja_turnos where id = p_turno for update;
  if not found or not (t.usuario = auth.uid() and public.puede_caja(t.complejo_id) or public.es_dueno_complejo(t.complejo_id)) then
    raise exception 'no_autorizado';
  end if;
  if t.cerrada_at is not null then
    raise exception 'caja_cerrada';
  end if;
  insert into caja_movimientos_turno (turno_id, complejo_id, tipo, concepto, monto, hecho_por_email)
  values (t.id, t.complejo_id, p_tipo, btrim(p_concepto), p_monto, (select email from auth.users where id = auth.uid()));
end;
$$;

revoke all on function public.mover_caja(uuid, text, numeric, text) from public, anon;
grant execute on function public.mover_caja(uuid, text, numeric, text) to authenticated;

-- Resumen de una caja (abierta: hasta ahora; cerrada: lo que quedó guardado al cerrar)
create or replace function public.resumen_caja(p_turno uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t caja_turnos%rowtype;
begin
  select * into t from caja_turnos where id = p_turno;
  if not found or not (t.usuario = auth.uid() or public.es_dueno_complejo(t.complejo_id)) then
    raise exception 'no_autorizado';
  end if;
  return coalesce(t.resumen, public._resumen_turno(t.id));
end;
$$;

revoke all on function public.resumen_caja(uuid) from public, anon;
grant execute on function public.resumen_caja(uuid) to authenticated;

-- Cerrar: se guarda el resumen, lo esperado y lo contado
create or replace function public.cerrar_caja(p_turno uuid, p_contado numeric, p_nota text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t caja_turnos%rowtype;
  v_resumen jsonb;
begin
  select * into t from caja_turnos where id = p_turno for update;
  if not found or not (t.usuario = auth.uid() or public.es_dueno_complejo(t.complejo_id)) then
    raise exception 'no_autorizado';
  end if;
  if t.cerrada_at is not null then
    raise exception 'caja_cerrada';
  end if;
  if p_contado is null or p_contado < 0 or p_contado >= 100000000 then
    raise exception 'datos_invalidos';
  end if;
  update caja_turnos set cerrada_at = now() where id = t.id;
  v_resumen := public._resumen_turno(t.id);
  update caja_turnos
     set resumen = v_resumen,
         esperado = (v_resumen ->> 'efectivo_esperado')::numeric,
         contado = p_contado,
         nota = nullif(btrim(coalesce(p_nota, '')), ''),
         cerrada_por_email = (select email from auth.users where id = auth.uid())
   where id = t.id;
  return v_resumen || jsonb_build_object('contado', p_contado, 'diferencia', p_contado - (v_resumen ->> 'efectivo_esperado')::numeric);
end;
$$;

revoke all on function public.cerrar_caja(uuid, numeric, text) from public, anon;
grant execute on function public.cerrar_caja(uuid, numeric, text) to authenticated;

-- ============================================================
-- Permisos: cada uno ve sus cajas; el dueño, todas. Se escribe solo por las funciones.
-- ============================================================

alter table public.caja_turnos enable row level security;
alter table public.caja_movimientos_turno enable row level security;
revoke all on public.caja_turnos, public.caja_movimientos_turno from public, anon, authenticated;
grant select on public.caja_turnos, public.caja_movimientos_turno to authenticated;

drop policy if exists "Ven sus cajas" on public.caja_turnos;
create policy "Ven sus cajas" on public.caja_turnos for select to authenticated
  using (usuario = auth.uid() or public.es_dueno_complejo(complejo_id));
drop policy if exists "Ven movimientos de sus cajas" on public.caja_movimientos_turno;
create policy "Ven movimientos de sus cajas" on public.caja_movimientos_turno for select to authenticated
  using (exists (select 1 from public.caja_turnos t where t.id = turno_id and (t.usuario = auth.uid() or public.es_dueno_complejo(t.complejo_id))));

-- Vuelta atrás (si hiciera falta):
--   drop function if exists public.cerrar_caja(uuid, numeric, text);
--   drop function if exists public.resumen_caja(uuid);
--   drop function if exists public.mover_caja(uuid, text, numeric, text);
--   drop function if exists public.abrir_caja(text, numeric);
--   drop function if exists public._resumen_turno(uuid);
--   drop function if exists public.puede_caja(text);
--   drop table if exists public.caja_movimientos_turno, public.caja_turnos;
--   drop trigger if exists reserva_cobro_quien on public.reservas;
--   drop function if exists public.reserva_cobro_quien();
--   alter table public.reservas drop column if exists cobrado_por, drop column if exists cobrado_at;
