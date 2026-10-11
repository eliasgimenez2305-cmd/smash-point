-- Pruebas de 20261019_caja.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador de la base): un colaborador con todos los permisos
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000f1', 'empleado-caja@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-caja', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_resultados, p_torneos, p_canchas)
values ('cprueba-caja', 'empleado-caja@prueba.test', true, true, true, true);

-- 1) El organizador
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_id uuid;
  n int;
begin
  insert into caja_movimientos (fecha, tipo, concepto, monto, medio) values (current_date, 'gasto', 'Pelotas', 45000, 'efectivo') returning id into v_id;
  insert into resultados (caso, ok, detalle) values ('El organizador carga un gasto (queda a su nombre)', (select organizador_id::text from caja_movimientos where id = v_id) = (select valor from ids where clave = 'org'), null);
  insert into ids values ('mov', v_id::text);
  insert into caja_movimientos (fecha, tipo, concepto, monto, medio) values (current_date, 'ingreso', 'Sponsor', 100000, 'transferencia');
  select count(*) into n from caja_movimientos;
  insert into resultados (caso, ok, detalle) values ('Ve sus movimientos', n = 2, n::text);
  update caja_movimientos set monto = 50000 where id = v_id;
  insert into resultados (caso, ok) values ('Corrige un movimiento', (select monto from caja_movimientos where id = v_id) = 50000);
  begin
    insert into caja_movimientos (fecha, tipo, concepto, monto, medio) values (current_date, 'gasto', ' ', 100, 'efectivo');
    insert into resultados (caso, ok) values ('Sin concepto: rechazado', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Sin concepto: rechazado', true); end;
  begin
    insert into caja_movimientos (organizador_id, fecha, tipo, concepto, monto, medio) values (gen_random_uuid(), current_date, 'gasto', 'X', 100, 'efectivo');
    insert into resultados (caso, ok) values ('No carga en la caja de otro', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No carga en la caja de otro', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) Un colaborador, aunque tenga todos los permisos, no ve ni toca la caja
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);

do $$
declare n int;
begin
  select count(*) into n from caja_movimientos;
  insert into resultados (caso, ok, detalle) values ('El colaborador no ve la caja', n = 0, n::text);
  begin
    insert into caja_movimientos (organizador_id, fecha, tipo, concepto, monto, medio) values ((select valor::uuid from ids where clave = 'org'), current_date, 'gasto', 'X', 100, 'efectivo');
    insert into resultados (caso, ok) values ('El colaborador no carga en la caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El colaborador no carga en la caja', sqlstate = '42501', sqlerrm); end;
  delete from caja_movimientos where id = (select valor::uuid from ids where clave = 'mov');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El colaborador no borra de la caja', n = 0, n::text);
end $$;

-- 3) El organizador borra un movimiento
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  delete from caja_movimientos where id = (select valor::uuid from ids where clave = 'mov');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El organizador borra un movimiento', n = 1, n::text);
end $$;

-- 4) El público
reset role;
do $$
begin
  set local role anon;
  perform count(*) from caja_movimientos;
  reset role;
  insert into resultados (caso, ok) values ('El público no ve la caja', false);
exception when insufficient_privilege then
  insert into resultados (caso, ok) values ('El público no ve la caja', true);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
