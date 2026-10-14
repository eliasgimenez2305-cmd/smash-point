-- Pruebas de 20261029_cargar_a_turno.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila con la cantidad de casos, si todos dan bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación: complejo con una cancha, agua a 1.500, un empleado de la cantina (sin agenda), uno de
-- la agenda (sin cantina) y otro sin permisos; un turno de hoy (ya cobrado) y uno cancelado
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000d1', 'cantina@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000d2', 'agenda@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000d3', 'nada@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-cargar', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values
  ('cprueba-cargar', 'cantina@prueba.test', false, true),
  ('cprueba-cargar', 'agenda@prueba.test', true, false),
  ('cprueba-cargar', 'nada@prueba.test', false, false);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-cargar', 'Cancha 1', '08:00', '23:00') returning id)
insert into ids select 'cancha', id::text from c;
with p as (insert into productos (complejo_id, nombre, precio, stock) values ('cprueba-cargar', 'Agua', 1500, 50) returning id)
insert into ids select 'agua', id::text from p;
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-cargar', 'Juan Pérez') returning id)
insert into ids select 'cuenta', id::text from c;
with h as (select (now() at time zone 'America/Argentina/Buenos_Aires')::date as d),
     r as (
  insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre, precio, medio_pago)
  select 'cprueba-cargar', (select valor::uuid from ids where clave = 'cancha'), 'turno', h.d,
         (h.d + time '20:00') at time zone 'America/Argentina/Buenos_Aires', (h.d + time '21:30') at time zone 'America/Argentina/Buenos_Aires',
         'confirmada', 'Juan Pérez', 20000, 'efectivo' from h returning id)
insert into ids select 'turno', id::text from r;
with h as (select (now() at time zone 'America/Argentina/Buenos_Aires')::date as d),
     r as (
  insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre, precio)
  select 'cprueba-cargar', (select valor::uuid from ids where clave = 'cancha'), 'turno', h.d,
         (h.d + time '18:00') at time zone 'America/Argentina/Buenos_Aires', (h.d + time '19:00') at time zone 'America/Argentina/Buenos_Aires',
         'cancelada', 'Otro', 15000 from h returning id)
insert into ids select 'cancelado', id::text from r;

-- 1) La cantina carga 2 aguas al turno (sin pagar) y lo ve en la lista de turnos de hoy
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_turno uuid := (select valor::uuid from ids where clave = 'turno');
  v_agua text := (select valor from ids where clave = 'agua');
  j jsonb;
  t record;
begin
  j := vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 2)), '[]'::jsonb, 0, null, v_turno);
  insert into ids values ('venta1', j->>'venta_id');
  insert into resultados (caso, ok, detalle) values ('Carga al turno: 3.000 pendientes, nada a cuenta', (j->>'pendiente')::numeric = 3000 and (j->>'a_cuenta')::numeric = 0, j::text);
  insert into resultados (caso, ok) values ('Descuenta el stock', (select stock from productos where id = v_agua::uuid) = 48);
  insert into resultados (caso, ok) values ('No genera pagos todavía', not exists (select 1 from venta_pagos where venta_id = (j->>'venta_id')::uuid));
  select * into t from turnos_para_cargar('cprueba-cargar') x where x.id = v_turno;
  insert into resultados (caso, ok, detalle) values ('Turnos de hoy: aparece cobrado y con 3.000 pendientes', t.cobrado and t.pendiente = 3000 and t.cancha = 'Cancha 1', t::text);
  insert into resultados (caso, ok) values ('El turno cancelado no aparece',
    not exists (select 1 from turnos_para_cargar('cprueba-cargar') x where x.id = (select valor::uuid from ids where clave = 'cancelado')));
  begin
    perform vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[]'::jsonb, 0, null, (select valor::uuid from ids where clave = 'cancelado'));
    insert into resultados (caso, ok) values ('No se carga a un turno cancelado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se carga a un turno cancelado', sqlerrm = 'turno_invalido', sqlerrm); end;
  begin
    perform vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[]'::jsonb, 0, (select valor::uuid from ids where clave = 'cuenta'), v_turno);
    insert into resultados (caso, ok) values ('No se carga a una cuenta y a un turno a la vez', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se carga a una cuenta y a un turno a la vez', sqlerrm = 'datos_invalidos', sqlerrm); end;
  begin
    perform vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[]'::jsonb);
    insert into resultados (caso, ok) values ('Sin turno ni cuenta tiene que pagar', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin turno ni cuenta tiene que pagar', sqlerrm = 'falta_pagar', sqlerrm); end;
  -- Cliente: todo a la cuenta, sin pagar
  j := vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[]'::jsonb, 0, (select valor::uuid from ids where clave = 'cuenta'));
  insert into resultados (caso, ok, detalle) values ('Cliente: 1.500 a su cuenta', (j->>'a_cuenta')::numeric = 1500, j::text);
end $$;

-- 2) Alguien sin permisos no ve ni cobra los consumos
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform cobrar_consumos_turno((select valor::uuid from ids where clave = 'turno'), 'efectivo');
    insert into resultados (caso, ok) values ('Sin permisos no cobra consumos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin permisos no cobra consumos', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    perform turnos_para_cargar('cprueba-cargar');
    insert into resultados (caso, ok) values ('Sin permisos no ve los turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin permisos no ve los turnos', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 3) La agenda (sin cantina) ve los consumos del turno y los cobra con débito, con su caja abierta
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_turno uuid := (select valor::uuid from ids where clave = 'turno');
  c record;
  n numeric;
begin
  insert into ids values ('caja', abrir_caja('cprueba-cargar', 0)::text);
  select * into c from consumos_de_turnos('cprueba-cargar', (now() at time zone 'America/Argentina/Buenos_Aires')::date) x where x.reserva_id = v_turno;
  insert into resultados (caso, ok, detalle) values ('La agenda ve 3.000 pendientes y el detalle', c.pendiente = 3000 and c.detalle like '%2 Agua%', c::text);
  n := cobrar_consumos_turno(v_turno, 'debito');
  insert into resultados (caso, ok, detalle) values ('Cobra 3.000 con débito', n = 3000, n::text);
  n := cobrar_consumos_turno(v_turno, 'debito');
  insert into resultados (caso, ok, detalle) values ('Cobrar otra vez no cobra nada', n = 0, n::text);
end $$;
reset role;
insert into resultados (caso, ok) values ('El pago queda a nombre de quien cobró',
  (select cobrado_por from venta_pagos where venta_id = (select valor::uuid from ids where clave = 'venta1')) = '00000000-0000-4000-8000-0000000000d2');
insert into resultados (caso, ok) values ('La venta ya no tiene pendiente',
  (select pendiente from ventas where id = (select valor::uuid from ids where clave = 'venta1')) = 0);
insert into resultados (caso, ok, detalle) values ('Entra a la caja del que cobró (débito 3.000, mostrador)',
  (_resumen_turno((select valor::uuid from ids where clave = 'caja'))->'por_medio'->>'debito')::numeric = 3000,
  _resumen_turno((select valor::uuid from ids where clave = 'caja'))::text);
-- Medios nuevos en turnos y cuentas
update reservas set medio_pago = 'debito' where id = (select valor::uuid from ids where clave = 'turno');
insert into resultados (caso, ok) values ('Un turno se puede cobrar con débito', (select medio_pago from reservas where id = (select valor::uuid from ids where clave = 'turno')) = 'debito');
insert into cuenta_pagos (complejo_id, cuenta_id, monto, medio) select 'cprueba-cargar', valor::uuid, 100, 'debito' from ids where clave = 'cuenta';
insert into resultados (caso, ok) values ('Una cuenta se puede cobrar con débito', exists (select 1 from cuenta_pagos where medio = 'debito' and complejo_id = 'cprueba-cargar'));

-- 4) Otra carga al turno; no vinieron: pasa a la cuenta de Juan. Y anular deja el pendiente en 0.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_turno uuid := (select valor::uuid from ids where clave = 'turno');
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  j jsonb;
  n numeric;
  antes numeric := (select consumido from cuentas_con_saldo('cprueba-cargar') x where x.id = v_cuenta);
begin
  j := vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('descripcion', 'Pelotas', 'precio', 9000, 'cantidad', 1)), '[]'::jsonb, 0, null, v_turno);
  n := pasar_consumos_a_cuenta(v_turno, v_cuenta);
  insert into resultados (caso, ok, detalle) values ('Pasa 9.000 a la cuenta', n = 9000, n::text);
  insert into resultados (caso, ok) values ('La cuenta suma esos 9.000', (select consumido from cuentas_con_saldo('cprueba-cargar') x where x.id = v_cuenta) = antes + 9000);
  insert into resultados (caso, ok) values ('La venta queda a cuenta y sin pendiente',
    (select a_cuenta = 9000 and pendiente = 0 and cuenta_id = v_cuenta from ventas where id = (j->>'venta_id')::uuid));
  j := vender('cprueba-cargar', jsonb_build_array(jsonb_build_object('producto_id', (select valor from ids where clave = 'agua'), 'cantidad', 1)), '[]'::jsonb, 0, null, v_turno);
  insert into ids values ('venta3', j->>'venta_id');
end $$;
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform anular_venta((select valor::uuid from ids where clave = 'venta3'));
  insert into resultados (caso, ok) values ('Anular una venta del turno deja el pendiente en 0',
    (select pendiente = 0 and anulada from ventas where id = (select valor::uuid from ids where clave = 'venta3')));
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
