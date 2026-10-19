-- Pruebas de 20261022_cobrar_todo.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador): complejo, torneo con precio 15.000 por jugador, una cuenta con
-- 2 aguas y 1 gaseosa (5.500) y un empleado del buffet
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000a9', 'buffet2@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-todo', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-todo', 'buffet2@prueba.test', false, true);
insert into torneos (id, organizador_id, datos, rev)
select 'ttodo', valor::uuid, jsonb_build_object('id', 'ttodo', 'name', 'TORNEO TODO', 'organizerId', valor, 'precioJugador', 15000,
  'categories', jsonb_build_array(jsonb_build_object('id', 'c1', 'name', '6ta', 'format', 'zonas',
    'pairs', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Juan Pérez / Pedro Gómez'))))), 1
from ids where clave = 'org';
-- Un torneo de otro organizador (sin dueño): no se puede vincular
insert into torneos (id, organizador_id, datos, rev) values ('tajeno2', null, '{"id":"tajeno2","name":"AJENO","categories":[]}', 1);
-- Los consumos guardan quién los anotó (de la sesión): se cargan como el organizador
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-todo', 'Juan Pérez') returning id)
insert into ids select 'cuenta', id::text from c;
insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
select 'cprueba-todo', valor::uuid, 'Agua', 2, 1500 from ids where clave = 'cuenta';
insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
select 'cprueba-todo', valor::uuid, 'Gaseosa', 1, 2500 from ids where clave = 'cuenta';

-- 1) El empleado del buffet vincula a Juan (jugador 1 de la pareja) con su cuenta
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a9","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  r record;
  s record;
  j jsonb;
begin
  insert into cuenta_jugadores (torneo_id, categoria_id, pareja_id, jugador, cuenta_id, complejo_id) values ('ttodo', 'c1', 'p1', 1, v_cuenta, 'cprueba-todo');
  insert into resultados (caso, ok) values ('Vincula a Juan con su cuenta', true);
  begin
    insert into cuenta_jugadores (torneo_id, categoria_id, pareja_id, jugador, cuenta_id, complejo_id) values ('tajeno2', 'c1', 'p1', 1, v_cuenta, 'cprueba-todo');
    insert into resultados (caso, ok) values ('No vincula con un torneo de otro organizador', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No vincula con un torneo de otro organizador', sqlstate = '42501', sqlerrm); end;

  select * into r from inscripciones_de_cuenta(v_cuenta);
  insert into resultados (caso, ok, detalle) values ('Ve la inscripción de Juan: debe 15.000', r.nombre = 'Juan Pérez' and r.debe = 15000 and r.torneo = 'TORNEO TODO', r.nombre || ' ' || r.debe);
  select * into s from cuentas_con_saldo('cprueba-todo') x where x.id = v_cuenta;
  insert into resultados (caso, ok, detalle) values ('La cuenta muestra consumos 5.500 + inscripción 15.000', s.consumido = 5500 and s.debe_inscripciones = 15000, s.consumido || ' + ' || s.debe_inscripciones);

  -- Paga 10.000: todo va a la inscripción (primero la inscripción)
  j := cobrar_todo(v_cuenta, 10000, 'efectivo');
  insert into resultados (caso, ok, detalle) values ('Paga 10.000: va todo a la inscripción', (j->>'inscripciones')::numeric = 10000 and (j->>'consumos')::numeric = 0, j::text);
  -- Paga 10.500: 5.000 completan la inscripción y 5.500 van a los consumos
  j := cobrar_todo(v_cuenta, 10500, 'transferencia');
  insert into resultados (caso, ok, detalle) values ('Paga 10.500: 5.000 a la inscripción y 5.500 a consumos', (j->>'inscripciones')::numeric = 5000 and (j->>'consumos')::numeric = 5500, j::text);
  select * into s from cuentas_con_saldo('cprueba-todo') x where x.id = v_cuenta;
  insert into resultados (caso, ok, detalle) values ('Queda todo saldado', s.consumido - s.pagado = 0 and s.debe_inscripciones = 0, (s.consumido - s.pagado) || ' / ' || s.debe_inscripciones);
  insert into resultados (caso, ok, detalle) values ('El pago de inscripción quedó a nombre de quien cobró', (select bool_and(cobrado_por_email = 'buffet2@prueba.test') from pagos_inscripcion where torneo_id = 'ttodo'), null);
  begin
    j := cobrar_todo(v_cuenta, 0, 'efectivo');
    insert into resultados (caso, ok) values ('Monto 0: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Monto 0: rechazado', sqlerrm = 'datos_invalidos', sqlerrm); end;
end $$;

-- 2) Alguien sin permiso de consumos no ve ni cobra
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
do $$
begin
  perform cobrar_todo((select valor::uuid from ids where clave = 'cuenta'), 100, 'efectivo');
  insert into resultados (caso, ok) values ('Sin permiso: no cobra', false);
exception when others then
  insert into resultados (caso, ok, detalle) values ('Sin permiso: no cobra', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
