-- Pruebas de 20261032_auditoria.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación: complejo con una cancha online (90' a 15.000), agua con stock, una cuenta que debe,
-- un empleado con agenda y cantina, y un jugador
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000d1', 'emp-audit@prueba.test', now());
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000d2', 'jug-audit@prueba.test', now());
insert into jugadores (id, nombre, apellido, telefono) values ('00000000-0000-4000-8000-0000000000d2', 'Ana', 'Audit', '5493446999999');
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-audit', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-audit', 'emp-audit@prueba.test', true, true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre, precio_90, reserva_online) values ('cprueba-audit', 'Cancha 1', '08:00', '23:00', 15000, true) returning id)
insert into ids select 'cancha', id::text from c;
with p as (insert into productos (complejo_id, nombre, precio, stock) values ('cprueba-audit', 'Agua', 1500, 10) returning id)
insert into ids select 'agua', id::text from p;
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-audit', 'Pedro') returning id)
insert into ids select 'cuenta', id::text from c;
insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
select 'cprueba-audit', valor::uuid, 'Agua', 2, 1500 from ids where clave = 'cuenta';
with c as (insert into compras (complejo_id, fecha, total) values ('cprueba-audit', '2030-01-10', 5000) returning id)
insert into ids select 'compra', id::text from c;

-- El empleado cobra un turno en efectivo
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
with r as (
  insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre, precio, medio_pago)
  select 'cprueba-audit', valor::uuid, 'turno', '2030-01-10', '2030-01-10 20:00-03', '2030-01-10 21:30-03', 'confirmada', 'Juan', 20000, 'efectivo'
  from ids where clave = 'cancha'
  returning id)
insert into ids select 'turno', id::text from r;

-- 1) Turno cobrado: el empleado no lo puede des-cobrar, cambiar de precio ni cancelar
do $$
declare
  v uuid := (select valor::uuid from ids where clave = 'turno');
begin
  begin
    update reservas set medio_pago = null where id = v;
    insert into resultados (caso, ok) values ('Empleado: no le saca el cobro a un turno cobrado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado: no le saca el cobro a un turno cobrado', sqlerrm = 'turno_cobrado', sqlerrm); end;
  begin
    update reservas set precio = 1000 where id = v;
    insert into resultados (caso, ok) values ('Empleado: no le baja el precio', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado: no le baja el precio', sqlerrm = 'turno_cobrado', sqlerrm); end;
  begin
    update reservas set estado = 'cancelada' where id = v;
    insert into resultados (caso, ok) values ('Empleado: no lo cancela', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado: no lo cancela', sqlerrm = 'turno_cobrado', sqlerrm); end;
  begin
    update reservas set tipo = 'bloqueo' where id = v;
    insert into resultados (caso, ok) values ('Empleado: no lo pasa a bloqueo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado: no lo pasa a bloqueo', sqlerrm = 'turno_cobrado', sqlerrm); end;
  update reservas set nota = 'Paletas prestadas' where id = v;
  insert into resultados (caso, ok) values ('Empleado: sí le agrega una nota', (select nota from reservas where id = v) = 'Paletas prestadas');
end $$;

-- 2) El dueño corrige el medio: el cobro sigue siendo del empleado; después sí lo puede des-cobrar
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v uuid := (select valor::uuid from ids where clave = 'turno');
begin
  update reservas set medio_pago = 'transferencia' where id = v;
  insert into resultados (caso, ok) values ('Corregir el medio no cambia quién cobró',
    (select cobrado_por from reservas where id = v) = '00000000-0000-4000-8000-0000000000d1');
  update reservas set medio_pago = null where id = v;
  insert into resultados (caso, ok) values ('El dueño sí le saca el cobro', (select medio_pago is null and cobrado_por is null from reservas where id = v));
end $$;

-- 3) cobrar_todo con débito; reponer stock; pagar una compra
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
do $$
declare
  j jsonb;
  v_agua uuid := (select valor::uuid from ids where clave = 'agua');
begin
  j := cobrar_todo((select valor::uuid from ids where clave = 'cuenta'), 3000, 'debito');
  insert into resultados (caso, ok, detalle) values ('Cobrar todo con débito', (j->>'consumos')::numeric = 3000, j::text);
  insert into resultados (caso, ok, detalle) values ('Empleado repone 5 aguas', sumar_stock(v_agua, 5) = 15, null);
  begin
    perform sumar_stock(v_agua, -5);
    insert into resultados (caso, ok) values ('Empleado: no resta stock', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado: no resta stock', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_compra uuid := (select valor::uuid from ids where clave = 'compra');
begin
  insert into resultados (caso, ok) values ('El dueño sí resta stock', sumar_stock((select valor::uuid from ids where clave = 'agua'), -5) = 10);
  begin
    perform pagar_compra(v_compra, null);
    insert into resultados (caso, ok) values ('Pagar una compra sin medio: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Pagar una compra sin medio: rechazado', sqlerrm = 'datos_invalidos', sqlerrm); end;
  perform pagar_compra(v_compra, 'debito');
  insert into resultados (caso, ok) values ('Pagar una compra con débito, con fecha de Argentina',
    (select medio = 'debito' and pagada_at = (now() at time zone 'America/Argentina/Buenos_Aires')::date from compras where id = v_compra));
end $$;

-- 4) El jugador pide 2 turnos; el tercero no
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}', true);
do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_dia date := (now() at time zone 'America/Argentina/Buenos_Aires')::date + 3;
begin
  perform pedir_turno(v_cancha, v_dia, 600, 90);
  perform pedir_turno(v_cancha, v_dia, 720, 90);
  insert into resultados (caso, ok) values ('El jugador pide 2 turnos', true);
  begin
    perform pedir_turno(v_cancha, v_dia, 900, 90);
    insert into resultados (caso, ok) values ('El tercer pedido pendiente: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El tercer pedido pendiente: rechazado', sqlerrm = 'demasiados_pedidos', sqlerrm); end;
end $$;

-- 5) Con el módulo Reservas apagado no se piden turnos
reset role;
update reservas set estado = 'cancelada' where complejo_id = 'cprueba-audit' and estado = 'pendiente';
update complejos set modulo_reservas = false where id = 'cprueba-audit';
set local role authenticated;
do $$
begin
  perform pedir_turno((select valor::uuid from ids where clave = 'cancha'), (now() at time zone 'America/Argentina/Buenos_Aires')::date + 3, 600, 90);
  insert into resultados (caso, ok) values ('Sin módulo Reservas: no se piden turnos', false);
exception when others then insert into resultados (caso, ok, detalle) values ('Sin módulo Reservas: no se piden turnos', sqlerrm = 'cancha_invalida', sqlerrm);
end $$;

reset role;
select n, ok, caso, detalle from resultados order by n;
rollback;
