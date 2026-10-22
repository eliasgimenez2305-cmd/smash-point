-- Pruebas de 20261046_caja_arqueo.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Complejo nuevo del organizador de prueba, una cancha y un empleado con agenda (por teléfono)
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('emp', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', '5493446999701', now(), now(), now() from ids where clave = 'emp';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-arqueo', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-arqueo', 'Cancha 1', '00:00', '23:30') returning id)
insert into ids select 'cancha', id::text from c;
insert into colaboradores (complejo_id, telefono, p_agenda) values ('cprueba-arqueo', '5493446999701', true);

create temp view mov as
  select m.*, c.nombre as cuenta, d.nombre as destino from movimientos m join cuentas_caja c on c.id = m.cuenta_id left join cuentas_caja d on d.id = m.cuenta_destino_id;
grant select on mov to authenticated;

-- El dueño abre, cobra, cierra con faltante y reabre
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  d date := current_date;
  t uuid; r uuid; v uuid; x jsonb; v_ef uuid;
begin
  begin
    perform abrir_caja_conteo('cprueba-arqueo', '{"50": 1}');
    insert into resultados (caso, ok) values ('No acepta billetes de menos de $100', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No acepta billetes de menos de $100', sqlerrm = 'datos_invalidos', sqlerrm); end;

  t := abrir_caja_conteo('cprueba-arqueo', '{"10000": 2, "1000": 3}');
  insert into ids values ('caja', t::text);
  insert into resultados (caso, ok, detalle) values ('Abrir con conteo: fondo $23.000 pasa de Caja fuerte a Efectivo',
    (select fondo from caja_turnos where id = t) = 23000
    and exists (select 1 from mov where caja_turno_id = t and ref_tipo = 'caja_apertura' and cuenta = 'Caja fuerte' and destino = 'Efectivo' and monto = 2300000),
    (select string_agg(cuenta || '>' || coalesce(destino, '') || ' ' || monto, ', ') from mov where caja_turno_id = t));

  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
  values ('cprueba-arqueo', v_cancha, d, d + time '10:00', d + time '11:00', 'Perez', 10000, 'efectivo') returning id into r;
  insert into resultados (caso, ok) values ('Cobro en efectivo con la caja abierta: queda en esa caja',
    exists (select 1 from movimientos where ref_pago_id = r and caja_turno_id = t));

  insert into ventas (complejo_id, subtotal, total, vendido_por) values ('cprueba-arqueo', 5000, 5000, v_org) returning id into v;
  insert into venta_pagos (venta_id, complejo_id, medio, monto, cobrado_por) values (v, 'cprueba-arqueo', 'mercado_pago', 5000, v_org);
  insert into resultados (caso, ok) values ('El cobro con Mercado Pago aparece para tildar al cerrar',
    (select count(*) from cobros_para_confirmar(t)) = 1);

  -- Esperado: 23.000 + 10.000 = 33.000; cuenta 32.000 (falta $1.000) y no tilda el de MP
  x := cerrar_caja_conteo(t, '{"10000": 3, "1000": 2}', 'Faltó cambio');
  v_ef := (select id from cuentas_caja where dueno_id = v_org and nombre = 'Efectivo');
  insert into resultados (caso, ok, detalle) values ('Cerrar: falta $1.000, queda el ajuste y un cobro sin tildar',
    (x->>'diferencia')::numeric = -1000 and (x->>'sin_confirmar')::int = 1
    and exists (select 1 from mov where caja_turno_id = t and tipo = 'ajuste' and sentido = -1 and monto = 100000 and concepto like 'Faltó%'), x::text);
  insert into resultados (caso, ok, detalle) values ('Cerrar: todo lo contado pasa a Caja fuerte y la caja queda en $0',
    exists (select 1 from mov where caja_turno_id = t and ref_tipo = 'caja_cierre' and tipo = 'transferencia_interna' and destino = 'Caja fuerte' and monto = 3200000)
    and (select sum(sentido * monto) filter (where cuenta_id = v_ef) + coalesce(sum(monto) filter (where cuenta_destino_id = v_ef), 0) from movimientos where caja_turno_id = t and anulado_at is null) = 0,
    (select (sum(sentido * monto) filter (where cuenta_id = v_ef) + coalesce(sum(monto) filter (where cuenta_destino_id = v_ef), 0))::text from movimientos where caja_turno_id = t and anulado_at is null));

  perform reabrir_caja(t, 'Contó mal');
  insert into resultados (caso, ok) values ('Reabrir: se anulan los movimientos del cierre y la caja vuelve a estar abierta',
    (select cerrada_at is null and reabierta_motivo = 'Contó mal' from caja_turnos where id = t)
    and not exists (select 1 from movimientos where ref_tipo = 'caja_cierre' and ref_id = t::text and anulado_at is null));
  x := cerrar_caja_conteo(t, '{"10000": 3, "1000": 3}', null, (select array_agg(id) from cobros_para_confirmar(t)));
  insert into resultados (caso, ok, detalle) values ('Cerrar de nuevo, justo y con todo tildado',
    (x->>'diferencia')::numeric = 0 and (x->>'sin_confirmar')::int = 0 and not exists (select 1 from movimientos where caja_turno_id = t and tipo = 'ajuste' and anulado_at is null), x::text);

  -- El dueño cobra en efectivo sin caja abierta: se puede
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
  values ('cprueba-arqueo', v_cancha, d, d + time '12:00', d + time '13:00', 'Gomez', 8000, 'efectivo');
  insert into resultados (caso, ok) values ('El dueño puede cobrar en efectivo sin caja abierta', true);
end $$;

-- El empleado
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'emp'), 'role', 'authenticated')::text, true);
do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  d date := current_date;
  t uuid;
begin
  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
    values ('cprueba-arqueo', v_cancha, d, d + time '14:00', d + time '15:00', 'Lopez', 8000, 'efectivo');
    insert into resultados (caso, ok) values ('Empleado sin caja abierta no cobra en efectivo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado sin caja abierta no cobra en efectivo', sqlerrm = 'abrir_caja_primero', sqlerrm); end;
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
  values ('cprueba-arqueo', v_cancha, d, d + time '16:00', d + time '17:00', 'Diaz', 8000, 'transferencia');
  insert into resultados (caso, ok) values ('Empleado sin caja sí cobra con transferencia', true);

  t := abrir_caja_conteo('cprueba-arqueo', '{}');
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, medio_pago)
  values ('cprueba-arqueo', v_cancha, d, d + time '18:00', d + time '19:00', 'Ruiz', 8000, 'efectivo');
  insert into resultados (caso, ok) values ('Empleado con la caja abierta cobra en efectivo', true);
  begin
    perform cerrar_caja_conteo(t, '{"1000": 8}', null, '{}', 'socio');
    insert into resultados (caso, ok) values ('El empleado no puede cerrar como retiro de socio', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no puede cerrar como retiro de socio', sqlerrm = 'no_autorizado', sqlerrm); end;
  perform cerrar_caja_conteo(t, '{"1000": 8}');
  insert into resultados (caso, ok) values ('El empleado cierra y la plata va a la cuenta de guardado',
    exists (select 1 from movimientos m join cuentas_caja c on c.id = m.cuenta_destino_id where m.caja_turno_id = t and m.ref_tipo = 'caja_cierre' and c.nombre = 'Caja fuerte'));
  begin
    perform reabrir_caja(t, 'Quiero');
    insert into resultados (caso, ok) values ('El empleado no puede reabrir', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no puede reabrir', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- El control del libro sigue dando igual (aperturas, cierres y ajustes no son ingreso ni gasto)
insert into resultados (caso, ok, detalle) select 'Control: libro = Caja de hoy',
  not exists (select 1 from control_libro_caja() where caja_hoy <> libro),
  (select string_agg(mes || ' ' || tipo || ' ' || caja_hoy || '/' || libro, ', ') from control_libro_caja() where caja_hoy <> libro);

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_ARQUEO' as fin from resultados;
rollback;
