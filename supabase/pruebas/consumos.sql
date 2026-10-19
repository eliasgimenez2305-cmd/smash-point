-- Pruebas de 20261021_consumos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador de la base)
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000b1', 'buffet@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000b2', 'agenda2@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-buffet', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values
  ('cprueba-buffet', 'buffet@prueba.test', false, true),
  ('cprueba-buffet', 'agenda2@prueba.test', true, false);

-- 1) El dueño arma la lista de productos y una cuenta
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_agua uuid;
  v_cerveza uuid;
  v_cuenta uuid;
begin
  insert into productos (complejo_id, nombre, precio, stock, aviso_stock) values ('cprueba-buffet', 'Agua', 1500, 10, 3) returning id into v_agua;
  insert into productos (complejo_id, nombre, precio) values ('cprueba-buffet', 'Cerveza', 3000) returning id into v_cerveza;
  insert into cuentas (complejo_id, nombre, telefono) values ('cprueba-buffet', 'Juan Prueba', '5493446111111') returning id into v_cuenta;
  insert into ids values ('agua', v_agua::text), ('cerveza', v_cerveza::text), ('cuenta', v_cuenta::text);
  insert into resultados (caso, ok) values ('El dueño carga productos y una cuenta', v_agua is not null and v_cuenta is not null);
  begin
    insert into cuentas (complejo_id, nombre, telefono) values ('cprueba-buffet', 'Otro Juan', '5493446111111');
    insert into resultados (caso, ok) values ('Mismo WhatsApp dos veces: rechazado', false);
  exception when unique_violation then insert into resultados (caso, ok) values ('Mismo WhatsApp dos veces: rechazado', true); end;
end $$;

-- 2) El empleado del buffet anota y cobra
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);

do $$
declare
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  v_agua uuid := (select valor::uuid from ids where clave = 'agua');
  r cuenta_consumos%rowtype;
  s record;
  n int;
begin
  insert into cuenta_consumos (complejo_id, cuenta_id, producto_id, descripcion, cantidad, precio_unitario)
  values ('cprueba-buffet', v_cuenta, v_agua, 'Agua gratis', 2, 1) returning * into r;
  insert into resultados (caso, ok, detalle) values ('Anota 2 aguas con el precio de la lista (no el que manda)', r.precio_unitario = 1500 and r.descripcion = 'Agua' and r.cargado_por_email = 'buffet@prueba.test', r.precio_unitario::text);
  insert into ids values ('consumo_agua', r.id::text);
  insert into resultados (caso, ok, detalle) values ('El stock bajó a 8', (select stock from productos where id = v_agua) = 8, (select stock from productos where id = v_agua)::text);
  insert into cuenta_consumos (complejo_id, cuenta_id, producto_id, cantidad, descripcion, precio_unitario)
  values ('cprueba-buffet', v_cuenta, (select valor::uuid from ids where clave = 'cerveza'), 1, 'x', 0);
  insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario) values ('cprueba-buffet', v_cuenta, 'Protector', 1, 2500);
  insert into cuenta_pagos (complejo_id, cuenta_id, monto, medio) values ('cprueba-buffet', v_cuenta, 5000, 'efectivo');
  select * into s from cuentas_con_saldo('cprueba-buffet') x where x.id = v_cuenta;
  insert into resultados (caso, ok, detalle) values ('Saldo: consumió 8.500, pagó 5.000', s.consumido = 8500 and s.pagado = 5000, s.consumido || ' / ' || s.pagado);
  perform sumar_stock(v_agua, 12);
  insert into resultados (caso, ok, detalle) values ('Repone stock (8 + 12 = 20)', (select stock from productos where id = v_agua) = 20, (select stock from productos where id = v_agua)::text);
  update productos set precio = 1 where id = v_agua;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El empleado no cambia precios', n = 0, n::text);
  delete from cuenta_consumos where id = (select valor::uuid from ids where clave = 'consumo_agua');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El empleado no anula consumos', n = 0, n::text);
  delete from cuentas where id = v_cuenta;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El empleado no borra cuentas', n = 0, n::text);
end $$;

-- 3) Un empleado sin el permiso de consumos
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from cuentas;
  insert into resultados (caso, ok, detalle) values ('Sin el permiso: no ve las cuentas', n = 0, n::text);
  begin
    insert into cuenta_pagos (complejo_id, cuenta_id, monto, medio) values ('cprueba-buffet', (select valor::uuid from ids where clave = 'cuenta'), 100, 'efectivo');
    insert into resultados (caso, ok) values ('Sin el permiso: no cobra', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin el permiso: no cobra', sqlstate = '42501', sqlerrm); end;
  begin
    perform cuentas_con_saldo('cprueba-buffet');
    insert into resultados (caso, ok) values ('Sin el permiso: no ve saldos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin el permiso: no ve saldos', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 4) El dueño anula un consumo: el stock vuelve
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  delete from cuenta_consumos where id = (select valor::uuid from ids where clave = 'consumo_agua');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El dueño anula las 2 aguas y vuelven al stock (22)', n = 1 and (select stock from productos where id = (select valor::uuid from ids where clave = 'agua')) = 22, (select stock from productos where id = (select valor::uuid from ids where clave = 'agua'))::text);
end $$;

-- 5) El público
reset role;
do $$
begin
  set local role anon;
  perform count(*) from cuentas;
  reset role;
  insert into resultados (caso, ok) values ('El público no ve las cuentas', false);
exception when insufficient_privilege then
  insert into resultados (caso, ok) values ('El público no ve las cuentas', true);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
