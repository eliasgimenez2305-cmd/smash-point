-- Caja nueva, etapa 1: UN SOLO LIBRO de movimientos + cuentas con saldo calculado.
--
-- Hoy la Caja se arma en el navegador juntando 9 tablas (pagos_inscripcion, reservas, cuenta_pagos,
-- venta_pagos, caja_movimientos_turno, cuotas_alumnos, pagos_profes, compras, caja_movimientos).
-- Con esto, cada peso que entra o sale queda en UNA fila de "movimientos", escrita en la MISMA
-- transacción que el cobro / la venta / la compra (disparadores en esas tablas). La pantalla nueva
-- (etapa 2) lee solo de acá; mientras tanto la Caja de hoy sigue andando igual.
--
-- Decisiones (22/10/2026):
--   - Un libro por organizador (dueño), filtrable por complejo.
--   - Cuentas: Efectivo, Mercado Pago, Banco, Posnet y Caja fuerte. Cada dueño elige a qué cuenta va
--     cada medio de cobro (por defecto transferencia → Banco, débito/crédito → Posnet).
--   - "Retiro" de la caja = retiro de socio (sale del negocio). Pasar a la caja fuerte = transferencia.
--   - Varios socios por dueño (tabla socios_caja); retiros y aportes dicen de qué socio.
--   - Montos en centavos (bigint). Nada se borra: se anula con motivo y queda el historial.
--
-- Al final pasa todo lo que ya existe al libro y CONTROLA, por dueño y por mes, que los ingresos y
-- gastos den igual que en la Caja de hoy; si no, aborta y no cambia nada.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261044.

-- ============================================================================================
-- 1. Tablas
-- ============================================================================================

-- Dónde está la plata
create table if not exists public.cuentas_caja (
  id uuid primary key default gen_random_uuid(),
  dueno_id uuid not null,
  complejo_id text references public.complejos(id) on delete set null, -- null = de todo el negocio
  nombre text not null check (char_length(btrim(nombre)) between 2 and 40),
  clase text not null check (clase in ('efectivo', 'mercado_pago', 'banco', 'otra')),
  saldo_inicial bigint not null default 0,          -- centavos (puede ser negativo: descubierto)
  saldo_inicial_fecha date not null default date '2026-01-01',
  activa boolean not null default true,              -- se archiva, no se borra
  orden smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (dueno_id, nombre)
);

-- A qué cuenta va cada medio de cobro ('' = para todos los complejos del dueño)
create table if not exists public.cuenta_por_medio (
  dueno_id uuid not null,
  complejo_id text not null default '',
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito')),
  cuenta_id uuid not null references public.cuentas_caja(id) on delete restrict,
  primary key (dueno_id, complejo_id, medio)
);

-- Categorías de ingresos y gastos (las que tienen "clave" las usa el sistema: no se desactivan)
create table if not exists public.categorias_caja (
  id uuid primary key default gen_random_uuid(),
  dueno_id uuid not null,
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  nombre text not null check (char_length(btrim(nombre)) between 2 and 40),
  clave text,
  activa boolean not null default true,
  orden smallint not null default 0,
  unique (dueno_id, tipo, nombre),
  unique (dueno_id, clave)
);

-- Socios del negocio (para retiros y aportes)
create table if not exists public.socios_caja (
  id uuid primary key default gen_random_uuid(),
  dueno_id uuid not null,
  nombre text not null check (char_length(btrim(nombre)) between 2 and 40),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (dueno_id, nombre)
);

-- El libro
create table if not exists public.movimientos (
  id uuid primary key default gen_random_uuid(),
  dueno_id uuid not null,
  complejo_id text references public.complejos(id) on delete set null,
  tipo text not null check (tipo in ('ingreso', 'gasto', 'retiro_socio', 'aporte_socio', 'transferencia_interna', 'ajuste')),
  categoria_id uuid references public.categorias_caja(id) on delete restrict,
  cuenta_id uuid not null references public.cuentas_caja(id) on delete restrict,          -- de dónde sale / a dónde entra
  cuenta_destino_id uuid references public.cuentas_caja(id) on delete restrict,           -- solo transferencias
  socio_id uuid references public.socios_caja(id) on delete restrict,                     -- retiros y aportes
  sentido smallint not null check (sentido in (1, -1)),     -- +1 entra a cuenta_id, -1 sale
  monto bigint not null check (monto > 0 and monto < 10000000000000), -- centavos
  medio text check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito')),
  concepto text not null check (char_length(btrim(concepto)) >= 3 and btrim(concepto) !~ '^[-_.\s]*$'),
  fecha date not null,
  cargado_at timestamptz not null default now(),
  cargado_por uuid not null,
  caja_turno_id uuid references public.caja_turnos(id) on delete set null,   -- caja del día (efectivo)
  -- lo que lo originó (null = cargado a mano en la Caja nueva)
  ref_tipo text check (ref_tipo in ('inscripcion', 'turno', 'cuenta', 'venta', 'caja_dia', 'cuota_clase', 'pago_profe', 'compra', 'caja_vieja')),
  ref_id text,
  ref_pago_id uuid,
  -- anulación (no se borra nunca)
  anulado_at timestamptz,
  anulado_por uuid,
  anulado_motivo text,
  check ((anulado_at is null) = (anulado_por is null) and (anulado_at is null) = (anulado_motivo is null)),
  check (anulado_motivo is null or char_length(btrim(anulado_motivo)) >= 3),
  check ((tipo = 'transferencia_interna') = (cuenta_destino_id is not null)),
  check (cuenta_destino_id is null or cuenta_destino_id <> cuenta_id),
  check (tipo not in ('ingreso', 'gasto') or categoria_id is not null),
  check (tipo in ('ingreso', 'gasto') or categoria_id is null),
  check (tipo in ('retiro_socio', 'aporte_socio') or socio_id is null),
  check (tipo not in ('ingreso', 'aporte_socio') or sentido = 1),
  check (tipo not in ('gasto', 'retiro_socio', 'transferencia_interna') or sentido = -1)
);
-- Un solo movimiento vigente por cada cobro/pago de origen
create unique index if not exists movimientos_un_origen on public.movimientos (ref_tipo, ref_pago_id)
  where ref_pago_id is not null and anulado_at is null;
create index if not exists movimientos_por_fecha on public.movimientos (dueno_id, fecha desc);
create index if not exists movimientos_por_cuenta on public.movimientos (cuenta_id, fecha);
create index if not exists movimientos_por_destino on public.movimientos (cuenta_destino_id, fecha) where cuenta_destino_id is not null;
create index if not exists movimientos_por_caja on public.movimientos (caja_turno_id) where caja_turno_id is not null;
create index if not exists movimientos_por_origen on public.movimientos (ref_tipo, ref_pago_id);

-- Historial: cada edición y cada anulación guarda el antes y el después
create table if not exists public.movimientos_historial (
  id bigint generated always as identity primary key,
  movimiento_id uuid not null references public.movimientos(id) on delete restrict,
  accion text not null check (accion in ('edicion', 'anulacion')),
  antes jsonb not null,
  despues jsonb not null,
  motivo text,
  hecho_por uuid not null,
  hecho_at timestamptz not null default now()
);
create index if not exists historial_por_movimiento on public.movimientos_historial (movimiento_id, hecho_at);

-- Nadie borra (ni el dueño ni las funciones) y el historial no se toca
create or replace function public.movimientos_sin_borrar() returns trigger language plpgsql as $$
begin raise exception 'movimientos_no_se_borran'; end; $$;
drop trigger if exists movimientos_sin_borrar on public.movimientos;
create trigger movimientos_sin_borrar before delete on public.movimientos for each row execute function public.movimientos_sin_borrar();
drop trigger if exists historial_sin_borrar on public.movimientos_historial;
create trigger historial_sin_borrar before delete or update on public.movimientos_historial for each row execute function public.movimientos_sin_borrar();

-- Toda modificación deja historial; un anulado ya no cambia
create or replace function public.movimientos_historial_auto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.anulado_at is not null then
    raise exception 'movimiento_anulado';
  end if;
  if new.anulado_at is not null then
    insert into movimientos_historial (movimiento_id, accion, antes, despues, motivo, hecho_por)
    values (new.id, 'anulacion', to_jsonb(old), to_jsonb(new), new.anulado_motivo, new.anulado_por);
  elsif to_jsonb(old) is distinct from to_jsonb(new) then
    insert into movimientos_historial (movimiento_id, accion, antes, despues, hecho_por)
    values (new.id, 'edicion', to_jsonb(old), to_jsonb(new), coalesce(auth.uid(), new.cargado_por));
  end if;
  return new;
end; $$;
drop trigger if exists movimientos_historial_auto on public.movimientos;
create trigger movimientos_historial_auto before update on public.movimientos for each row execute function public.movimientos_historial_auto();

-- ============================================================================================
-- 2. Ayudas internas
-- ============================================================================================

create or replace function public._fecha_ar(p timestamptz) returns date
language sql immutable as $$ select (p at time zone 'America/Argentina/Buenos_Aires')::date; $$;

-- Concepto válido (al menos 3 letras, no solo guiones); si no, el de repuesto
create or replace function public._concepto(p text, p_repuesto text) returns text
language sql immutable as $$
  select case when char_length(btrim(coalesce(p, ''))) >= 3 and btrim(p) !~ '^[-_.\s]*$' then left(btrim(p), 120) else p_repuesto end;
$$;

-- Cuentas, medios y categorías iniciales del dueño (si ya las tiene, no hace nada)
create or replace function public._preparar_dueno(p_dueno uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_dueno is null or exists (select 1 from cuentas_caja where dueno_id = p_dueno) then
    return;
  end if;
  insert into cuentas_caja (dueno_id, nombre, clase, orden) values
    (p_dueno, 'Efectivo', 'efectivo', 1), (p_dueno, 'Mercado Pago', 'mercado_pago', 2), (p_dueno, 'Banco', 'banco', 3),
    (p_dueno, 'Posnet', 'banco', 4), (p_dueno, 'Caja fuerte', 'efectivo', 5)
  on conflict (dueno_id, nombre) do nothing;
  insert into cuenta_por_medio (dueno_id, complejo_id, medio, cuenta_id)
  select p_dueno, '', m.medio, c.id
  from (values ('efectivo', 'Efectivo'), ('mercado_pago', 'Mercado Pago'), ('transferencia', 'Banco'), ('debito', 'Posnet'), ('credito', 'Posnet')) m(medio, cuenta)
  join cuentas_caja c on c.dueno_id = p_dueno and c.nombre = m.cuenta
  on conflict do nothing;
  insert into categorias_caja (dueno_id, tipo, nombre, clave, orden) values
    (p_dueno, 'ingreso', 'Turnos', 'turnos', 1), (p_dueno, 'ingreso', 'Clases', 'clases', 2),
    (p_dueno, 'ingreso', 'Torneos', 'torneos', 3), (p_dueno, 'ingreso', 'Mostrador', 'mostrador', 4),
    (p_dueno, 'ingreso', 'Cuentas (fiado)', 'cuentas', 5), (p_dueno, 'ingreso', 'Alquiler de paletas', null, 6),
    (p_dueno, 'ingreso', 'Sponsors', null, 7), (p_dueno, 'ingreso', 'Otros ingresos', 'otros_ingresos', 99),
    (p_dueno, 'gasto', 'Luz', null, 1), (p_dueno, 'gasto', 'Alquiler', null, 2), (p_dueno, 'gasto', 'Sueldos', null, 3),
    (p_dueno, 'gasto', 'Proveedores (compras)', 'proveedores', 4), (p_dueno, 'gasto', 'Profes', 'profes', 5),
    (p_dueno, 'gasto', 'Mantenimiento', null, 6), (p_dueno, 'gasto', 'Comisiones', null, 7),
    (p_dueno, 'gasto', 'Impuestos', null, 8), (p_dueno, 'gasto', 'Premios', null, 9),
    (p_dueno, 'gasto', 'Otros gastos', 'otros_gastos', 99)
  on conflict do nothing;
end; $$;

-- Cuenta para un medio de cobro (la del complejo si la eligió, si no la general; si no, Efectivo)
create or replace function public._cuenta_de_medio(p_dueno uuid, p_complejo text, p_medio text) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cuenta_id from cuenta_por_medio where dueno_id = p_dueno and complejo_id = coalesce(p_complejo, '') and medio = coalesce(p_medio, 'efectivo')),
    (select cuenta_id from cuenta_por_medio where dueno_id = p_dueno and complejo_id = '' and medio = coalesce(p_medio, 'efectivo')),
    (select id from cuentas_caja where dueno_id = p_dueno and clase = 'efectivo' order by orden limit 1));
$$;

create or replace function public._categoria(p_dueno uuid, p_clave text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from categorias_caja where dueno_id = p_dueno and clave = p_clave;
$$;

-- Caja del día abierta de quien cobró en efectivo, en ese momento
create or replace function public._caja_del_dia(p_complejo text, p_usuario uuid, p_medio text, p_cuando timestamptz) returns uuid
language sql stable security definer set search_path = public as $$
  select id from caja_turnos
  where p_medio = 'efectivo' and complejo_id = p_complejo and usuario = p_usuario
    and abierta_at <= p_cuando and (cerrada_at is null or cerrada_at >= p_cuando)
  order by abierta_at desc limit 1;
$$;

-- El corazón: deja el libro como tiene que estar para un cobro/pago de origen.
--   p_activo = false (o sin dueño, o monto 0): anula el movimiento vigente si hay.
--   Si no hay movimiento: lo crea. Si cambió el monto, la fecha, el medio o el complejo: lo corrige
--   (queda en el historial). El concepto, la categoría y la cuenta que haya cambiado el dueño a mano
--   se respetan, salvo la cuenta cuando cambia el medio.
create or replace function public._libro_poner(
  p_ref_tipo text, p_ref_pago_id uuid, p_activo boolean, p_dueno uuid, p_complejo text,
  p_tipo text, p_clave text, p_monto numeric, p_medio text, p_concepto text, p_fecha date,
  p_cargado_por uuid, p_ref_id text, p_caja uuid, p_motivo text default 'Se borró o se anuló en el origen')
returns void language plpgsql security definer set search_path = public as $$
declare
  m movimientos%rowtype;
  v_monto bigint := round(coalesce(p_monto, 0) * 100)::bigint;
  v_sentido smallint := case when p_tipo in ('ingreso', 'aporte_socio') then 1 else -1 end;
begin
  select * into m from movimientos where ref_tipo = p_ref_tipo and ref_pago_id = p_ref_pago_id and anulado_at is null for update;
  if not coalesce(p_activo, false) or p_dueno is null or v_monto <= 0 then
    if m.id is not null then
      update movimientos set anulado_at = now(), anulado_por = coalesce(auth.uid(), m.cargado_por), anulado_motivo = p_motivo where id = m.id;
    end if;
    return;
  end if;
  perform _preparar_dueno(p_dueno);
  if m.id is null then
    insert into movimientos (dueno_id, complejo_id, tipo, categoria_id, cuenta_id, sentido, monto, medio, concepto, fecha,
                             cargado_por, caja_turno_id, ref_tipo, ref_id, ref_pago_id)
    values (p_dueno, p_complejo, p_tipo, case when p_tipo in ('ingreso', 'gasto') then _categoria(p_dueno, p_clave) end,
            _cuenta_de_medio(p_dueno, p_complejo, p_medio), v_sentido, v_monto, coalesce(p_medio, 'efectivo'),
            _concepto(p_concepto, 'Sin concepto'), p_fecha, coalesce(p_cargado_por, p_dueno), p_caja,
            p_ref_tipo, p_ref_id, p_ref_pago_id);
  elsif m.monto <> v_monto or m.fecha <> p_fecha or m.medio is distinct from coalesce(p_medio, 'efectivo')
        or m.complejo_id is distinct from p_complejo or m.caja_turno_id is distinct from p_caja then
    update movimientos set
      monto = v_monto, fecha = p_fecha, complejo_id = p_complejo, caja_turno_id = p_caja,
      medio = coalesce(p_medio, 'efectivo'),
      cuenta_id = case when m.medio is distinct from coalesce(p_medio, 'efectivo') then _cuenta_de_medio(p_dueno, p_complejo, p_medio) else m.cuenta_id end
    where id = m.id;
  end if;
end; $$;

-- ============================================================================================
-- 3. Un "sincronizar" por cada tabla de origen (lo usan los disparadores y el pasaje)
-- ============================================================================================

create or replace function public._libro_inscripcion(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p pagos_inscripcion%rowtype;
begin
  select * into p from pagos_inscripcion where id = p_id;
  perform _libro_poner('inscripcion', p_id, p.id is not null, p.organizador_id, null, 'ingreso', 'torneos', p.monto, p.medio,
    'Inscripción · ' || coalesce((select datos->>'name' from torneos where id = p.torneo_id), 'torneo'),
    _fecha_ar(p.created_at), p.cobrado_por, p.torneo_id, null);
end; $$;

create or replace function public._libro_turno(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r reservas%rowtype; v_dueno uuid;
begin
  select * into r from reservas where id = p_id;
  select dueno_id into v_dueno from complejos where id = r.complejo_id;
  perform _libro_poner('turno', p_id,
    r.id is not null and r.tipo in ('turno', 'clase') and r.estado = 'confirmada' and r.medio_pago is not null and r.precio is not null,
    v_dueno, r.complejo_id, 'ingreso', case when r.tipo = 'clase' then 'clases' else 'turnos' end, r.precio, r.medio_pago,
    case when r.tipo = 'clase' then 'Clase · ' else 'Turno · ' end || coalesce(r.nombre, 'sin nombre'),
    r.fecha, coalesce(r.cobrado_por, r.creada_por), r.id::text,
    _caja_del_dia(r.complejo_id, r.cobrado_por, r.medio_pago, coalesce(r.cobrado_at, r.created_at)),
    'El turno se canceló o se sacó el cobro');
end; $$;

create or replace function public._libro_cuenta(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p cuenta_pagos%rowtype; v_dueno uuid;
begin
  select * into p from cuenta_pagos where id = p_id;
  select dueno_id into v_dueno from complejos where id = p.complejo_id;
  perform _libro_poner('cuenta', p_id, p.id is not null, v_dueno, p.complejo_id, 'ingreso', 'cuentas', p.monto, p.medio,
    'Cuenta · ' || coalesce((select nombre from cuentas where id = p.cuenta_id), 'cuenta'),
    _fecha_ar(p.created_at), p.cobrado_por, p.cuenta_id::text, _caja_del_dia(p.complejo_id, p.cobrado_por, p.medio, p.created_at));
end; $$;

create or replace function public._libro_venta(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p venta_pagos%rowtype; v ventas%rowtype; v_dueno uuid; v_quien uuid;
begin
  select * into p from venta_pagos where id = p_id;
  select * into v from ventas where id = p.venta_id;
  select dueno_id into v_dueno from complejos where id = p.complejo_id;
  v_quien := coalesce(p.cobrado_por, v.vendido_por);
  perform _libro_poner('venta', p_id, p.id is not null and not coalesce(v.anulada, true), v_dueno, p.complejo_id, 'ingreso', 'mostrador',
    p.monto, p.medio, 'Mostrador · venta #' || coalesce(v.numero::text, '?'), _fecha_ar(p.created_at), v_quien, v.id::text,
    _caja_del_dia(p.complejo_id, v_quien, p.medio, p.created_at), 'Venta anulada');
end; $$;

create or replace function public._libro_caja_dia(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m caja_movimientos_turno%rowtype; t caja_turnos%rowtype; v_dueno uuid;
begin
  select * into m from caja_movimientos_turno where id = p_id;
  select * into t from caja_turnos where id = m.turno_id;
  select dueno_id into v_dueno from complejos where id = m.complejo_id;
  perform _libro_poner('caja_dia', p_id, m.id is not null, v_dueno, m.complejo_id,
    case m.tipo when 'retiro' then 'retiro_socio' else m.tipo end,
    case m.tipo when 'ingreso' then 'otros_ingresos' when 'gasto' then 'otros_gastos' end,
    m.monto, 'efectivo', _concepto(m.concepto, case m.tipo when 'retiro' then 'Retiro de la caja del día' else 'Caja del día' end),
    _fecha_ar(m.created_at), t.usuario, m.turno_id::text, m.turno_id);
end; $$;

create or replace function public._libro_cuota(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare q cuotas_alumnos%rowtype; v_dueno uuid;
begin
  select * into q from cuotas_alumnos where id = p_id;
  select dueno_id into v_dueno from complejos where id = q.complejo_id;
  perform _libro_poner('cuota_clase', p_id, q.id is not null, v_dueno, q.complejo_id, 'ingreso', 'clases', q.monto, q.medio,
    'Cuota ' || coalesce(q.periodo, '') || ' · ' || coalesce((select nombre from alumnos where id = q.alumno_id), 'alumno'),
    _fecha_ar(q.created_at), q.cobrado_por, q.alumno_id::text, _caja_del_dia(q.complejo_id, q.cobrado_por, q.medio, q.created_at));
end; $$;

create or replace function public._libro_pago_profe(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare x pagos_profes%rowtype; v_dueno uuid;
begin
  select * into x from pagos_profes where id = p_id;
  select dueno_id into v_dueno from complejos where id = x.complejo_id;
  perform _libro_poner('pago_profe', p_id, x.id is not null, v_dueno, x.complejo_id, 'gasto', 'profes', x.monto, x.medio,
    'Pago a ' || coalesce((select nombre from profes_complejo where id = x.profe_id), 'profe') || ' · ' || coalesce(x.periodo, ''),
    _fecha_ar(x.created_at), v_dueno, x.profe_id::text, null);
end; $$;

create or replace function public._libro_compra(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c compras%rowtype; v_dueno uuid;
begin
  select * into c from compras where id = p_id;
  select dueno_id into v_dueno from complejos where id = c.complejo_id;
  perform _libro_poner('compra', p_id, c.id is not null and not c.anulada and c.pagada_at is not null, v_dueno, c.complejo_id,
    'gasto', 'proveedores', c.total, coalesce(c.medio, 'efectivo'),
    'Compra' || coalesce(' a ' || (select nombre from proveedores where id = c.proveedor_id), ''),
    c.pagada_at, v_dueno, c.id::text, null, 'Compra anulada o sin pagar');
end; $$;

-- La Caja de hoy (caja_movimientos): ingresos y gastos cargados a mano, y los gastos fijos
create or replace function public._libro_caja_vieja(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m caja_movimientos%rowtype;
begin
  select * into m from caja_movimientos where id = p_id;
  perform _libro_poner('caja_vieja', p_id, m.id is not null, m.organizador_id, null, m.tipo,
    case when m.tipo = 'gasto' then 'otros_gastos' when m.torneo_id is not null then 'torneos' else 'otros_ingresos' end,
    m.monto, m.medio, _concepto(m.concepto, case when m.tipo = 'gasto' then 'Gasto sin concepto' else 'Ingreso sin concepto' end),
    m.fecha, m.organizador_id, coalesce(m.torneo_id, m.gasto_fijo_id::text), null, 'Se borró de la Caja');
end; $$;

do $$
declare f text;
begin
  foreach f in array array['_fecha_ar(timestamptz)', '_concepto(text, text)', '_preparar_dueno(uuid)', '_cuenta_de_medio(uuid, text, text)',
    '_categoria(uuid, text)', '_caja_del_dia(text, uuid, text, timestamptz)',
    '_libro_poner(text, uuid, boolean, uuid, text, text, text, numeric, text, text, date, uuid, text, uuid, text)',
    '_libro_inscripcion(uuid)', '_libro_turno(uuid)', '_libro_cuenta(uuid)', '_libro_venta(uuid)', '_libro_caja_dia(uuid)',
    '_libro_cuota(uuid)', '_libro_pago_profe(uuid)', '_libro_compra(uuid)', '_libro_caja_vieja(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ============================================================================================
-- 4. Saldos (siempre calculados)
-- ============================================================================================

-- Cada movimiento vigente en su efecto sobre cada cuenta (la transferencia da dos filas)
create or replace view public.movimientos_efecto with (security_invoker = true) as
  select m.id, m.dueno_id, m.complejo_id, m.fecha, m.tipo, m.cuenta_id, (m.sentido * m.monto)::bigint as delta
    from public.movimientos m where m.anulado_at is null
  union all
  select m.id, m.dueno_id, m.complejo_id, m.fecha, m.tipo, m.cuenta_destino_id, m.monto
    from public.movimientos m where m.anulado_at is null and m.tipo = 'transferencia_interna';
grant select on public.movimientos_efecto to authenticated;

-- Saldo de cada cuenta del dueño a una fecha (saldo inicial + movimientos desde su fecha)
create or replace function public.saldos_cuentas(p_hasta date default null)
returns table (cuenta_id uuid, nombre text, clase text, activa boolean, saldo bigint)
language sql stable security definer set search_path = public as $$
  select c.id, c.nombre, c.clase, c.activa,
         (c.saldo_inicial + coalesce(sum(e.delta) filter (where e.fecha >= c.saldo_inicial_fecha
                                                         and (p_hasta is null or e.fecha <= p_hasta)), 0))::bigint
    from cuentas_caja c left join movimientos_efecto e on e.cuenta_id = c.id
   where c.dueno_id = auth.uid()
   group by c.id order by c.orden, c.nombre;
$$;
revoke all on function public.saldos_cuentas(date) from public, anon;
grant execute on function public.saldos_cuentas(date) to authenticated;

-- ============================================================================================
-- 5. Escribir: solo por funciones (solo el dueño, por ahora; los empleados llegan en la etapa 3)
-- ============================================================================================

create or replace function public._soy_dueno_caja() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not es_organizador() then
    raise exception 'no_autorizado';
  end if;
  return auth.uid();
end; $$;
revoke all on function public._soy_dueno_caja() from public, anon, authenticated;

-- Deja listas las cuentas y categorías del dueño (la pantalla lo llama al entrar)
create or replace function public.preparar_mi_caja() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _preparar_dueno(_soy_dueno_caja());
end; $$;

-- Movimiento a mano: ingreso, gasto, retiro o aporte de socio, ajuste (p_sentido +1 / -1)
create or replace function public.registrar_movimiento(
  p_tipo text, p_monto bigint, p_cuenta uuid, p_concepto text, p_fecha date,
  p_categoria uuid default null, p_complejo text default null, p_medio text default null,
  p_socio uuid default null, p_sentido smallint default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_dueno uuid := _soy_dueno_caja();
  c cuentas_caja%rowtype;
  v_id uuid;
begin
  if p_tipo not in ('ingreso', 'gasto', 'retiro_socio', 'aporte_socio', 'ajuste') then raise exception 'tipo_invalido'; end if;
  if coalesce(p_monto, 0) <= 0 then raise exception 'monto_invalido'; end if;
  if _concepto(p_concepto, '') = '' then raise exception 'falta_concepto'; end if;
  select * into c from cuentas_caja where id = p_cuenta and dueno_id = v_dueno;
  if c.id is null or not c.activa then raise exception 'cuenta_invalida'; end if;
  if p_fecha is null or p_fecha < c.saldo_inicial_fecha then raise exception 'fecha_antes_del_saldo_inicial'; end if;
  if p_tipo in ('ingreso', 'gasto') and not exists (select 1 from categorias_caja where id = p_categoria and dueno_id = v_dueno and tipo = p_tipo and activa) then
    raise exception 'categoria_invalida';
  end if;
  if p_complejo is not null and not exists (select 1 from complejos where id = p_complejo and dueno_id = v_dueno) then raise exception 'complejo_invalido'; end if;
  if p_socio is not null and (p_tipo not in ('retiro_socio', 'aporte_socio') or not exists (select 1 from socios_caja where id = p_socio and dueno_id = v_dueno and activo)) then
    raise exception 'socio_invalido';
  end if;
  if p_tipo = 'ajuste' and p_sentido not in (1, -1) then raise exception 'falta_sentido'; end if;
  insert into movimientos (dueno_id, complejo_id, tipo, categoria_id, cuenta_id, socio_id, sentido, monto, medio, concepto, fecha, cargado_por)
  values (v_dueno, p_complejo, p_tipo, case when p_tipo in ('ingreso', 'gasto') then p_categoria end, p_cuenta, p_socio,
          case when p_tipo in ('ingreso', 'aporte_socio') then 1 when p_tipo = 'ajuste' then p_sentido else -1 end,
          p_monto, p_medio, btrim(p_concepto), p_fecha, v_dueno)
  returning id into v_id;
  return v_id;
end; $$;

-- Pasar plata entre cuentas (ej. de la caja a la caja fuerte, o depositar en el banco)
create or replace function public.transferir_entre_cuentas(p_origen uuid, p_destino uuid, p_monto bigint, p_concepto text, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja(); v_id uuid;
begin
  if coalesce(p_monto, 0) <= 0 then raise exception 'monto_invalido'; end if;
  if p_origen = p_destino then raise exception 'misma_cuenta'; end if;
  if (select count(*) from cuentas_caja where id in (p_origen, p_destino) and dueno_id = v_dueno and activa) <> 2 then raise exception 'cuenta_invalida'; end if;
  if p_fecha is null or p_fecha < (select max(saldo_inicial_fecha) from cuentas_caja where id in (p_origen, p_destino)) then
    raise exception 'fecha_antes_del_saldo_inicial';
  end if;
  insert into movimientos (dueno_id, tipo, cuenta_id, cuenta_destino_id, sentido, monto, concepto, fecha, cargado_por)
  values (v_dueno, 'transferencia_interna', p_origen, p_destino, -1, p_monto, _concepto(p_concepto, 'Pase entre cuentas'), p_fecha, v_dueno)
  returning id into v_id;
  return v_id;
end; $$;

-- Anular (no se borra): los que vienen de una venta, un turno, etc. se anulan en el origen
create or replace function public.anular_movimiento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja(); m movimientos%rowtype;
begin
  select * into m from movimientos where id = p_id and dueno_id = v_dueno for update;
  if m.id is null then raise exception 'no_autorizado'; end if;
  if m.anulado_at is not null then raise exception 'ya_anulado'; end if;
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then raise exception 'falta_motivo'; end if;
  if m.ref_tipo is not null and m.ref_tipo <> 'caja_vieja' then raise exception 'anular_en_origen'; end if;
  update movimientos set anulado_at = now(), anulado_por = v_dueno, anulado_motivo = btrim(p_motivo) where id = p_id;
end; $$;

-- Editar: los cargados a mano, todo; los automáticos, solo cuenta, categoría y concepto
-- (el monto y la fecha se corrigen en el origen). p_cambios: {monto, fecha, cuenta_id, categoria_id, concepto, socio_id, complejo_id}
create or replace function public.editar_movimiento(p_id uuid, p_cambios jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_dueno uuid := _soy_dueno_caja();
  m movimientos%rowtype;
  v_auto boolean;
  v_cuenta uuid; v_categoria uuid; v_monto bigint; v_fecha date; v_socio uuid; v_complejo text; v_concepto text;
begin
  select * into m from movimientos where id = p_id and dueno_id = v_dueno for update;
  if m.id is null then raise exception 'no_autorizado'; end if;
  if m.anulado_at is not null then raise exception 'movimiento_anulado'; end if;
  v_auto := m.ref_tipo is not null and m.ref_tipo <> 'caja_vieja';
  if v_auto and (p_cambios ?| array['monto', 'fecha', 'socio_id', 'complejo_id']) then raise exception 'editar_en_origen'; end if;
  v_cuenta := coalesce((p_cambios->>'cuenta_id')::uuid, m.cuenta_id);
  v_categoria := coalesce((p_cambios->>'categoria_id')::uuid, m.categoria_id);
  v_monto := coalesce((p_cambios->>'monto')::bigint, m.monto);
  v_fecha := coalesce((p_cambios->>'fecha')::date, m.fecha);
  v_socio := case when p_cambios ? 'socio_id' then (p_cambios->>'socio_id')::uuid else m.socio_id end;
  v_complejo := case when p_cambios ? 'complejo_id' then p_cambios->>'complejo_id' else m.complejo_id end;
  v_concepto := case when p_cambios ? 'concepto' then _concepto(p_cambios->>'concepto', '') else m.concepto end;
  if v_concepto = '' then raise exception 'falta_concepto'; end if;
  if v_monto <= 0 then raise exception 'monto_invalido'; end if;
  if not exists (select 1 from cuentas_caja where id = v_cuenta and dueno_id = v_dueno and (activa or id = m.cuenta_id)) then raise exception 'cuenta_invalida'; end if;
  if v_cuenta = m.cuenta_destino_id then raise exception 'misma_cuenta'; end if;
  if m.tipo in ('ingreso', 'gasto') and not exists (select 1 from categorias_caja where id = v_categoria and dueno_id = v_dueno and tipo = m.tipo) then raise exception 'categoria_invalida'; end if;
  if v_complejo is not null and not exists (select 1 from complejos where id = v_complejo and dueno_id = v_dueno) then raise exception 'complejo_invalido'; end if;
  if v_socio is not null and not exists (select 1 from socios_caja where id = v_socio and dueno_id = v_dueno) then raise exception 'socio_invalido'; end if;
  update movimientos set cuenta_id = v_cuenta, categoria_id = case when m.tipo in ('ingreso', 'gasto') then v_categoria end,
    monto = v_monto, fecha = v_fecha, socio_id = case when m.tipo in ('retiro_socio', 'aporte_socio') then v_socio end,
    complejo_id = v_complejo, concepto = v_concepto
  where id = p_id;
end; $$;

-- Cuentas (crear o cambiar; se archivan, no se borran)
create or replace function public.guardar_cuenta_caja(p_id uuid, p_nombre text, p_clase text, p_saldo_inicial bigint, p_saldo_fecha date, p_activa boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja(); v_id uuid;
begin
  perform _preparar_dueno(v_dueno);
  if p_id is null then
    insert into cuentas_caja (dueno_id, nombre, clase, saldo_inicial, saldo_inicial_fecha, orden)
    values (v_dueno, btrim(p_nombre), p_clase, coalesce(p_saldo_inicial, 0), coalesce(p_saldo_fecha, current_date),
            coalesce((select max(orden) + 1 from cuentas_caja where dueno_id = v_dueno), 1))
    returning id into v_id;
  else
    if not coalesce(p_activa, true) and exists (select 1 from cuenta_por_medio where cuenta_id = p_id) then
      raise exception 'cuenta_en_uso_por_un_medio';
    end if;
    update cuentas_caja set nombre = btrim(p_nombre), clase = p_clase, saldo_inicial = coalesce(p_saldo_inicial, saldo_inicial),
      saldo_inicial_fecha = coalesce(p_saldo_fecha, saldo_inicial_fecha), activa = coalesce(p_activa, true)
    where id = p_id and dueno_id = v_dueno returning id into v_id;
    if v_id is null then raise exception 'no_autorizado'; end if;
  end if;
  return v_id;
end; $$;

-- A qué cuenta va un medio de cobro (p_complejo '' = todos los complejos)
create or replace function public.elegir_cuenta_medio(p_medio text, p_cuenta uuid, p_complejo text default '')
returns void language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja();
begin
  if not exists (select 1 from cuentas_caja where id = p_cuenta and dueno_id = v_dueno and activa) then raise exception 'cuenta_invalida'; end if;
  if coalesce(p_complejo, '') <> '' and not exists (select 1 from complejos where id = p_complejo and dueno_id = v_dueno) then raise exception 'complejo_invalido'; end if;
  insert into cuenta_por_medio (dueno_id, complejo_id, medio, cuenta_id) values (v_dueno, coalesce(p_complejo, ''), p_medio, p_cuenta)
  on conflict (dueno_id, complejo_id, medio) do update set cuenta_id = excluded.cuenta_id;
end; $$;

-- Categorías (las del sistema se pueden renombrar pero no desactivar)
create or replace function public.guardar_categoria_caja(p_id uuid, p_tipo text, p_nombre text, p_activa boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja(); v_id uuid;
begin
  perform _preparar_dueno(v_dueno);
  if p_id is null then
    insert into categorias_caja (dueno_id, tipo, nombre, orden)
    values (v_dueno, p_tipo, btrim(p_nombre), coalesce((select max(orden) from categorias_caja where dueno_id = v_dueno and tipo = p_tipo and orden < 99), 0) + 1)
    returning id into v_id;
  else
    update categorias_caja set nombre = btrim(p_nombre), activa = case when clave is not null then true else coalesce(p_activa, true) end
    where id = p_id and dueno_id = v_dueno returning id into v_id;
    if v_id is null then raise exception 'no_autorizado'; end if;
  end if;
  return v_id;
end; $$;

-- Socios
create or replace function public.guardar_socio(p_id uuid, p_nombre text, p_activo boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja(); v_id uuid;
begin
  if p_id is null then
    insert into socios_caja (dueno_id, nombre) values (v_dueno, btrim(p_nombre)) returning id into v_id;
  else
    update socios_caja set nombre = btrim(p_nombre), activo = coalesce(p_activo, true) where id = p_id and dueno_id = v_dueno returning id into v_id;
    if v_id is null then raise exception 'no_autorizado'; end if;
  end if;
  return v_id;
end; $$;

do $$
declare f text;
begin
  foreach f in array array['preparar_mi_caja()',
    'registrar_movimiento(text, bigint, uuid, text, date, uuid, text, text, uuid, smallint)',
    'transferir_entre_cuentas(uuid, uuid, bigint, text, date)', 'anular_movimiento(uuid, text)', 'editar_movimiento(uuid, jsonb)',
    'guardar_cuenta_caja(uuid, text, text, bigint, date, boolean)', 'elegir_cuenta_medio(text, uuid, text)',
    'guardar_categoria_caja(uuid, text, text, boolean)', 'guardar_socio(uuid, text, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ============================================================================================
-- 6. Permisos: cada dueño ve lo suyo; el empleado con caja, las cuentas y categorías del dueño
--    y solo los movimientos de SU caja del día. Escribir: solo por las funciones de arriba.
-- ============================================================================================

alter table public.cuentas_caja enable row level security;
alter table public.cuenta_por_medio enable row level security;
alter table public.categorias_caja enable row level security;
alter table public.socios_caja enable row level security;
alter table public.movimientos enable row level security;
alter table public.movimientos_historial enable row level security;
revoke all on public.cuentas_caja, public.cuenta_por_medio, public.categorias_caja, public.socios_caja,
  public.movimientos, public.movimientos_historial from public, anon, authenticated;
grant select on public.cuentas_caja, public.cuenta_por_medio, public.categorias_caja, public.socios_caja,
  public.movimientos, public.movimientos_historial to authenticated;

drop policy if exists "Ven las cuentas" on public.cuentas_caja;
create policy "Ven las cuentas" on public.cuentas_caja for select to authenticated
  using (dueno_id = auth.uid() or exists (select 1 from complejos x where x.dueno_id = cuentas_caja.dueno_id and public.puede_caja(x.id)));
drop policy if exists "Ven las categorías" on public.categorias_caja;
create policy "Ven las categorías" on public.categorias_caja for select to authenticated
  using (dueno_id = auth.uid() or exists (select 1 from complejos x where x.dueno_id = categorias_caja.dueno_id and public.puede_caja(x.id)));
drop policy if exists "Dueño ve sus medios" on public.cuenta_por_medio;
create policy "Dueño ve sus medios" on public.cuenta_por_medio for select to authenticated using (dueno_id = auth.uid());
drop policy if exists "Dueño ve sus socios" on public.socios_caja;
create policy "Dueño ve sus socios" on public.socios_caja for select to authenticated using (dueno_id = auth.uid());
drop policy if exists "Ven sus movimientos" on public.movimientos;
create policy "Ven sus movimientos" on public.movimientos for select to authenticated
  using (dueno_id = auth.uid() or exists (select 1 from caja_turnos t where t.id = movimientos.caja_turno_id and t.usuario = auth.uid()));
drop policy if exists "Dueño ve el historial" on public.movimientos_historial;
create policy "Dueño ve el historial" on public.movimientos_historial for select to authenticated
  using (exists (select 1 from movimientos m where m.id = movimiento_id and m.dueno_id = auth.uid()));

-- ============================================================================================
-- 7. Control: ingresos y gastos por dueño y por mes, libro vs. Caja de hoy (mismas reglas que la pantalla).
--    Del libro cuenta solo lo que viene de las tablas de siempre (lo cargado en la Caja nueva no está en la vieja).
-- ============================================================================================
create or replace function public.control_libro_caja()
returns table (dueno_id uuid, mes text, tipo text, caja_hoy bigint, libro bigint)
language sql stable security definer set search_path = public as $$
  with vieja as (
    select p.organizador_id d, _fecha_ar(p.created_at) f, 'ingreso' t, p.monto m from pagos_inscripcion p
    union all
    select c.dueno_id, r.fecha, 'ingreso', r.precio from reservas r join complejos c on c.id = r.complejo_id
      where r.tipo in ('turno', 'clase') and r.estado = 'confirmada' and r.medio_pago is not null and r.precio is not null
    union all
    select c.dueno_id, _fecha_ar(p.created_at), 'ingreso', p.monto from cuenta_pagos p join complejos c on c.id = p.complejo_id
    union all
    select c.dueno_id, _fecha_ar(p.created_at), 'ingreso', p.monto from venta_pagos p join ventas v on v.id = p.venta_id join complejos c on c.id = p.complejo_id
      where not v.anulada
    union all
    select c.dueno_id, _fecha_ar(m.created_at), m.tipo, m.monto from caja_movimientos_turno m join complejos c on c.id = m.complejo_id
      where m.tipo in ('ingreso', 'gasto')
    union all
    select c.dueno_id, _fecha_ar(q.created_at), 'ingreso', q.monto from cuotas_alumnos q join complejos c on c.id = q.complejo_id
    union all
    select c.dueno_id, _fecha_ar(x.created_at), 'gasto', x.monto from pagos_profes x join complejos c on c.id = x.complejo_id
    union all
    select c.dueno_id, k.pagada_at, 'gasto', k.total from compras k join complejos c on c.id = k.complejo_id
      where not k.anulada and k.pagada_at is not null
    union all
    select m.organizador_id, m.fecha, m.tipo, m.monto from caja_movimientos m
  ), v as (
    select d, to_char(f, 'YYYY-MM') mes, t, round(sum(m) * 100)::bigint total from vieja where d is not null and m > 0 group by 1, 2, 3
  ), l as (
    select dueno_id d, to_char(fecha, 'YYYY-MM') mes, tipo t, sum(monto)::bigint total from movimientos
    where anulado_at is null and tipo in ('ingreso', 'gasto') and ref_tipo is not null group by 1, 2, 3
  )
  select coalesce(v.d, l.d), coalesce(v.mes, l.mes), coalesce(v.t, l.t), coalesce(v.total, 0), coalesce(l.total, 0)
  from v full join l on l.d = v.d and l.mes = v.mes and l.t = v.t
  order by 1, 2, 3;
$$;
revoke all on function public.control_libro_caja() from public, anon, authenticated;

-- ============================================================================================
-- 8. Pasaje de lo que ya existe (se puede correr dos veces: no duplica) y control
-- ============================================================================================
do $$
declare v_mal int;
begin
  perform _libro_inscripcion(id) from pagos_inscripcion;
  perform _libro_turno(id) from reservas where tipo in ('turno', 'clase') and medio_pago is not null;
  perform _libro_cuenta(id) from cuenta_pagos;
  perform _libro_venta(id) from venta_pagos;
  perform _libro_caja_dia(id) from caja_movimientos_turno;
  perform _libro_cuota(id) from cuotas_alumnos;
  perform _libro_pago_profe(id) from pagos_profes;
  perform _libro_compra(id) from compras where pagada_at is not null;
  perform _libro_caja_vieja(id) from caja_movimientos;
  select count(*) into v_mal from control_libro_caja() where caja_hoy <> libro;
  if v_mal > 0 then
    raise exception 'El libro no da igual que la Caja de hoy en % mes(es): no se cambió nada. Ver: select * from control_libro_caja() where caja_hoy <> libro', v_mal;
  end if;
end $$;

-- ============================================================================================
-- 9. Disparadores: desde ahora cada cobro/pago escribe el libro en la misma transacción
-- ============================================================================================
create or replace function public.libro_desde_origen() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  case tg_table_name
    when 'pagos_inscripcion' then perform _libro_inscripcion(v_id);
    when 'reservas' then perform _libro_turno(v_id);
    when 'cuenta_pagos' then perform _libro_cuenta(v_id);
    when 'venta_pagos' then perform _libro_venta(v_id);
    when 'caja_movimientos_turno' then perform _libro_caja_dia(v_id);
    when 'cuotas_alumnos' then perform _libro_cuota(v_id);
    when 'pagos_profes' then perform _libro_pago_profe(v_id);
    when 'compras' then perform _libro_compra(v_id);
    when 'caja_movimientos' then perform _libro_caja_vieja(v_id);
  end case;
  return null;
end; $$;

-- Venta anulada → se anulan sus pagos en el libro
create or replace function public.libro_venta_anulada() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform _libro_venta(id) from venta_pagos where venta_id = new.id;
  return null;
end; $$;
revoke all on function public.libro_desde_origen(), public.libro_venta_anulada() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['pagos_inscripcion', 'cuenta_pagos', 'venta_pagos', 'caja_movimientos_turno', 'cuotas_alumnos',
                           'pagos_profes', 'compras', 'caja_movimientos'] loop
    execute format('drop trigger if exists libro_caja on public.%I', t);
    execute format('create trigger libro_caja after insert or update or delete on public.%I for each row execute function public.libro_desde_origen()', t);
  end loop;
end $$;
-- En los turnos, solo cuando cambia algo que toca la plata
drop trigger if exists libro_caja on public.reservas;
create trigger libro_caja after insert or delete or update of estado, tipo, precio, medio_pago, fecha, nombre, complejo_id, cobrado_por, cobrado_at
  on public.reservas for each row execute function public.libro_desde_origen();
drop trigger if exists libro_venta_anulada on public.ventas;
create trigger libro_venta_anulada after update of anulada on public.ventas
  for each row when (new.anulada and not old.anulada) execute function public.libro_venta_anulada();

-- Vuelta atrás (si hiciera falta; borra el libro entero):
--   drop trigger if exists libro_caja on public.pagos_inscripcion; (y en reservas, cuenta_pagos, venta_pagos,
--     caja_movimientos_turno, cuotas_alumnos, pagos_profes, compras, caja_movimientos)
--   drop trigger if exists libro_venta_anulada on public.ventas;
--   drop function if exists public.libro_desde_origen(), public.libro_venta_anulada(), public.control_libro_caja() cascade;
--   drop view if exists public.movimientos_efecto;
--   drop table if exists public.movimientos_historial, public.movimientos, public.socios_caja, public.categorias_caja,
--     public.cuenta_por_medio, public.cuentas_caja cascade;
