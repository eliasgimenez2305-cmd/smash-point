-- Pruebas de 20261018_cobros_inscripciones.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración. Crea usuarios de mentira, un complejo y un torneo de prueba del organizador-prueba.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador de la base)
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into ids values ('org_email', (select u.email from auth.users u join organizers o on o.id = u.id where o.username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000e1', 'cobra@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000e2', 'soloagenda@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000e3', 'ajeno@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-cobros', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_resultados, p_torneos, p_canchas) values
  ('cprueba-cobros', 'cobra@prueba.test', false, true, false, false),
  ('cprueba-cobros', 'soloagenda@prueba.test', true, false, false, false);
insert into torneos (id, organizador_id, datos, rev)
select 'tcobros', valor::uuid, jsonb_build_object('id', 'tcobros', 'name', 'PRUEBA COBROS', 'organizerId', valor, 'precioJugador', 15000, 'categories', '[]'::jsonb), 1
from ids where clave = 'org';
-- Un torneo de otro organizador (sin dueño): no se le pueden cargar pagos a nombre del organizador-prueba
insert into torneos (id, organizador_id, datos, rev) values ('tajeno', null, '{"id":"tajeno","name":"AJENO","categories":[]}', 1);

-- 1) El organizador
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  v_id uuid;
  r pagos_inscripcion%rowtype;
begin
  insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio, cobrado_por, cobrado_por_email)
  values ('tcobros', v_org, 'c1', 'p1', 1, 15000, 'efectivo', gen_random_uuid(), 'otro@mail.com') returning id into v_id;
  select * into r from pagos_inscripcion where id = v_id;
  insert into resultados (caso, ok, detalle) values ('Organizador registra un pago; "quién cobró" lo pone la base', r.cobrado_por = v_org and r.cobrado_por_email = (select valor from ids where clave = 'org_email'), r.cobrado_por_email);
  insert into ids values ('pago1', v_id::text);
  begin
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio) values ('tcobros', v_org, 'c1', 'p1', 3, 100, 'efectivo');
    insert into resultados (caso, ok) values ('Jugador 3: rechazado', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Jugador 3: rechazado', true); end;
  begin
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio) values ('tcobros', v_org, 'c1', 'p1', 2, 100, 'cheque');
    insert into resultados (caso, ok) values ('Medio inventado: rechazado', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Medio inventado: rechazado', true); end;
  begin
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio) values ('tcobros', v_org, 'c1', 'p1', 2, 0, 'efectivo');
    insert into resultados (caso, ok) values ('Monto 0: rechazado', false);
  exception when check_violation then insert into resultados (caso, ok) values ('Monto 0: rechazado', true); end;
  begin
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio) values ('tajeno', v_org, 'c1', 'p1', 1, 100, 'efectivo');
    insert into resultados (caso, ok) values ('Pago en un torneo que no es suyo: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Pago en un torneo que no es suyo: rechazado', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) Colaborador con acceso a torneos (carga resultados)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);

do $$
declare
  v_org uuid := (select valor::uuid from ids where clave = 'org');
  n int;
  r pagos_inscripcion%rowtype;
begin
  select count(*) into n from pagos_inscripcion where torneo_id = 'tcobros';
  insert into resultados (caso, ok, detalle) values ('Colaborador ve los pagos del torneo', n = 1, n::text);
  insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
  values ('tcobros', v_org, 'c1', 'p1', 2, 7500, 'transferencia') returning * into r;
  insert into resultados (caso, ok, detalle) values ('Colaborador registra un pago y queda su mail', r.cobrado_por_email = 'cobra@prueba.test', r.cobrado_por_email);
  delete from pagos_inscripcion where id = (select valor::uuid from ids where clave = 'pago1');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Colaborador no puede anular pagos', n = 0, n::text);
end $$;

-- 3) Colaborador solo de agenda, y alguien ajeno
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}', true);
do $$
declare
  n int;
begin
  select count(*) into n from pagos_inscripcion;
  insert into resultados (caso, ok, detalle) values ('Colaborador solo de agenda: no ve pagos', n = 0, n::text);
  begin
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
    values ('tcobros', (select valor::uuid from ids where clave = 'org'), 'c1', 'p2', 1, 100, 'efectivo');
    insert into resultados (caso, ok) values ('Colaborador solo de agenda: no registra pagos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Colaborador solo de agenda: no registra pagos', sqlstate = '42501', sqlerrm); end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e3","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from pagos_inscripcion;
  insert into resultados (caso, ok, detalle) values ('Alguien ajeno no ve pagos', n = 0, n::text);
end $$;

-- 4) El organizador anula un pago
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  delete from pagos_inscripcion where id = (select valor::uuid from ids where clave = 'pago1');
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El organizador anula un pago', n = 1, n::text);
end $$;

-- 5) El público
reset role;
do $$
begin
  set local role anon;
  perform count(*) from pagos_inscripcion;
  reset role;
  insert into resultados (caso, ok) values ('El público no ve pagos', false);
exception when insufficient_privilege then
  insert into resultados (caso, ok) values ('El público no ve pagos', true);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
