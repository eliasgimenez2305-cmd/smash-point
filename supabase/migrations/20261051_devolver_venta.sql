-- Devolver una venta del mostrador después del cierre.
--
-- Antes, anular una venta borraba su ingreso del día en que se cobró, aunque esa caja ya estuviera
-- cerrada y la plata pasada a la Caja fuerte: el Efectivo quedaba en negativo y cambiaba un día ya cuadrado.
-- Ahora:
-- - Si la venta tiene pagos y es de un día anterior, o su efectivo quedó en una caja del día ya cerrada,
--   anular_venta() avisa 'usar_devolucion' y se usa devolver_venta().
-- - devolver_venta(): solo el dueño y con motivo. El stock vuelve y la venta queda anulada (ventas.devuelta),
--   pero su ingreso original queda en el libro; la plata que sale se anota HOY como gasto "Devoluciones":
--   en efectivo, de la caja del día abierta de quien devuelve (el arqueo la descuenta) o, sin caja, de la
--   cuenta de guardado (Caja fuerte); con otros medios, de la cuenta de ese medio; o de la cuenta que se elija.
--   Con p_sin_plata no sale plata (el cliente se lleva otra cosa o queda a favor).
-- - Antes del cierre, todo sigue igual: se anula directo.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261050.

alter table public.ventas add column if not exists devuelta boolean not null default false;
alter table public.ventas add column if not exists devolucion_motivo text;

alter table public.movimientos drop constraint if exists movimientos_ref_tipo_check;
alter table public.movimientos add constraint movimientos_ref_tipo_check check (ref_tipo in ('inscripcion', 'turno', 'cuenta', 'venta', 'caja_dia',
  'cuota_clase', 'pago_profe', 'compra', 'caja_vieja', 'caja_apertura', 'caja_cierre', 'devolucion'));

-- Categoría "Devoluciones" (gasto) para los dueños que ya tienen la caja armada; los nuevos la reciben al preparar.
-- Si alguno ya se había hecho una "Devoluciones" de gasto, se usa esa.
update public.categorias_caja k set clave = 'devoluciones'
where k.tipo = 'gasto' and lower(btrim(k.nombre)) = 'devoluciones' and k.clave is null
  and not exists (select 1 from public.categorias_caja o where o.dueno_id = k.dueno_id and o.clave = 'devoluciones');
insert into public.categorias_caja (dueno_id, tipo, nombre, clave, orden)
select distinct dueno_id, 'gasto', 'Devoluciones', 'devoluciones', 10 from public.cuentas_caja
on conflict do nothing;

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
    (p_dueno, 'gasto', 'Devoluciones', 'devoluciones', 10), (p_dueno, 'gasto', 'Otros gastos', 'otros_gastos', 99)
  on conflict do nothing;
end; $$;

-- El ingreso de una venta devuelta queda en el libro (la devolución es otro movimiento, con su fecha)
create or replace function public._libro_venta(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p venta_pagos%rowtype; v ventas%rowtype; v_dueno uuid; v_quien uuid;
begin
  select * into p from venta_pagos where id = p_id;
  select * into v from ventas where id = p.venta_id;
  select dueno_id into v_dueno from complejos where id = p.complejo_id;
  v_quien := coalesce(p.cobrado_por, v.vendido_por);
  perform _libro_poner('venta', p_id, p.id is not null and (not coalesce(v.anulada, true) or v.devuelta), v_dueno, p.complejo_id, 'ingreso', 'mostrador',
    p.monto, p.medio, 'Mostrador · venta #' || coalesce(v.numero::text, '?'), _fecha_ar(p.created_at), v_quien, v.id::text,
    _caja_del_dia(p.complejo_id, v_quien, p.medio, p.created_at), 'Venta anulada');
end; $$;

-- ¿La venta ya quedó en un cierre? (tiene pagos y es de otro día, o su efectivo está en una caja del día cerrada)
create or replace function public._venta_cerrada(p_venta uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from venta_pagos p join ventas v on v.id = p.venta_id
    where p.venta_id = p_venta
      and (_fecha_ar(p.created_at) < _fecha_ar(now())
           or exists (select 1 from caja_turnos t where t.id = _caja_del_dia(p.complejo_id, coalesce(p.cobrado_por, v.vendido_por), p.medio, p.created_at)
                        and t.cerrada_at is not null)));
$$;
revoke all on function public._venta_cerrada(uuid) from public, anon, authenticated;

-- El stock de una venta vuelve a los productos (o a sus talles)
create or replace function public._reponer_stock_venta(p_venta uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i record;
begin
  for i in select vi.producto_id, vi.talle, vi.cantidad from venta_items vi
            join productos p on p.id = vi.producto_id
           where vi.venta_id = p_venta loop
    -- Si el talle ya no existe (o el producto dejó de tener talles), el stock vuelve al producto
    if i.talle is not null and exists (select 1 from producto_talles where producto_id = i.producto_id and talle = i.talle) then
      update producto_talles set stock = stock + i.cantidad where producto_id = i.producto_id and talle = i.talle;
    elsif not public.tiene_talles(i.producto_id) then
      update productos set stock = stock + i.cantidad where id = i.producto_id and stock is not null;
    end if;
  end loop;
end; $$;
revoke all on function public._reponer_stock_venta(uuid) from public, anon, authenticated;

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
  if public._venta_cerrada(v.id) then
    raise exception 'usar_devolucion';
  end if;
  perform _reponer_stock_venta(v.id);
  if v.consumo_id is not null then
    delete from cuenta_consumos where id = v.consumo_id;
  end if;
  update ventas set anulada = true, anulada_at = now(), pendiente = 0 where id = v.id;
end;
$$;

create or replace function public.devolver_venta(p_venta uuid, p_motivo text, p_cuenta uuid default null, p_sin_plata boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v ventas%rowtype;
  p record;
  v_dueno uuid;
  v_caja uuid;
  v_cuenta uuid;
  v_hoy date := _fecha_ar(now());
  v_total numeric := 0;
begin
  select * into v from ventas where id = p_venta for update;
  if not found or not public.es_dueno_complejo(v.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if v.anulada then
    raise exception 'ya_anulada';
  end if;
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'falta_motivo';
  end if;
  select dueno_id into v_dueno from complejos where id = v.complejo_id;
  perform _preparar_dueno(v_dueno);
  if p_cuenta is not null and not exists (select 1 from cuentas_caja where id = p_cuenta and dueno_id = v_dueno and activa) then
    raise exception 'cuenta_invalida';
  end if;

  perform _reponer_stock_venta(v.id);
  if v.consumo_id is not null then
    delete from cuenta_consumos where id = v.consumo_id;
  end if;
  update ventas set anulada = true, anulada_at = now(), pendiente = 0, devuelta = true, devolucion_motivo = btrim(p_motivo) where id = v.id;

  if not coalesce(p_sin_plata, false) then
    select id into v_caja from caja_turnos where complejo_id = v.complejo_id and usuario = auth.uid() and cerrada_at is null limit 1;
    for p in select * from venta_pagos where venta_id = v.id loop
      v_cuenta := coalesce(p_cuenta,
        case when p.medio = 'efectivo' and v_caja is null then _cuenta_guardado(v_dueno) else _cuenta_de_medio(v_dueno, v.complejo_id, p.medio) end);
      insert into movimientos (dueno_id, complejo_id, tipo, categoria_id, cuenta_id, sentido, monto, medio, concepto, fecha,
                               cargado_por, caja_turno_id, ref_tipo, ref_id, ref_pago_id)
      values (v_dueno, v.complejo_id, 'gasto', coalesce(_categoria(v_dueno, 'devoluciones'), _categoria(v_dueno, 'otros_gastos')), v_cuenta, -1, round(p.monto * 100)::bigint, p.medio,
              'Devolución · venta #' || v.numero, v_hoy, auth.uid(),
              case when p.medio = 'efectivo' and v_cuenta = _cuenta_de_medio(v_dueno, v.complejo_id, 'efectivo') then v_caja end,
              'devolucion', v.id::text, p.id);
      v_total := v_total + p.monto;
    end loop;
  end if;
  return jsonb_build_object('devuelto', v_total, 'caja', v_caja);
end;
$$;
revoke all on function public.devolver_venta(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.devolver_venta(uuid, text, uuid, boolean) to authenticated;

-- La caja del día descuenta las devoluciones en efectivo que salieron de ella (y sigue contando el cobro
-- original de una venta devuelta, que sí entró en su momento)
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
  v_dev numeric;
begin
  select * into t from caja_turnos where id = p_turno;
  v_hasta := coalesce(t.cerrada_at, now());
  select dueno_id into v_dueno from complejos where id = t.complejo_id;

  with cobros (origen, medio, monto) as (
    select 'mostrador', p.medio, p.monto
      from venta_pagos p join ventas v on v.id = p.venta_id
     where v.complejo_id = t.complejo_id and coalesce(p.cobrado_por, v.vendido_por) = t.usuario and (not v.anulada or v.devuelta)
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

  select coalesce(sum(monto), 0) / 100.0 into v_dev
    from movimientos where caja_turno_id = t.id and ref_tipo = 'devolucion' and anulado_at is null;

  return jsonb_build_object(
    'por_medio', v_por_medio, 'por_origen', v_por_origen,
    'fondo', t.fondo, 'efectivo_cobrado', v_efectivo,
    'ingresos', v_ing, 'retiros', v_ret, 'gastos', v_gas, 'devoluciones', v_dev,
    'efectivo_esperado', t.fondo + v_efectivo + v_ing - v_ret - v_gas - v_dev
  );
end;
$$;
revoke all on function public._resumen_turno(uuid) from public, anon, authenticated;

-- El control contra la Caja de antes: las ventas devueltas siguen siendo ingreso y las devoluciones no cuentan
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
      where not v.anulada or v.devuelta
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
    where anulado_at is null and tipo in ('ingreso', 'gasto') and ref_tipo is not null and ref_tipo <> 'devolucion' group by 1, 2, 3
  )
  select coalesce(v.d, l.d), coalesce(v.mes, l.mes), coalesce(v.t, l.t), coalesce(v.total, 0), coalesce(l.total, 0)
  from v full join l on l.d = v.d and l.mes = v.mes and l.t = v.t
  order by 1, 2, 3;
$$;

-- Vuelta atrás (si hiciera falta): volver a correr anular_venta() de 20261030, _libro_venta(), _preparar_dueno()
--   y control_libro_caja() de 20261045, el check de ref_tipo de 20261046 y _resumen_turno() de 20261029;
--   drop function if exists public.devolver_venta(uuid, text, uuid, boolean), public._venta_cerrada(uuid), public._reponer_stock_venta(uuid);
--   (las columnas ventas.devuelta y devolucion_motivo y la categoría Devoluciones pueden quedar)
