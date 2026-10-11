-- Pruebas de 20261020_caja_plataforma.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración. Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

insert into ids values
  ('creador', (select id::text from organizers where username = 'creador-prueba')),
  ('org', (select id::text from organizers where username = 'organizador-prueba'));

-- 1) El creador
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_cli uuid;
  n int;
begin
  insert into plataforma_clientes (tipo, ref_id, nombre, telefono, cuota_mensual, desde)
  values ('organizador', (select valor from ids where clave = 'org'), 'PRUEBA PADEL', '5493446111111', 20000, '2026-10') returning id into v_cli;
  insert into resultados (caso, ok) values ('El creador carga un cliente con cuota', v_cli is not null);
  insert into ids values ('cli', v_cli::text);
  insert into plataforma_movimientos (tipo, cliente_id, periodo, concepto, monto, medio, fecha)
  values ('ingreso', v_cli, '2026-10', 'Cuota octubre', 20000, 'transferencia', current_date);
  insert into plataforma_movimientos (tipo, concepto, monto, medio, fecha) values ('gasto', 'Dominio', 8000, 'mercado_pago', current_date);
  select count(*) into n from plataforma_movimientos;
  insert into resultados (caso, ok, detalle) values ('Registra una cuota y un gasto', n = 2, n::text);
  begin
    insert into plataforma_movimientos (tipo, cliente_id, concepto, monto, medio, fecha) values ('gasto', v_cli, 'X', 100, 'efectivo', current_date);
    insert into resultados (caso, ok) values ('Un gasto no lleva cliente', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Un gasto no lleva cliente', true); end;
  begin
    insert into plataforma_movimientos (tipo, cliente_id, periodo, concepto, monto, medio, fecha) values ('ingreso', v_cli, '2026-13', 'X', 100, 'efectivo', current_date);
    insert into resultados (caso, ok) values ('Mes inválido: rechazado', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Mes inválido: rechazado', true); end;
end $$;

-- 2) Un organizador no ve ni toca la caja de la plataforma
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  select count(*) into n from plataforma_clientes;
  insert into resultados (caso, ok, detalle) values ('Un organizador no ve los clientes', n = 0, n::text);
  select count(*) into n from plataforma_movimientos;
  insert into resultados (caso, ok, detalle) values ('Un organizador no ve los movimientos', n = 0, n::text);
  begin
    insert into plataforma_movimientos (tipo, concepto, monto, medio, fecha) values ('gasto', 'X', 100, 'efectivo', current_date);
    insert into resultados (caso, ok) values ('Un organizador no carga movimientos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un organizador no carga movimientos', sqlstate = '42501', sqlerrm); end;
  update plataforma_clientes set cuota_mensual = 1;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Un organizador no cambia cuotas', n = 0, n::text);
end $$;

-- 3) Borrar un cliente deja sus cobros (sin cliente)
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  delete from plataforma_clientes where id = (select valor::uuid from ids where clave = 'cli');
  select count(*) into n from plataforma_movimientos where tipo = 'ingreso' and cliente_id is null;
  insert into resultados (caso, ok, detalle) values ('Borrar un cliente no borra lo cobrado', n = 1, n::text);
end $$;

-- 4) El público
reset role;
do $$
begin
  set local role anon;
  perform count(*) from plataforma_movimientos;
  reset role;
  insert into resultados (caso, ok) values ('El público no ve la caja de la plataforma', false);
exception when insufficient_privilege then
  insert into resultados (caso, ok) values ('El público no ve la caja de la plataforma', true);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
