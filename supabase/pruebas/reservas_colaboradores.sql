-- Pruebas de 20261016_reservas_colaboradores.sql. Correr SOLO en el proyecto de PRUEBA, después de
-- la migración. Crea usuarios de mentira y dos complejos de prueba del organizador-prueba. Todo se
-- deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador de la base)
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'empleado@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000c2', 'sinconfirmar@prueba.test', null),
  ('00000000-0000-4000-8000-0000000000c3', 'intruso@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values
  ('cprueba-c', (select id from organizers where username = 'organizador-prueba'), true),
  ('cprueba-otro', (select id from organizers where username = 'organizador-prueba'), true);
with c as (
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_90) values ('cprueba-c', 'Cancha 1', '14:00', '22:00', 14000) returning id
) insert into ids select 'cancha', id::text from c;
with c as (
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_90) values ('cprueba-otro', 'Cancha A', '14:00', '22:00', 14000) returning id
) insert into ids select 'cancha_otro', id::text from c;
with r as (
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre)
  select 'cprueba-c', valor::uuid, current_date + 3, (current_date + 3) + time '18:00', (current_date + 3) + time '19:30', 'pendiente', 'online', 'Pedido'
  from ids where clave = 'cancha' returning id
) insert into ids select 'pendiente', id::text from r;
with r as (
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre)
  select 'cprueba-c', valor::uuid, current_date + 3, (current_date + 3) + time '20:00', (current_date + 3) + time '21:30', 'confirmada', 'manual', 'Confirmado'
  from ids where clave = 'cancha' returning id
) insert into ids select 'confirmada', id::text from r;
with r as (
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre)
  select 'cprueba-otro', valor::uuid, current_date + 3, (current_date + 3) + time '18:00', (current_date + 3) + time '19:30', 'pendiente', 'online', 'Otro complejo'
  from ids where clave = 'cancha_otro' returning id
) insert into ids select 'otro', id::text from r;

-- 1) El dueño agrega colaboradores
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.organizers where username = 'organizador-prueba'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  insert into colaboradores (complejo_id, email, nombre) values ('cprueba-c', 'empleado@prueba.test', 'Empleado'), ('cprueba-c', 'sinconfirmar@prueba.test', null);
  select count(*) into n from colaboradores where complejo_id = 'cprueba-c';
  insert into resultados (caso, ok, detalle) values ('El dueño agrega y ve sus colaboradores', n = 2, n::text);
  begin
    insert into colaboradores (complejo_id, email) values ('cprueba-c', 'Mayusculas@Prueba.test');
    insert into resultados (caso, ok) values ('Mail con mayúsculas: rechazado (la app lo pasa a minúsculas)', false);
  exception when check_violation then
    insert into resultados (caso, ok) values ('Mail con mayúsculas: rechazado (la app lo pasa a minúsculas)', true);
  end;
end $$;

-- 2) El empleado (mail confirmado)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);

do $$
declare
  n int;
  t text;
  v_pend uuid := (select valor::uuid from ids where clave = 'pendiente');
  v_conf uuid := (select valor::uuid from ids where clave = 'confirmada');
begin
  select count(*) into n from mis_complejos_colaborador() x where x = 'cprueba-c';
  insert into resultados (caso, ok, detalle) values ('Ve que es colaborador de su complejo (y de ninguno más)', n = 1 and (select count(*) from mis_complejos_colaborador()) = 1, n::text);
  select count(*) into n from reservas where complejo_id = 'cprueba-c';
  insert into resultados (caso, ok, detalle) values ('Ve las reservas de su complejo', n = 2, n::text);
  select count(*) into n from reservas where complejo_id = 'cprueba-otro';
  insert into resultados (caso, ok, detalle) values ('No ve las de otro complejo', n = 0, n::text);

  t := colaborador_reserva(v_pend, 'confirmar');
  insert into resultados (caso, ok, detalle) values ('Confirma un pedido pendiente', t = 'ok' and (select estado from reservas where id = v_pend) = 'confirmada', t);
  t := colaborador_reserva(v_conf, 'cobro', 'efectivo');
  insert into resultados (caso, ok, detalle) values ('Registra el cobro en efectivo', (select medio_pago from reservas where id = v_conf) = 'efectivo', t);
  t := colaborador_reserva(v_conf, 'cobro', null);
  insert into resultados (caso, ok) values ('Vuelve a "sin cobrar"', (select medio_pago from reservas where id = v_conf) is null);

  begin perform colaborador_reserva(v_conf, 'confirmar'); insert into resultados (caso, ok) values ('No confirma lo que ya está confirmado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No confirma lo que ya está confirmado', sqlerrm = 'estado_invalido', sqlerrm); end;
  begin perform colaborador_reserva(v_conf, 'cobro', 'tarjeta'); insert into resultados (caso, ok) values ('Medio de pago inventado: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Medio de pago inventado: rechazado', sqlerrm = 'datos_invalidos', sqlerrm); end;
  begin perform colaborador_reserva(v_conf, 'cancelar'); insert into resultados (caso, ok) values ('No puede cancelar turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede cancelar turnos', sqlerrm = 'datos_invalidos', sqlerrm); end;
  begin perform colaborador_reserva((select valor::uuid from ids where clave = 'otro'), 'confirmar'); insert into resultados (caso, ok) values ('No toca pedidos de otro complejo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No toca pedidos de otro complejo', sqlerrm = 'no_autorizado', sqlerrm); end;

  update reservas set estado = 'cancelada' where id = v_conf;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('No cambia reservas directo', n = 0, n::text);
  update canchas set precio_90 = 1 where complejo_id = 'cprueba-c';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('No cambia precios', n = 0, n::text);
  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
    values ('cprueba-c', (select valor::uuid from ids where clave = 'cancha'), current_date + 4, (current_date + 4) + time '15:00', (current_date + 4) + time '16:00', 'X');
    insert into resultados (caso, ok) values ('No carga turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No carga turnos', sqlstate = '42501', sqlerrm); end;
  select count(*) into n from colaboradores;
  insert into resultados (caso, ok, detalle) values ('No ve la lista de colaboradores', n = 0, n::text);
  begin
    insert into colaboradores (complejo_id, email) values ('cprueba-c', 'amigo@prueba.test');
    insert into resultados (caso, ok) values ('No puede agregar colaboradores', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede agregar colaboradores', sqlstate = '42501', sqlerrm); end;
  begin perform guardar_torneo(jsonb_build_object('id', 'tcol', 'name', 'X', 'organizerId', auth.uid()::text, 'categories', '[]'::jsonb), 0, null);
    insert into resultados (caso, ok) values ('No puede crear torneos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede crear torneos', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 3) Mail en la lista pero sin confirmar, y un usuario que no está en la lista
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from reservas where complejo_id = 'cprueba-c';
  insert into resultados (caso, ok, detalle) values ('Mail sin confirmar: no entra', n = 0 and (select count(*) from mis_complejos_colaborador()) = 0, n::text);
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c3","role":"authenticated"}', true);
do $$
begin
  perform colaborador_reserva((select valor::uuid from ids where clave = 'confirmada'), 'cobro', 'efectivo');
  insert into resultados (caso, ok) values ('Alguien que no está en la lista: bloqueado', false);
exception when others then
  insert into resultados (caso, ok, detalle) values ('Alguien que no está en la lista: bloqueado', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

-- 4) El dueño lo quita y el empleado pierde el acceso
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.organizers where username = 'organizador-prueba'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  delete from colaboradores where complejo_id = 'cprueba-c' and email = 'empleado@prueba.test';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El dueño quita al colaborador', n = 1, n::text);
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from reservas where complejo_id = 'cprueba-c';
  insert into resultados (caso, ok, detalle) values ('Quitado: ya no ve la agenda', n = 0, n::text);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
