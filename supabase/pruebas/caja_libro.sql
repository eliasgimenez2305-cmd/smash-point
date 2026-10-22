-- Pruebas de 20261045_caja_libro.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación: complejo nuevo del organizador de prueba, con una cancha, y otra cuenta cualquiera
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('otro', gen_random_uuid()::text);
insert into auth.users (id, aud, role, email, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', 'otro@inventado.test', now(), now() from ids where clave = 'otro';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-libro', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-libro', 'Cancha 1', '00:00', '23:30') returning id)
insert into ids select 'cancha', id::text from c;

create temp view mov as
  select m.*, c.nombre as cuenta, k.clave as cat from movimientos m join cuentas_caja c on c.id = m.cuenta_id left join categorias_caja k on k.id = m.categoria_id;
grant select on mov to authenticated;

-- Los cobros de siempre escriben el libro solos (con la sesión del dueño: un turno cobrado solo lo cambia él)
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  d date := current_date;
  r uuid; v uuid; vp uuid; k uuid; cm uuid; t uuid; ct uuid;
begin
  -- Turno cobrado
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
  values ('cprueba-libro', v_cancha, d, d + time '10:00', d + time '11:00', 'Perez', 1000, 'efectivo') returning id into r;
  insert into ids values ('turno', r::text);
  insert into resultados (caso, ok, detalle) values ('Turno cobrado: ingreso Turnos en Efectivo por $1.000',
    exists (select 1 from mov where ref_tipo = 'turno' and ref_pago_id = r and anulado_at is null and monto = 100000 and cuenta = 'Efectivo' and cat = 'turnos' and tipo = 'ingreso'),
    (select string_agg(cuenta || ' ' || monto || ' ' || cat, ', ') from mov where ref_pago_id = r));
  update reservas set precio = 1500 where id = r;
  insert into resultados (caso, ok) values ('Cambia el precio: se corrige el monto y queda historial',
    (select monto from movimientos where ref_pago_id = r and anulado_at is null) = 150000
    and exists (select 1 from movimientos_historial h join movimientos m on m.id = h.movimiento_id where m.ref_pago_id = r and h.accion = 'edicion'));
  update reservas set medio_pago = 'transferencia' where id = r;
  insert into resultados (caso, ok) values ('Cambia el medio a transferencia: pasa a la cuenta Banco',
    (select cuenta from mov where ref_pago_id = r and anulado_at is null) = 'Banco');
  update reservas set estado = 'cancelada', cancelada_at = now() where id = r;
  insert into resultados (caso, ok) values ('Turno cancelado: el movimiento queda anulado (no se borra)',
    not exists (select 1 from movimientos where ref_pago_id = r and anulado_at is null) and exists (select 1 from movimientos where ref_pago_id = r));

  -- Mostrador: venta con dos pagos, después anulada
  insert into ventas (complejo_id, subtotal, total, vendido_por) values ('cprueba-libro', 3000, 3000, v_org) returning id into v;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por) values (v, 'cprueba-libro', 'efectivo', 1000, v_org), (v, 'cprueba-libro', 'mercado_pago', 2000, v_org);
  insert into resultados (caso, ok) values ('Venta con efectivo + MP: dos movimientos en sus cuentas',
    (select string_agg(cuenta, ',' order by cuenta) from mov where ref_tipo = 'venta' and ref_id = v::text and anulado_at is null) = 'Efectivo,Mercado Pago');
  update ventas set anulada = true, anulada_at = now() where id = v;
  insert into resultados (caso, ok) values ('Venta anulada: se anulan sus dos movimientos',
    (select count(*) from movimientos where ref_tipo = 'venta' and ref_id = v::text and anulado_motivo = 'Venta anulada') = 2);

  -- Compra: sin pagar no cuenta; pagada sí
  insert into compras (complejo_id, fecha, total) values ('cprueba-libro', d, 5000) returning id into k;
  insert into resultados (caso, ok) values ('Compra sin pagar: no hay gasto', not exists (select 1 from movimientos where ref_pago_id = k));
  update compras set medio = 'debito', pagada_at = d where id = k;
  insert into resultados (caso, ok) values ('Compra pagada con débito: gasto Proveedores en Posnet',
    exists (select 1 from mov where ref_pago_id = k and anulado_at is null and tipo = 'gasto' and cat = 'proveedores' and cuenta = 'Posnet' and sentido = -1));

  -- Caja de hoy: gasto cargado a mano y borrado
  insert into caja_movimientos (organizador_id, fecha, tipo, concepto, monto, medio) values (v_org, d, 'gasto', '-', 700, 'efectivo') returning id into cm;
  insert into resultados (caso, ok, detalle) values ('Gasto viejo con concepto "-": entra con concepto de repuesto',
    (select concepto from movimientos where ref_pago_id = cm and anulado_at is null) = 'Gasto sin concepto', (select concepto from movimientos where ref_pago_id = cm));
  delete from caja_movimientos where id = cm;
  insert into resultados (caso, ok) values ('Gasto viejo borrado: queda anulado', not exists (select 1 from movimientos where ref_pago_id = cm and anulado_at is null));

  -- Caja del día: retiro = retiro de socio (no es gasto); cobro en efectivo con la caja abierta
  insert into caja_turnos (complejo_id, usuario, fondo) values ('cprueba-libro', v_org, 0) returning id into t;
  insert into caja_movimientos_turno (turno_id, complejo_id, tipo, concepto, monto) values (t, 'cprueba-libro', 'retiro', 'Retiro', 400) returning id into ct;
  insert into resultados (caso, ok) values ('Retiro de la caja del día: retiro de socio desde Efectivo',
    exists (select 1 from mov where ref_pago_id = ct and tipo = 'retiro_socio' and cuenta = 'Efectivo' and categoria_id is null and caja_turno_id = t));
end $$;

-- El control da igual que la Caja de hoy
insert into resultados (caso, ok, detalle) select 'Control: libro = Caja de hoy en todos los meses',
  not exists (select 1 from control_libro_caja() where caja_hoy <> libro),
  (select string_agg(mes || ' ' || tipo || ' ' || caja_hoy || '/' || libro, ', ') from control_libro_caja() where caja_hoy <> libro);

-- Como el dueño: cargar a mano, pasar entre cuentas, socios, saldos
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_ef uuid := (select id from cuentas_caja where dueno_id = auth.uid() and nombre = 'Efectivo');
  v_cf uuid := (select id from cuentas_caja where dueno_id = auth.uid() and nombre = 'Caja fuerte');
  v_luz uuid := (select id from categorias_caja where dueno_id = auth.uid() and nombre = 'Luz');
  v_antes bigint := (select saldo from saldos_cuentas() where cuenta_id = v_ef);
  v_cf_antes bigint := (select saldo from saldos_cuentas() where cuenta_id = v_cf);
  g uuid; s uuid; x uuid;
begin
  g := registrar_movimiento('gasto', 250000, v_ef, 'Factura de luz', current_date, v_luz);
  insert into resultados (caso, ok) values ('Gasto a mano: baja el saldo de Efectivo', (select saldo from saldos_cuentas() where cuenta_id = v_ef) = v_antes - 250000);
  perform transferir_entre_cuentas(v_ef, v_cf, 100000, 'A la caja fuerte', current_date);
  insert into resultados (caso, ok) values ('Pase a la caja fuerte: baja Efectivo y sube Caja fuerte',
    (select saldo from saldos_cuentas() where cuenta_id = v_ef) = v_antes - 350000 and (select saldo from saldos_cuentas() where cuenta_id = v_cf) = v_cf_antes + 100000);
  s := guardar_socio(null, 'Socio Uno');
  perform registrar_movimiento('retiro_socio', 50000, v_cf, 'Retiro de Socio Uno', current_date, null, null, null, s);
  insert into resultados (caso, ok) values ('Retiro de socio con socio', exists (select 1 from movimientos where socio_id = s and tipo = 'retiro_socio'));
  begin
    perform registrar_movimiento('gasto', 1000, v_ef, '--', current_date, v_luz);
    insert into resultados (caso, ok) values ('No acepta concepto "--"', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No acepta concepto "--"', sqlerrm = 'falta_concepto', sqlerrm); end;
  begin
    perform registrar_movimiento('gasto', 1000, v_ef, 'Algo', current_date, (select id from categorias_caja where dueno_id = auth.uid() and clave = 'turnos'));
    insert into resultados (caso, ok) values ('No acepta categoría de ingreso en un gasto', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No acepta categoría de ingreso en un gasto', sqlerrm = 'categoria_invalida', sqlerrm); end;
  perform editar_movimiento(g, '{"monto": 260000, "concepto": "Luz de octubre"}');
  insert into resultados (caso, ok) values ('Editar a mano deja historial',
    (select concepto from movimientos where id = g) = 'Luz de octubre' and exists (select 1 from movimientos_historial where movimiento_id = g and accion = 'edicion'));
  perform anular_movimiento(g, 'Cargado dos veces');
  insert into resultados (caso, ok) values ('Anular con motivo: deja de contar en el saldo',
    (select saldo from saldos_cuentas() where cuenta_id = v_ef) = v_antes - 100000);
  begin
    perform anular_movimiento((select id from movimientos where ref_tipo = 'compra' and dueno_id = auth.uid() and anulado_at is null limit 1), 'Prueba');
    insert into resultados (caso, ok) values ('Un movimiento automático se anula en el origen', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un movimiento automático se anula en el origen', sqlerrm = 'anular_en_origen', sqlerrm); end;
  begin
    perform editar_movimiento((select id from movimientos where ref_tipo = 'compra' and dueno_id = auth.uid() and anulado_at is null limit 1), '{"monto": 1}');
    insert into resultados (caso, ok) values ('A un automático no se le cambia el monto', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('A un automático no se le cambia el monto', sqlerrm = 'editar_en_origen', sqlerrm); end;
  begin
    delete from movimientos where id = g;
    insert into resultados (caso, ok) values ('Nadie puede borrar un movimiento', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Nadie puede borrar un movimiento', true, sqlerrm); end;
  begin
    insert into movimientos (dueno_id, tipo, cuenta_id, sentido, monto, concepto, fecha, cargado_por) values (auth.uid(), 'ajuste', v_ef, 1, 100, 'Directo', current_date, auth.uid());
    insert into resultados (caso, ok) values ('No se escribe el libro directo (solo por funciones)', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se escribe el libro directo (solo por funciones)', true, sqlerrm); end;
  x := guardar_cuenta_caja(null, 'Banco Nación', 'banco', 1000000, current_date);
  perform elegir_cuenta_medio('transferencia', x);
  insert into resultados (caso, ok) values ('Cuenta nueva con saldo inicial y medio elegido',
    (select saldo from saldos_cuentas() where cuenta_id = x) = 1000000 and (select cuenta_id from cuenta_por_medio where dueno_id = auth.uid() and complejo_id = '' and medio = 'transferencia') = x);
end $$;

-- Otra cuenta (no organizador): no ve nada y no puede cargar
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'otro'), 'role', 'authenticated')::text, true);
do $$
begin
  insert into resultados (caso, ok) values ('Otra cuenta no ve movimientos ni cuentas',
    not exists (select 1 from movimientos) and not exists (select 1 from cuentas_caja));
  begin
    perform registrar_movimiento('gasto', 100, gen_random_uuid(), 'Algo', current_date);
    insert into resultados (caso, ok) values ('Otra cuenta no puede cargar', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Otra cuenta no puede cargar', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;
reset role;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_LIBRO' as fin from resultados;
rollback;
