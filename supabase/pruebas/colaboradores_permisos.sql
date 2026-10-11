-- Pruebas de 20261017_colaboradores_permisos.sql. Correr SOLO en el proyecto de PRUEBA, después de
-- la migración. Crea usuarios de mentira, un complejo y un torneo de prueba del organizador-prueba.
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
  ('00000000-0000-4000-8000-0000000000d1', 'resultados@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000d2', 'torneos@prueba.test', now()),
  ('00000000-0000-4000-8000-0000000000d3', 'agenda@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-p', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_resultados, p_torneos, p_canchas) values
  ('cprueba-p', 'resultados@prueba.test', false, true, false, false),
  ('cprueba-p', 'torneos@prueba.test', false, false, true, true),
  ('cprueba-p', 'agenda@prueba.test', true, false, false, false);
insert into canchas (complejo_id, nombre, apertura, cierre, precio_90) values ('cprueba-p', 'Cancha 1', '14:00', '22:00', 14000);
insert into torneos (id, organizador_id, datos, rev)
select 'tperm1', valor::uuid, jsonb_build_object('id', 'tperm1', 'name', 'PRUEBA PERMISOS', 'organizerId', valor,
  'categories', jsonb_build_array(jsonb_build_object('id', 'c1', 'name', '6ta', 'pairs', '[]'::jsonb,
    'groups', jsonb_build_array(jsonb_build_object('id', 'g1', 'matches', jsonb_build_array(jsonb_build_object('id', 'm1', 'sets', '[]'::jsonb))))))), 1
from ids where clave = 'org';
insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono)
select 'tperm1', valor::uuid, 'c1', 'Juan Prueba', 'Pedro Prueba', '5493446000001' from ids where clave = 'org';
insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono)
select 'tperm1', valor::uuid, 'c1', 'Ana Prueba', 'Eva Prueba', '5493446000002' from ids where clave = 'org';

-- 1) Colaborador que solo carga resultados
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  r jsonb;
  n int;
  v_org text := (select valor from ids where clave = 'org');
begin
  select count(*) into n from mis_complejos_colaborador() m where m.p_resultados and not m.p_torneos and m.dueno_id::text = v_org;
  insert into resultados (caso, ok, detalle) values ('Resultados: ve su complejo, su dueño y sus permisos', n = 1, n::text);
  r := guardar_partidos('tperm1', '[{"categoria":"c1","partido":"m1","cambios":{"sets":[{"a":6,"b":3},{"a":6,"b":4}]}}]', 1, null);
  insert into resultados (caso, ok, detalle) values ('Resultados: carga el resultado de un partido', r->>'estado' = 'ok', r::text);
  begin
    r := guardar_torneo((select datos || jsonb_build_object('name', 'CAMBIADO') from torneos where id = 'tperm1'), 2, null);
    insert into resultados (caso, ok, detalle) values ('Resultados: no cambia el armado del torneo', false, r::text);
  exception when others then insert into resultados (caso, ok, detalle) values ('Resultados: no cambia el armado del torneo', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    r := guardar_torneo(jsonb_build_object('id', 'tperm-nuevo', 'name', 'X', 'organizerId', v_org, 'categories', '[]'::jsonb), 0, null);
    insert into resultados (caso, ok) values ('Resultados: no crea torneos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Resultados: no crea torneos', sqlerrm = 'no_autorizado', sqlerrm); end;
  select count(*) into n from inscripciones where torneo_id = 'tperm1';
  insert into resultados (caso, ok, detalle) values ('Resultados: no ve las inscripciones', n = 0, n::text);
  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
    select 'cprueba-p', id, current_date + 3, (current_date + 3) + time '15:00', (current_date + 3) + time '16:00', 'X' from canchas where complejo_id = 'cprueba-p';
    insert into resultados (caso, ok) values ('Resultados: sin permiso de agenda no carga turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Resultados: sin permiso de agenda no carga turnos', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) Colaborador que gestiona torneos (y canchas)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}', true);

do $$
declare
  r jsonb;
  n int;
  v_org text := (select valor from ids where clave = 'org');
  v_rev int;
begin
  r := guardar_partidos('tperm1', '[{"categoria":"c1","partido":"m1","cambios":{"sets":[{"a":7,"b":5},{"a":6,"b":4}]}}]', null, null);
  insert into resultados (caso, ok, detalle) values ('Torneos: también carga resultados', r->>'estado' = 'ok', r::text);
  v_rev := (select rev from torneos where id = 'tperm1');
  r := guardar_torneo((select datos || jsonb_build_object('name', 'CAMBIADO') from torneos where id = 'tperm1'), v_rev, null);
  insert into resultados (caso, ok, detalle) values ('Torneos: edita el torneo del dueño', r->>'estado' = 'ok' and (select datos->>'name' from torneos where id = 'tperm1') = 'CAMBIADO', r::text);
  r := guardar_torneo(jsonb_build_object('id', 'tperm-nuevo', 'name', 'NUEVO', 'organizerId', v_org, 'categories', '[]'::jsonb), 0, null);
  insert into resultados (caso, ok, detalle) values ('Torneos: crea un torneo a nombre del dueño', r->>'estado' = 'ok' and (select organizador_id::text from torneos where id = 'tperm-nuevo') = v_org, r::text);
  begin
    r := guardar_torneo(jsonb_build_object('id', 'tperm-propio', 'name', 'MIO', 'organizerId', auth.uid()::text, 'categories', '[]'::jsonb), 0, null);
    insert into resultados (caso, ok) values ('Torneos: no crea torneos a su propio nombre', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Torneos: no crea torneos a su propio nombre', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    v_rev := (select rev from torneos where id = 'tperm1');
    r := guardar_torneo((select datos || jsonb_build_object('organizerId', auth.uid()::text) from torneos where id = 'tperm1'), v_rev, null);
    insert into resultados (caso, ok) values ('Torneos: no se puede quedar con el torneo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Torneos: no se puede quedar con el torneo', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    perform borrar_torneo('tperm1');
    insert into resultados (caso, ok) values ('Torneos: no borra torneos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Torneos: no borra torneos', sqlerrm = 'no_autorizado', sqlerrm); end;

  r := guardar_en_lista('sp:events', jsonb_build_object('id', 'eperm1', 'name', 'EVENTO', 'organizerId', v_org));
  insert into resultados (caso, ok, detalle) values ('Torneos: crea un evento a nombre del dueño', r->>'estado' = 'ok', r::text);
  begin
    perform borrar_de_lista('sp:events', 'eperm1');
    insert into resultados (caso, ok) values ('Torneos: no borra eventos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Torneos: no borra eventos', sqlerrm = 'no_autorizado', sqlerrm); end;

  select count(*) into n from inscripciones where torneo_id = 'tperm1';
  insert into resultados (caso, ok, detalle) values ('Torneos: ve las inscripciones', n = 2, n::text);
  r := aceptar_inscripcion((select id from inscripciones where torneo_id = 'tperm1' and jugador1_nombre = 'Juan Prueba'));
  insert into resultados (caso, ok, detalle) values ('Torneos: acepta una inscripción', r ? 'id', r::text);
  perform rechazar_inscripcion((select id from inscripciones where torneo_id = 'tperm1' and jugador1_nombre = 'Ana Prueba'));
  insert into resultados (caso, ok) values ('Torneos: rechaza una inscripción', (select estado from inscripciones where torneo_id = 'tperm1' and jugador1_nombre = 'Ana Prueba') = 'rechazada');

  update canchas set precio_90 = 15000 where complejo_id = 'cprueba-p';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Canchas: cambia precios', n = 1, n::text);
  delete from canchas where complejo_id = 'cprueba-p';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Canchas: no borra canchas', n = 0, n::text);
  select count(*) into n from colaboradores;
  insert into resultados (caso, ok, detalle) values ('No ve la lista de colaboradores', n = 0, n::text);
  update colaboradores set p_torneos = true where email = 'resultados@prueba.test';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('No cambia permisos', n = 0, n::text);
end $$;

-- 3) Colaborador solo de agenda: no toca torneos ni precios
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d3","role":"authenticated"}', true);

do $$
declare
  r jsonb;
  n int;
begin
  begin
    r := guardar_partidos('tperm1', '[{"categoria":"c1","partido":"m1","cambios":{"sets":[]}}]', null, null);
    insert into resultados (caso, ok) values ('Agenda: no carga resultados', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Agenda: no carga resultados', sqlerrm = 'no_autorizado', sqlerrm); end;
  update canchas set precio_90 = 1 where complejo_id = 'cprueba-p';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Agenda: no cambia precios', n = 0, n::text);
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  select 'cprueba-p', id, current_date + 3, (current_date + 3) + time '15:00', (current_date + 3) + time '16:00', 'Turno' from canchas where complejo_id = 'cprueba-p';
  insert into resultados (caso, ok) values ('Agenda: carga turnos', true);
end $$;

-- 4) El dueño le saca el permiso de resultados y deja de poder
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  update colaboradores set p_resultados = false where email = 'resultados@prueba.test';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El dueño cambia permisos', n = 1, n::text);
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := guardar_partidos('tperm1', '[{"categoria":"c1","partido":"m1","cambios":{"sets":[]}}]', null, null);
  insert into resultados (caso, ok) values ('Sin el permiso: ya no carga resultados', false);
exception when others then
  insert into resultados (caso, ok, detalle) values ('Sin el permiso: ya no carga resultados', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
