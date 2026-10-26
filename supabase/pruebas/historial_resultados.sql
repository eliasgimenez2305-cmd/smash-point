-- Pruebas de 20261052_historial_resultados.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración. Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('otro', gen_random_uuid()::text);
insert into auth.users (id, aud, role, email, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', 'otro-historial@inventado.test', now(), now() from ids where clave = 'otro';

-- Un torneo con un grupo de 2 partidos y una llave de 1 partido
insert into torneos (id, organizador_id, datos)
select 'thist-prueba', valor::uuid, jsonb_build_object('id', 'thist-prueba', 'name', 'Historial', 'organizerId', valor,
  'categories', jsonb_build_array(jsonb_build_object('id', 'c7', 'name', '7MA',
    'pairs', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'TORREZ / ADON'), jsonb_build_object('id', 'p2', 'name', 'FEROLDI / RODRIGUEZ'), jsonb_build_object('id', 'p3', 'name', 'ALCANTARA / FRACCAROLLI')),
    'groups', jsonb_build_array(jsonb_build_object('id', 'gA', 'name', 'Grupo A', 'matches', jsonb_build_array(
      jsonb_build_object('id', 'm3', 'pairA', 'p1', 'pairB', 'p2', 'sets', '[]'::jsonb),
      jsonb_build_object('id', 'm1', 'pairA', 'p3', 'pairB', 'p1', 'sets', '[]'::jsonb)))),
    'bracket', jsonb_build_array(jsonb_build_array(jsonb_build_object('id', 'b1', 'pairA', 'p2', 'pairB', 'p3', 'sets', '[]'::jsonb)))))) from ids where clave = 'org';

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated', 'email', 'organizador@smashpoint.test')::text, true);
set local role authenticated;
do $$
declare v jsonb; h record;
begin
  -- Se carga al revés (gana FEROLDI), tecleando de a un número
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m3", "cambios": {"sets": [{"a": 2, "b": null}]}}]'::jsonb);
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m3", "cambios": {"sets": [{"a": 2, "b": 6}, {"a": 1, "b": 6}]}}]'::jsonb);
  select * into h from resultados_historial where torneo_id = 'thist-prueba' and partido = 'm3' order by id;
  insert into resultados (caso, ok, detalle) values ('Cargar escribiendo de a poco: un solo renglón, de vacío a 2-6 1-6',
    (select count(*) from resultados_historial where torneo_id = 'thist-prueba') = 1
    and h.antes = '{}'::jsonb and h.despues = '{"sets": [{"a": 2, "b": 6}, {"a": 1, "b": 6}]}'::jsonb, h.despues::text);
  insert into resultados (caso, ok, detalle) values ('Guarda quién, partido, categoría, grupo y parejas',
    h.por = auth.uid() and h.por_quien = 'organizador@smashpoint.test' and h.categoria = '7MA' and h.lugar = 'Grupo A'
    and h.pareja_a = 'TORREZ / ADON' and h.pareja_b = 'FEROLDI / RODRIGUEZ', row_to_json(h)::text);

  -- Un cambio de horario o de "en curso" no es un cambio de resultado
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m1", "cambios": {"liveStatus": "en_curso", "schedule": {"date": "2026-10-24", "time": "14:00", "court": 3}}}]'::jsonb);
  insert into resultados (caso, ok) values ('Horario o "en curso": no se anota', (select count(*) from resultados_historial where torneo_id = 'thist-prueba') = 1);

  -- Un resultado de la llave y un W.O.
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "b1", "cambios": {"walkover": "p3"}}]'::jsonb);
  insert into resultados (caso, ok, detalle) values ('W.O. en la llave: se anota con su ronda',
    exists (select 1 from resultados_historial where partido = 'b1' and lugar = 'llave:0:1' and despues = '{"walkover": "p3"}'::jsonb),
    (select string_agg(lugar || ' ' || despues::text, ', ') from resultados_historial where partido = 'b1'));
end $$;
reset role;

-- Pasado el minuto, se corrige (gana TORREZ): otro renglón, de 2-6 1-6 a 6-2 6-1
update resultados_historial set cambiado_at = now() - interval '10 minutes', creado_at = now() - interval '10 minutes' where torneo_id = 'thist-prueba';
set local role authenticated;
do $$
begin
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m3", "cambios": {"sets": []}}]'::jsonb);
  insert into resultados (caso, ok, detalle) values ('Borrar el resultado se anota (de 2-6 1-6 a vacío)',
    exists (select 1 from resultados_historial where partido = 'm3' and antes = '{"sets": [{"a": 2, "b": 6}, {"a": 1, "b": 6}]}'::jsonb and despues = '{}'::jsonb),
    (select string_agg(antes::text || ' > ' || despues::text, ' | ' order by id) from resultados_historial where partido = 'm3'));
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m3", "cambios": {"sets": [{"a": 6, "b": 2}, {"a": 6, "b": 1}]}}]'::jsonb);
  insert into resultados (caso, ok, detalle) values ('Borrar y volver a cargar enseguida: un renglón, de 2-6 1-6 a 6-2 6-1',
    (select count(*) from resultados_historial where partido = 'm3') = 2
    and exists (select 1 from resultados_historial where partido = 'm3' and antes = '{"sets": [{"a": 2, "b": 6}, {"a": 1, "b": 6}]}'::jsonb and despues = '{"sets": [{"a": 6, "b": 2}, {"a": 6, "b": 1}]}'::jsonb),
    (select string_agg(antes::text || ' > ' || despues::text, ' | ' order by id) from resultados_historial where partido = 'm3'));
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m1", "cambios": {"sets": [{"a": 1, "b": 6}]}}]'::jsonb);
  perform guardar_partidos('thist-prueba', '[{"categoria": "c7", "partido": "m1", "cambios": {"sets": []}}]'::jsonb);
  insert into resultados (caso, ok) values ('Si vuelve a como estaba enseguida, el renglón se borra', not exists (select 1 from resultados_historial where partido = 'm1'));
  insert into resultados (caso, ok) values ('El organizador ve su historial', (select count(*) from resultados_historial where torneo_id = 'thist-prueba') >= 2);
end $$;
reset role;

-- Otra cuenta no ve el historial de un torneo ajeno
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'otro'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok) values ('Otra cuenta no ve el historial', not exists (select 1 from resultados_historial where torneo_id = 'thist-prueba'));
end $$;
reset role;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_HIST' as fin from resultados;
rollback;
