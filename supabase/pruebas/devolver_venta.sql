-- Pruebas de 20261051_devolver_venta.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Complejo nuevo del organizador de prueba, un producto con stock y un empleado con consumos
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('emp', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', '5493446999761', now(), now(), now() from ids where clave = 'emp';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-devol', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, telefono, p_agenda, p_consumos) values ('cprueba-devol', '5493446999761', true, true);
with p as (insert into productos (complejo_id, nombre, precio, stock) values ('cprueba-devol', 'Agua', 1000, 10) returning id)
insert into ids select 'agua', id::text from p;

create temp view mov as
  select m.*, c.nombre as cuenta, k.clave as cat from movimientos m join cuentas_caja c on c.id = m.cuenta_id left join categorias_caja k on k.id = m.categoria_id;
grant select on mov to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_agua uuid := (select valor::uuid from ids where clave = 'agua');
  c1 uuid; c2 uuid; a uuid; b uuid; m uuid; e uuid; s uuid; x jsonb; v_cf_antes bigint; v_mp_antes bigint;
begin
  -- Caja 1 (abierta hace 3 horas): venta A de un agua en efectivo hace 2 horas
  c1 := abrir_caja_conteo('cprueba-devol', '{}');
  update caja_turnos set abierta_at = now() - interval '3 hours' where id = c1;
  insert into ventas (complejo_id, subtotal, total, vendido_por, created_at) values ('cprueba-devol', 1000, 1000, v_org, now() - interval '2 hours') returning id into a;
  insert into venta_items (venta_id, complejo_id, producto_id, descripcion, cantidad, precio_unitario) values (a, 'cprueba-devol', v_agua, 'Agua', 1, 1000);
  update productos set stock = stock - 1 where id = v_agua;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por, created_at) values (a, 'cprueba-devol', 'efectivo', 1000, v_org, now() - interval '2 hours');
  insert into ids values ('a', a::text);
  x := cerrar_caja_conteo(c1, '{"1000": 1}');
  insert into resultados (caso, ok, detalle) values ('Caja 1 cierra justa con la venta A', (x->>'diferencia')::numeric = 0, x::text);

  begin
    perform anular_venta(a);
    insert into resultados (caso, ok) values ('Con la caja cerrada, anular avisa que hay que devolver', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Con la caja cerrada, anular avisa que hay que devolver', sqlerrm = 'usar_devolucion', sqlerrm); end;
  begin
    perform devolver_venta(a, ' ');
    insert into resultados (caso, ok) values ('Devolver pide motivo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Devolver pide motivo', sqlerrm = 'falta_motivo', sqlerrm); end;

  -- Caja 2 con fondo de $10.000: la devolución de A sale de esta caja
  c2 := abrir_caja_conteo('cprueba-devol', '{"10000": 1}');
  insert into ids values ('c2', c2::text);
  x := devolver_venta(a, 'Estaba vencida');
  insert into resultados (caso, ok, detalle) values ('Devolver A: vuelve el stock y la venta queda devuelta',
    (select stock from productos where id = v_agua) = 10 and (select anulada and devuelta and devolucion_motivo = 'Estaba vencida' from ventas where id = a), x::text);
  insert into resultados (caso, ok) values ('El ingreso original de A queda en el libro (no se toca el día cerrado)',
    exists (select 1 from movimientos where ref_tipo = 'venta' and ref_id = a::text and anulado_at is null));
  insert into resultados (caso, ok, detalle) values ('La devolución es un gasto Devoluciones de hoy, en Efectivo y en la caja 2',
    exists (select 1 from mov where ref_tipo = 'devolucion' and ref_id = a::text and tipo = 'gasto' and cat = 'devoluciones'
            and cuenta = 'Efectivo' and caja_turno_id = c2 and monto = 100000 and fecha = _fecha_ar(now())),
    (select string_agg(cuenta || ' ' || coalesce(cat, '-') || ' ' || monto || ' ' || coalesce(left(caja_turno_id::text, 6), '-'), ', ') from mov where ref_tipo = 'devolucion'));
  insert into resultados (caso, ok, detalle) values ('La caja 2 espera $9.000 (fondo menos la devolución)',
    (_resumen_turno(c2)->>'efectivo_esperado')::numeric = 9000, _resumen_turno(c2)::text);

  -- Venta B en la caja 2 abierta: se anula directo, como siempre
  insert into ventas (complejo_id, subtotal, total, vendido_por) values ('cprueba-devol', 1000, 1000, v_org) returning id into b;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por) values (b, 'cprueba-devol', 'efectivo', 1000, v_org);
  perform anular_venta(b);
  insert into resultados (caso, ok) values ('Venta de la caja abierta: se anula directo y sale del libro',
    (select anulada and not devuelta from ventas where id = b) and not exists (select 1 from movimientos where ref_tipo = 'venta' and ref_id = b::text and anulado_at is null));
  x := cerrar_caja_conteo(c2, '{"1000": 9}');
  insert into resultados (caso, ok, detalle) values ('La caja 2 cierra justa con $9.000', (x->>'diferencia')::numeric = 0, x::text);

  -- Venta de ayer con Mercado Pago, sin caja abierta: sale de Mercado Pago
  v_mp_antes := (select saldo from saldos_cuentas() s join cuentas_caja c on c.id = s.cuenta_id where c.dueno_id = v_org and c.nombre = 'Mercado Pago');
  insert into ventas (complejo_id, subtotal, total, vendido_por, created_at) values ('cprueba-devol', 2500, 2500, v_org, now() - interval '1 day') returning id into m;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por, created_at) values (m, 'cprueba-devol', 'mercado_pago', 2500, v_org, now() - interval '1 day');
  perform devolver_venta(m, 'Cobro repetido');
  insert into resultados (caso, ok) values ('Venta de ayer con Mercado Pago: la devolución sale de Mercado Pago y el saldo queda igual que antes de la venta',
    exists (select 1 from mov where ref_tipo = 'devolucion' and ref_id = m::text and cuenta = 'Mercado Pago' and caja_turno_id is null)
    and (select saldo from saldos_cuentas() s join cuentas_caja c on c.id = s.cuenta_id where c.dueno_id = v_org and c.nombre = 'Mercado Pago') = v_mp_antes);

  -- Venta de ayer en efectivo, sin caja abierta: sale de la Caja fuerte
  v_cf_antes := (select saldo from saldos_cuentas() s join cuentas_caja c on c.id = s.cuenta_id where c.dueno_id = v_org and c.nombre = 'Caja fuerte');
  insert into ventas (complejo_id, subtotal, total, vendido_por, created_at) values ('cprueba-devol', 1500, 1500, v_org, now() - interval '1 day') returning id into e;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por, created_at) values (e, 'cprueba-devol', 'efectivo', 1500, v_org, now() - interval '1 day');
  perform devolver_venta(e, 'No le gustó');
  insert into resultados (caso, ok) values ('Venta de ayer en efectivo sin caja abierta: sale de la Caja fuerte',
    exists (select 1 from mov where ref_tipo = 'devolucion' and ref_id = e::text and cuenta = 'Caja fuerte')
    and (select saldo from saldos_cuentas() s join cuentas_caja c on c.id = s.cuenta_id where c.dueno_id = v_org and c.nombre = 'Caja fuerte') = v_cf_antes - 150000);

  -- Sin plata: no sale nada
  insert into ventas (complejo_id, subtotal, total, vendido_por, created_at) values ('cprueba-devol', 800, 800, v_org, now() - interval '1 day') returning id into s;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por, created_at) values (s, 'cprueba-devol', 'efectivo', 800, v_org, now() - interval '1 day');
  insert into ids values ('s', s::text);
  x := devolver_venta(s, 'Cambio por otra cosa', null, true);
  insert into resultados (caso, ok, detalle) values ('Sin plata: la venta queda devuelta y no hay movimiento de devolución',
    (select devuelta from ventas where id = s) and not exists (select 1 from movimientos where ref_tipo = 'devolucion' and ref_id = s::text), x::text);
  begin
    perform devolver_venta(s, 'Otra vez');
    insert into resultados (caso, ok) values ('No se devuelve dos veces', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se devuelve dos veces', sqlerrm = 'ya_anulada', sqlerrm); end;
end $$;

-- El empleado no devuelve
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'emp'), 'role', 'authenticated')::text, true);
do $$
declare v uuid;
begin
  insert into ventas (complejo_id, subtotal, total, vendido_por, created_at) values ('cprueba-devol', 500, 500, auth.uid(), now() - interval '1 day') returning id into v;
  perform devolver_venta(v, 'Prueba');
  insert into resultados (caso, ok) values ('El empleado no puede devolver', false);
exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no puede devolver', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

-- El control contra la Caja de antes sigue dando igual
insert into resultados (caso, ok, detalle) select 'Control: libro = Caja de hoy',
  not exists (select 1 from control_libro_caja() where caja_hoy <> libro),
  (select string_agg(mes || ' ' || tipo || ' ' || caja_hoy || '/' || libro, ', ') from control_libro_caja() where caja_hoy <> libro);

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_DEVOL' as fin from resultados;
rollback;
