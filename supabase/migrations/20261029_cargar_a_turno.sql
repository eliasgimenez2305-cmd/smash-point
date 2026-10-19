-- Mostrador, "Cargar a": lo que se consume se puede cargar al turno de una cancha y cobrarse después,
-- aparte de la cancha (que casi siempre se paga antes) o junto con ella.
--
-- - ventas.reserva_id + ventas.pendiente: una venta cargada a un turno queda sin pagar (pendiente).
-- - vender() suma p_reserva: con un turno, lo que no se paga queda pendiente en ese turno.
-- - cobrar_consumos_turno(): cobra lo pendiente de un turno con un medio (entra a la caja de quien
--   cobra: venta_pagos.cobrado_por).
-- - pasar_consumos_a_cuenta(): si el turno se cancela o no vinieron, lo pendiente pasa a una cuenta.
-- - turnos_para_cargar(): los turnos de hoy para elegir en el mostrador (también para empleados de
--   la cantina sin acceso a la agenda).
-- - consumos_de_turnos(): lo pendiente de cada turno de un día, para la agenda.
-- - Transferencia y Débito también para cobrar turnos, cuentas e inscripciones.
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261028_clases.sql. Vuelta atrás: al final.

-- ============================================================
-- Medios de pago: los mismos 4 en todos lados (más crédito en el mostrador)
-- ============================================================

alter table public.reservas drop constraint if exists reservas_medio_pago_check;
alter table public.reservas add constraint reservas_medio_pago_check
  check (medio_pago is null or medio_pago in ('efectivo', 'mercado_pago', 'transferencia', 'debito'));
alter table public.cuenta_pagos drop constraint if exists cuenta_pagos_medio_check;
alter table public.cuenta_pagos add constraint cuenta_pagos_medio_check
  check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito'));
alter table public.pagos_inscripcion drop constraint if exists pagos_inscripcion_medio_check;
alter table public.pagos_inscripcion add constraint pagos_inscripcion_medio_check
  check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito'));

-- ============================================================
-- Ventas cargadas a un turno
-- ============================================================

alter table public.ventas add column if not exists reserva_id uuid references public.reservas(id) on delete set null;
alter table public.ventas add column if not exists pendiente numeric(12, 2) not null default 0 check (pendiente >= 0);
create index if not exists ventas_por_reserva on public.ventas (reserva_id) where reserva_id is not null;
-- Quién cobró cada pago (lo pendiente de un turno lo puede cobrar otra persona más tarde)
alter table public.venta_pagos add column if not exists cobrado_por uuid default auth.uid();

-- ¿Puede manejar los consumos de los turnos de este complejo? (dueño, agenda o cantina)
create or replace function public.puede_turnos_consumos(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_dueno_complejo(p_complejo) or public.colaborador_permiso(p_complejo, 'agenda') or public.puede_consumos(p_complejo);
$$;
revoke all on function public.puede_turnos_consumos(text) from public, anon;
grant execute on function public.puede_turnos_consumos(text) to authenticated;

-- vender() con un parámetro más: se reemplaza la versión anterior
drop function if exists public.vender(text, jsonb, jsonb, numeric, uuid);

create or replace function public.vender(p_complejo text, p_items jsonb, p_pagos jsonb, p_ajuste numeric default 0, p_cuenta uuid default null, p_reserva uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venta uuid := gen_random_uuid();
  v_numero bigint;
  v_item jsonb;
  v_pago jsonb;
  v_p productos%rowtype;
  v_cant int;
  v_precio numeric;
  v_desc text;
  v_item_id uuid;
  v_subtotal numeric := 0;
  v_total numeric;
  v_pagado numeric := 0;
  v_resto numeric;
  v_consumo uuid;
  v_email text := (select email from auth.users where id = auth.uid());
  v_nombres text := '';
begin
  if not public.puede_consumos(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'datos_invalidos';
  end if;
  if p_pagos is null or jsonb_typeof(p_pagos) <> 'array' or jsonb_array_length(p_pagos) > 10 then
    raise exception 'datos_invalidos';
  end if;
  if p_cuenta is not null and p_reserva is not null then
    raise exception 'datos_invalidos';
  end if;
  if p_cuenta is not null and not exists (select 1 from cuentas where id = p_cuenta and complejo_id = p_complejo) then
    raise exception 'cuenta_invalida';
  end if;
  if p_reserva is not null and not exists (
    select 1 from reservas where id = p_reserva and complejo_id = p_complejo and tipo in ('turno', 'clase') and estado = 'confirmada'
  ) then
    raise exception 'turno_invalido';
  end if;

  insert into ventas (id, complejo_id, subtotal, ajuste, total, vendido_por, vendido_por_email)
  values (v_venta, p_complejo, 0, 0, 0, auth.uid(), v_email)
  returning numero into v_numero;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item ->> 'cantidad')::int;
    if v_cant is null or v_cant < 1 or v_cant > 999 then
      raise exception 'datos_invalidos';
    end if;
    v_item_id := gen_random_uuid();
    if v_item ? 'producto_id' then
      select * into v_p from productos where id = (v_item ->> 'producto_id')::uuid and complejo_id = p_complejo for update;
      if not found then
        raise exception 'producto_invalido';
      end if;
      insert into venta_items (id, venta_id, complejo_id, producto_id, descripcion, rubro, cantidad, precio_unitario)
      values (v_item_id, v_venta, p_complejo, v_p.id, v_p.nombre, v_p.rubro, v_cant, v_p.precio);
      insert into venta_items_costo (item_id, complejo_id, costo_unitario)
      select v_item_id, p_complejo, c.costo from producto_costos c where c.producto_id = v_p.id;
      if v_p.stock is not null then
        update productos set stock = stock - v_cant where id = v_p.id;
      end if;
      v_subtotal := v_subtotal + v_cant * v_p.precio;
      v_nombres := v_nombres || case when v_nombres = '' then '' else ', ' end || v_p.nombre;
    else
      v_desc := btrim(coalesce(v_item ->> 'descripcion', ''));
      v_precio := (v_item ->> 'precio')::numeric;
      if v_desc = '' or char_length(v_desc) > 60 or v_precio is null or v_precio < 0 or v_precio >= 100000000 then
        raise exception 'datos_invalidos';
      end if;
      insert into venta_items (id, venta_id, complejo_id, descripcion, cantidad, precio_unitario)
      values (v_item_id, v_venta, p_complejo, v_desc, v_cant, v_precio);
      v_subtotal := v_subtotal + v_cant * v_precio;
      v_nombres := v_nombres || case when v_nombres = '' then '' else ', ' end || v_desc;
    end if;
  end loop;

  v_total := v_subtotal + coalesce(p_ajuste, 0);
  if v_total < 0 or coalesce(p_ajuste, 0) < -v_subtotal or coalesce(p_ajuste, 0) > v_subtotal then
    raise exception 'ajuste_invalido';
  end if;

  for v_pago in select * from jsonb_array_elements(p_pagos) loop
    if (v_pago ->> 'monto')::numeric is null or (v_pago ->> 'monto')::numeric <= 0 then
      raise exception 'datos_invalidos';
    end if;
    insert into venta_pagos (venta_id, complejo_id, medio, monto)
    values (v_venta, p_complejo, v_pago ->> 'medio', (v_pago ->> 'monto')::numeric);
    v_pagado := v_pagado + (v_pago ->> 'monto')::numeric;
  end loop;

  if v_pagado > v_total then
    raise exception 'pago_de_mas';
  end if;
  v_resto := v_total - v_pagado;
  if v_resto > 0 and p_reserva is null then
    if p_cuenta is null then
      raise exception 'falta_pagar';
    end if;
    insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
    values (p_complejo, p_cuenta, left('Venta #' || v_numero || ': ' || v_nombres, 60), 1, v_resto)
    returning id into v_consumo;
  end if;

  update ventas set subtotal = v_subtotal, ajuste = coalesce(p_ajuste, 0), total = v_total,
         cuenta_id = case when v_resto > 0 and p_reserva is null then p_cuenta end, consumo_id = v_consumo,
         a_cuenta = case when p_reserva is null then v_resto else 0 end,
         reserva_id = p_reserva, pendiente = case when p_reserva is not null then v_resto else 0 end
   where id = v_venta;

  return jsonb_build_object('venta_id', v_venta, 'numero', v_numero, 'total', v_total,
    'a_cuenta', case when p_reserva is null then v_resto else 0 end,
    'pendiente', case when p_reserva is not null then v_resto else 0 end);
end;
$$;

revoke all on function public.vender(text, jsonb, jsonb, numeric, uuid, uuid) from public, anon;
grant execute on function public.vender(text, jsonb, jsonb, numeric, uuid, uuid) to authenticated;

-- Anular: además, lo pendiente de un turno deja de estarlo
create or replace function public.anular_venta(p_venta uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v ventas%rowtype;
begin
  select * into v from ventas where id = p_venta for update;
  if not found or not public.es_dueno_complejo(v.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if v.anulada then
    return;
  end if;
  update productos p set stock = p.stock + i.cantidad
    from venta_items i
   where i.venta_id = v.id and i.producto_id = p.id and p.stock is not null;
  if v.consumo_id is not null then
    delete from cuenta_consumos where id = v.consumo_id;
  end if;
  update ventas set anulada = true, anulada_at = now(), pendiente = 0 where id = v.id;
end;
$$;

-- Cobrar lo pendiente de un turno, con un medio. Devuelve cuánto se cobró.
create or replace function public.cobrar_consumos_turno(p_reserva uuid, p_medio text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complejo text := (select complejo_id from reservas where id = p_reserva);
  v ventas%rowtype;
  v_total numeric := 0;
begin
  if v_complejo is null or not public.puede_turnos_consumos(v_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_medio is null or p_medio not in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito') then
    raise exception 'datos_invalidos';
  end if;
  for v in select * from ventas where reserva_id = p_reserva and pendiente > 0 and not anulada for update loop
    insert into venta_pagos (venta_id, complejo_id, medio, monto) values (v.id, v.complejo_id, p_medio, v.pendiente);
    update ventas set pendiente = 0 where id = v.id;
    v_total := v_total + v.pendiente;
  end loop;
  return v_total;
end;
$$;
revoke all on function public.cobrar_consumos_turno(uuid, text) from public, anon;
grant execute on function public.cobrar_consumos_turno(uuid, text) to authenticated;

-- Pasar lo pendiente de un turno a una cuenta (turno cancelado o no vinieron). Devuelve cuánto pasó.
create or replace function public.pasar_consumos_a_cuenta(p_reserva uuid, p_cuenta uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complejo text := (select complejo_id from reservas where id = p_reserva);
  v ventas%rowtype;
  v_consumo uuid;
  v_total numeric := 0;
begin
  if v_complejo is null or not public.puede_turnos_consumos(v_complejo) then
    raise exception 'no_autorizado';
  end if;
  if not exists (select 1 from cuentas where id = p_cuenta and complejo_id = v_complejo) then
    raise exception 'cuenta_invalida';
  end if;
  for v in select * from ventas where reserva_id = p_reserva and pendiente > 0 and not anulada for update loop
    insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
    values (v.complejo_id, p_cuenta, left('Venta #' || v.numero || ' (turno)', 60), 1, v.pendiente)
    returning id into v_consumo;
    update ventas set cuenta_id = p_cuenta, consumo_id = v_consumo, a_cuenta = v.pendiente, pendiente = 0 where id = v.id;
    v_total := v_total + v.pendiente;
  end loop;
  return v_total;
end;
$$;
revoke all on function public.pasar_consumos_a_cuenta(uuid, uuid) from public, anon;
grant execute on function public.pasar_consumos_a_cuenta(uuid, uuid) to authenticated;

-- Turnos de hoy (Argentina) para cargarles consumos desde el mostrador
create or replace function public.turnos_para_cargar(p_complejo text)
returns table (id uuid, cancha text, inicio timestamptz, fin timestamptz, nombre text, telefono text, cobrado boolean, pendiente numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.puede_turnos_consumos(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  return query
    select r.id, c.nombre, r.inicio, r.fin, r.nombre, r.telefono, r.medio_pago is not null,
           coalesce((select sum(v.pendiente) from ventas v where v.reserva_id = r.id and not v.anulada), 0)
      from reservas r join canchas c on c.id = r.cancha_id
     where r.complejo_id = p_complejo and r.tipo = 'turno' and r.estado = 'confirmada'
       and r.fecha = (now() at time zone 'America/Argentina/Buenos_Aires')::date
     order by r.inicio, c.orden, c.nombre;
end;
$$;
revoke all on function public.turnos_para_cargar(text) from public, anon;
grant execute on function public.turnos_para_cargar(text) to authenticated;

-- Consumos de los turnos de un día, para la agenda: lo pendiente y el detalle
create or replace function public.consumos_de_turnos(p_complejo text, p_fecha date)
returns table (reserva_id uuid, pendiente numeric, cobrado numeric, detalle text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.puede_turnos_consumos(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  return query
    select v.reserva_id, sum(v.pendiente), sum(v.total - v.pendiente - v.a_cuenta),
           string_agg(i.det, ', ' order by i.det)
      from ventas v
      join reservas r on r.id = v.reserva_id
      cross join lateral (select string_agg(case when vi.cantidad > 1 then vi.cantidad || ' ' else '' end || vi.descripcion, ', ') as det from venta_items vi where vi.venta_id = v.id) i
     where v.complejo_id = p_complejo and r.fecha = p_fecha and not v.anulada
     group by v.reserva_id;
end;
$$;
revoke all on function public.consumos_de_turnos(text, date) from public, anon;
grant execute on function public.consumos_de_turnos(text, date) to authenticated;

-- ============================================================
-- Caja del día: el pago de un consumo cuenta para quien lo cobró
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
     where v.complejo_id = t.complejo_id and coalesce(p.cobrado_por, v.vendido_por) = t.usuario and not v.anulada
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
-- Vuelta atrás (correr a mano si hiciera falta; antes, cobrar o pasar a cuenta lo pendiente):
--   drop function if exists public.consumos_de_turnos(text, date), public.turnos_para_cargar(text),
--     public.pasar_consumos_a_cuenta(uuid, uuid), public.cobrar_consumos_turno(uuid, text),
--     public.puede_turnos_consumos(text), public.vender(text, jsonb, jsonb, numeric, uuid, uuid);
--   y volver a correr vender() y _resumen_turno() de 20261024_mostrador.sql y 20261028_clases.sql;
--   alter table public.ventas drop column if exists reserva_id, drop column if exists pendiente;
--   alter table public.venta_pagos drop column if exists cobrado_por;
--   (los medios: volver a los checks anteriores solo si no hay pagos con 'transferencia'/'debito')
-- ============================================================
