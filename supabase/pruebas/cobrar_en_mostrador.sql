-- Pruebas de 20261049_cobrar_en_mostrador.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('emp', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', '5493446999951', now(), now(), now() from ids where clave = 'emp';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-mostrador', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-mostrador', 'Cancha 1', '00:00', '23:30') returning id)
insert into ids select 'cancha', id::text from c;
insert into colaboradores (complejo_id, telefono, p_agenda) values ('cprueba-mostrador', '5493446999951', true);
insert into torneos (id, organizador_id, datos)
select 'tprueba-mostrador', valor::uuid, jsonb_build_object('id', 'tprueba-mostrador', 'name', 'Torneo mostrador', 'categories', '[]'::jsonb) from ids where clave = 'org';

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  d date := _fecha_ar(now());
  r uuid; v uuid; c uuid; x jsonb;
begin
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio)
  values ('cprueba-mostrador', v_cancha, d, (d + time '23:00') at time zone 'America/Argentina/Buenos_Aires', (d + time '23:30') at time zone 'America/Argentina/Buenos_Aires', 'Perez', 10000) returning id into r;
  insert into ventas (complejo_id, subtotal, total, vendido_por, reserva_id, pendiente) values ('cprueba-mostrador', 3000, 3000, v_org, r, 3000) returning id into v;
  insert into ids values ('turno', r::text), ('venta', v::text);

  begin
    perform cobrar_turno_mostrador(r, '[{"medio": "efectivo", "monto": 13000}, {"medio": "mercado_pago", "monto": 1}]');
    insert into resultados (caso, ok) values ('Si los pagos no suman el total, no cobra', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Si los pagos no suman el total, no cobra', sqlerrm = 'monto_no_coincide', sqlerrm); end;
  begin
    perform cobrar_turno_mostrador(r, '[{"medio": "efectivo", "monto": 5000}, {"medio": "mercado_pago", "monto": 8000}]');
    insert into resultados (caso, ok) values ('La cancha no se puede partir entre dos medios', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('La cancha no se puede partir entre dos medios', sqlerrm = 'dividir_cancha', sqlerrm); end;

  x := cobrar_turno_mostrador(r, '[{"medio": "mercado_pago", "monto": 10000}, {"medio": "efectivo", "monto": 3000}]');
  insert into resultados (caso, ok, detalle) values ('Turno + consumos: cancha con MP y consumos en efectivo',
    (select medio_pago from reservas where id = r) = 'mercado_pago'
    and (select pendiente from ventas where id = v) = 0
    and (select string_agg(medio || ' ' || monto, ',') from venta_pagos where venta_id = v) = 'efectivo 3000.00', x::text);
  insert into resultados (caso, ok) values ('En la Caja: la cancha en Mercado Pago y los consumos en Efectivo',
    exists (select 1 from movimientos m join cuentas_caja k on k.id = m.cuenta_id where m.ref_pago_id = r and m.anulado_at is null and k.nombre = 'Mercado Pago' and m.monto = 1000000)
    and exists (select 1 from movimientos m join cuentas_caja k on k.id = m.cuenta_id where m.ref_tipo = 'venta' and m.ref_id = v::text and m.anulado_at is null and k.nombre = 'Efectivo' and m.monto = 300000));
  begin
    perform cobrar_turno_mostrador(r, '[{"medio": "efectivo", "monto": 1}]');
    insert into resultados (caso, ok) values ('Un turno ya cobrado no se vuelve a cobrar', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un turno ya cobrado no se vuelve a cobrar', sqlerrm = 'nada_para_cobrar', sqlerrm); end;

  insert into cuentas (complejo_id, nombre) values ('cprueba-mostrador', 'Gomez') returning id into c;
  insert into ids values ('cuenta', c::text);
end $$;

-- Jugador: inscripción $15.000 + cuenta $2.000, pagando $10.000 en efectivo y $7.000 por transferencia
set local role authenticated;
do $$
declare x jsonb; c uuid := (select valor::uuid from ids where clave = 'cuenta');
begin
  x := cobrar_jugador_mostrador('tprueba-mostrador', 'c1', 'p1', 2, 15000, c, 2000,
    '[{"medio": "efectivo", "monto": 10000}, {"medio": "transferencia", "monto": 7000}]');
  insert into resultados (caso, ok, detalle) values ('Inscripción + cuenta con pago dividido: cada parte con sus medios',
    (select string_agg(medio || ' ' || monto, ',' order by monto desc) from pagos_inscripcion where torneo_id = 'tprueba-mostrador') = 'efectivo 10000.00,transferencia 5000.00'
    and (select string_agg(medio || ' ' || monto, ',') from cuenta_pagos where cuenta_id = c) = 'transferencia 2000.00', x::text);
end $$;

-- Un empleado sin permiso de torneos no cobra inscripciones
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'emp'), 'role', 'authenticated')::text, true);
do $$
begin
  perform cobrar_jugador_mostrador('tprueba-mostrador', 'c1', 'p1', 1, 15000, null, null, '[{"medio": "transferencia", "monto": 15000}]');
  insert into resultados (caso, ok) values ('Empleado sin permiso de torneos no cobra inscripciones', false);
exception when others then insert into resultados (caso, ok, detalle) values ('Empleado sin permiso de torneos no cobra inscripciones', sqlstate = '42501', sqlerrm);
end $$;
reset role;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_MOSTRADOR' as fin from resultados;
rollback;
