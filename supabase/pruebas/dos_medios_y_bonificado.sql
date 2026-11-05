-- Pruebas de 20261054_dos_medios_y_bonificado.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-dosmedios', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-dosmedios', 'Cancha 1', '00:00', '23:30') returning id)
insert into ids select 'cancha', id::text from c;
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-dosmedios', 'Pedro') returning id)
insert into ids select 'cuenta', id::text from c;
insert into torneos (id, organizador_id, datos)
select 'tprueba-dosmedios', valor::uuid, jsonb_build_object('id', 'tprueba-dosmedios', 'name', 'Torneo dos medios', 'precioJugador', 15000,
  'categories', jsonb_build_array(jsonb_build_object('id', 'c1', 'name', '4ta', 'pairs', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Gomez / Ibañez')))))
from ids where clave = 'org';

-- Lo vigente en el libro para un origen: "medio monto" (en pesos) o 'nada'
create or replace function pg_temp.libro(p_tipo text, p_id uuid) returns text language sql as $$
  select coalesce(string_agg(medio || ' ' || (monto / 100), ','), 'nada') from movimientos where ref_tipo = p_tipo and ref_pago_id = p_id and anulado_at is null;
$$;
-- Diferencia origen − libro del control, para el dueño de prueba en el mes actual
create or replace function pg_temp.descuadre() returns bigint language sql as $$
  select coalesce(sum(caja_hoy - libro), 0) from control_libro_caja() where dueno_id = (select valor::uuid from ids where clave = 'org') and mes = to_char(_fecha_ar(now()), 'YYYY-MM');
$$;
insert into ids values ('descuadre', pg_temp.descuadre()::text);

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  d date := _fecha_ar(now());
  a uuid; b uuid; c uuid; e uuid; v uuid; p uuid; caja uuid; x jsonb; antes jsonb; despues jsonb;
  hora int := 8;
  turno_nuevo text := 'insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio) values ($1, $2, $3, ($3 + make_time($4, 0, 0)) at time zone ''America/Argentina/Buenos_Aires'', ($3 + make_time($4, 30, 0)) at time zone ''America/Argentina/Buenos_Aires'', $5, $6) returning id';
begin
  caja := abrir_caja_conteo('cprueba-dosmedios', '{}');

  -- Turno A: $35.000, $20.000 en efectivo y $15.000 por Mercado Pago
  execute turno_nuevo into a using 'cprueba-dosmedios', v_cancha, d, 8, 'Martin', 35000;
  update reservas set medio_pago = 'efectivo', medio_pago2 = 'mercado_pago', monto_pago2 = 15000 where id = a;
  insert into resultados (caso, ok, detalle) values ('Turno en dos medios: dos movimientos en el libro',
    pg_temp.libro('turno', a) = 'efectivo 20000' and pg_temp.libro('turno2', a) = 'mercado_pago 15000', pg_temp.libro('turno', a) || ' / ' || pg_temp.libro('turno2', a));

  update reservas set monto_pago2 = 10000 where id = a;
  insert into resultados (caso, ok, detalle) values ('Cambiar el reparto actualiza los dos movimientos',
    pg_temp.libro('turno', a) = 'efectivo 25000' and pg_temp.libro('turno2', a) = 'mercado_pago 10000', pg_temp.libro('turno', a) || ' / ' || pg_temp.libro('turno2', a));

  update reservas set medio_pago = 'transferencia', medio_pago2 = 'bonificado' where id = a;
  insert into resultados (caso, ok, detalle) values ('Parte bonificada: solo la parte cobrada va al libro',
    pg_temp.libro('turno', a) = 'transferencia 25000' and pg_temp.libro('turno2', a) = 'nada', pg_temp.libro('turno', a) || ' / ' || pg_temp.libro('turno2', a));

  update reservas set precio = 8000 where id = a;
  insert into resultados (caso, ok, detalle) values ('Si el precio baja de la segunda parte, se saca el segundo medio',
    (select medio_pago2 is null and monto_pago2 is null from reservas where id = a) and pg_temp.libro('turno', a) = 'transferencia 8000' and pg_temp.libro('turno2', a) = 'nada',
    pg_temp.libro('turno', a) || ' / ' || pg_temp.libro('turno2', a));

  update reservas set medio_pago2 = 'efectivo', monto_pago2 = 3000 where id = a;
  update reservas set medio_pago = null where id = a;
  insert into resultados (caso, ok, detalle) values ('Sacar el cobro saca los dos medios y los dos movimientos',
    (select medio_pago2 is null and monto_pago2 is null and cobrado_por is null from reservas where id = a) and pg_temp.libro('turno', a) = 'nada' and pg_temp.libro('turno2', a) = 'nada',
    pg_temp.libro('turno', a) || ' / ' || pg_temp.libro('turno2', a));

  begin
    update reservas set medio_pago = 'efectivo', medio_pago2 = 'efectivo', monto_pago2 = 1000 where id = a;
    insert into resultados (caso, ok) values ('Los dos medios no pueden ser el mismo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Los dos medios no pueden ser el mismo', sqlstate = '23514', sqlerrm); end;

  -- Turno B: todo bonificado
  execute turno_nuevo into b using 'cprueba-dosmedios', v_cancha, d, 9, 'Bonificado', 20000;
  update reservas set medio_pago = 'bonificado' where id = b;
  insert into resultados (caso, ok, detalle) values ('Turno bonificado: queda cobrado y no va al libro',
    (select cobrado_por = v_org from reservas where id = b) and pg_temp.libro('turno', b) = 'nada', pg_temp.libro('turno', b));

  -- Caja del día: un turno de $10.000 con $6.000 en efectivo y $4.000 bonificados
  antes := _resumen_turno(caja);
  execute turno_nuevo into e using 'cprueba-dosmedios', v_cancha, d, 10, 'Caja', 10000;
  update reservas set medio_pago = 'efectivo', medio_pago2 = 'bonificado', monto_pago2 = 4000 where id = e;
  despues := _resumen_turno(caja);
  insert into resultados (caso, ok, detalle) values ('Caja del día: suma el efectivo y lo bonificado va aparte',
    (despues->>'efectivo_cobrado')::numeric - (antes->>'efectivo_cobrado')::numeric = 6000
    and (despues->>'bonificado')::numeric - (antes->>'bonificado')::numeric = 4000
    and not (despues->'por_medio' ? 'bonificado'), despues::text);

  -- Inscripción y cuenta bonificadas
  insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
  values ('tprueba-dosmedios', v_org, 'c1', 'p1', 1, 15000, 'bonificado') returning id into p;
  insert into resultados (caso, ok, detalle) values ('Inscripción bonificada: pagada y sin libro', pg_temp.libro('inscripcion', p) = 'nada', pg_temp.libro('inscripcion', p));
  insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
  values ('tprueba-dosmedios', v_org, 'c1', 'p1', 2, 15000, 'transferencia') returning id into p;
  insert into resultados (caso, ok, detalle) values ('Inscripción cobrada: va al libro como siempre', pg_temp.libro('inscripcion', p) = 'transferencia 15000', pg_temp.libro('inscripcion', p));

  insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario) values ('cprueba-dosmedios', v_cuenta, 'Agua', 1, 2000);
  x := cobrar_todo(v_cuenta, 2000, 'bonificado');
  insert into resultados (caso, ok, detalle) values ('Cobrar todo bonificado deja la cuenta al día sin libro',
    (select sum(monto) from cuenta_pagos where cuenta_id = v_cuenta and medio = 'bonificado') = 2000
    and not exists (select 1 from movimientos m join cuenta_pagos q on q.id = m.ref_pago_id where q.cuenta_id = v_cuenta and m.ref_tipo = 'cuenta' and m.anulado_at is null), x::text);

  insert into resultados (caso, ok, detalle) values ('Las cuotas de clases aceptan bonificado',
    (select pg_get_constraintdef(oid) like '%bonificado%' from pg_constraint where conname = 'cuotas_alumnos_medio_check'), null);

  -- Mostrador: la cancha ($10.000) se reparte en dos medios
  execute turno_nuevo into c using 'cprueba-dosmedios', v_cancha, d, 11, 'Perez', 10000;
  insert into ventas (complejo_id, subtotal, total, vendido_por, reserva_id, pendiente) values ('cprueba-dosmedios', 3000, 3000, v_org, c, 3000) returning id into v;
  x := cobrar_turno_mostrador(c, '[{"medio": "efectivo", "monto": 5000}, {"medio": "mercado_pago", "monto": 8000}]');
  insert into resultados (caso, ok, detalle) values ('Mostrador: la cancha en dos medios y los consumos con lo que sobra',
    (select medio_pago = 'mercado_pago' and medio_pago2 = 'efectivo' and monto_pago2 = 2000 from reservas where id = c)
    and pg_temp.libro('turno', c) = 'mercado_pago 8000' and pg_temp.libro('turno2', c) = 'efectivo 2000'
    and (select string_agg(medio || ' ' || monto, ',') from venta_pagos where venta_id = v) = 'efectivo 3000.00', x::text);

  insert into resultados (caso, ok, detalle) values ('El control del libro sigue cuadrando',
    pg_temp.descuadre() = (select valor::bigint from ids where clave = 'descuadre'), pg_temp.descuadre()::text);
end $$;
reset role;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_DOS_MEDIOS' as fin from resultados;
rollback;
