-- Pruebas de 20261039_inscripcion_perfiles.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila con la cantidad de casos,
-- si dieron todos bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador): un torneo con inscripciones abiertas del organizador de prueba
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into torneos (id, organizador_id, datos)
select 'tprueba-insc', null, jsonb_build_object(
  'id', 'tprueba-insc', 'name', 'Prueba inscripción', 'organizerId', valor, 'inscripcionesAbiertas', true, 'status', 'Próximo',
  'categories', jsonb_build_array(
    jsonb_build_object('id', 'c4', 'name', '4TA', 'pairs', '[]'::jsonb, 'groups', '[]'::jsonb),
    jsonb_build_object('id', 'c8', 'name', 'Súper 8', 'format', 'super8_individual', 'pairs', '[]'::jsonb, 'groups', '[]'::jsonb)))
from ids where clave = 'org';

-- 1) El público se inscribe (sin sesión)
set local role anon;
do $$
declare v text;
begin
  v := inscribir_pareja('tprueba-insc', 'c4', ' Pérez ', 'Juan', '3446 999101', 'López', 'Martín', '0 3446 999102');
  insert into resultados (caso, ok, detalle) values ('Inscripción nueva de una pareja', v = 'ok', v);

  v := inscribir_pareja('tprueba-insc', 'c4', 'Gómez', 'Ana', '3446999103', 'Ruiz', 'Sol', '3446999104', 2::smallint);
  insert into resultados (caso, ok, detalle) values ('Otra pareja que pide que contacten al jugador 2', v = 'ok', v);

  begin
    perform inscribir_pareja('tprueba-insc', 'c4', 'Díaz', 'Pablo', '3446999105', 'Sosa', 'Leo', null);
    insert into resultados (caso, ok) values ('Sin teléfono del jugador 2: la rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin teléfono del jugador 2: la rechaza', sqlerrm = 'telefono_invalido', sqlerrm); end;

  begin
    perform inscribir_pareja('tprueba-insc', 'c4', 'Díaz', '', '3446999105', 'Sosa', 'Leo', '3446999106');
    insert into resultados (caso, ok) values ('Sin nombre: la rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin nombre: la rechaza', sqlerrm = 'datos_invalidos', sqlerrm); end;

  begin
    perform inscribir_pareja('tprueba-insc', 'c4', 'Pérez', 'Juan', '3446999101', 'Otro', 'Más', '3446999107');
    insert into resultados (caso, ok) values ('Mismo contacto en la misma categoría: repetida', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Mismo contacto en la misma categoría: repetida', sqlerrm = 'duplicada', sqlerrm); end;

  v := inscribir_pareja('tprueba-insc', 'c8', 'Vera', 'Luz', '3446999108', 'Ignorado', 'Ignorado', '3446999109');
  insert into resultados (caso, ok, detalle) values ('Súper 8 individual: un solo jugador', v = 'ok', v);

  -- La inscripción vieja (sitio publicado) sigue andando
  v := crear_inscripcion('tprueba-insc', 'c4', 'Juan Viejo', 'Pedro Viejo', '3446999110');
  insert into resultados (caso, ok, detalle) values ('crear_inscripcion (la de antes) sigue andando', v = 'ok', v);
end $$;

reset role;
do $$
declare r inscripciones%rowtype;
begin
  select * into r from inscripciones where torneo_id = 'tprueba-insc' and telefono1 = '5493446999101';
  insert into resultados (caso, ok, detalle) values ('Se guardan los dos jugadores y el contacto',
    r.jugador1_nombre = 'Pérez Juan' and r.jugador2_nombre = 'López Martín' and r.telefono = '5493446999101' and r.telefono2 = '5493446999102' and r.contacto = 1,
    r.jugador1_nombre || ' / ' || r.jugador2_nombre || ' / ' || r.telefono);
  select * into r from inscripciones where torneo_id = 'tprueba-insc' and telefono1 = '5493446999103';
  insert into resultados (caso, ok, detalle) values ('Contacto 2: el teléfono de contacto es el del jugador 2', r.telefono = '5493446999104', r.telefono);
  select * into r from inscripciones where torneo_id = 'tprueba-insc' and categoria_id = 'c8';
  insert into resultados (caso, ok) values ('Súper 8 individual: sin jugador 2', r.jugador2_nombre is null and r.telefono2 is null);
end $$;

-- Juan Pérez anotado otra vez, con otro compañero y su nombre escrito distinto (administrador)
insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono,
  jugador1_apellido, jugador1_pila, telefono1, jugador2_apellido, jugador2_pila, telefono2, contacto)
select 'tprueba-insc', valor::uuid, 'c4', 'Pérez Juan', 'Nuevo Compa', '5493446999111',
  'perez', 'JUAN', '5493446999101', 'Nuevo', 'Compa', '5493446999111', 2 from ids where clave = 'org';

-- 2) El organizador acepta
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_pareja jsonb;
  v_vieja jsonb;
  v_id1 text;
begin
  v_pareja := aceptar_inscripcion((select id from inscripciones where torneo_id = 'tprueba-insc' and telefono1 = '5493446999101' and telefono2 = '5493446999102'));
  insert into resultados (caso, ok, detalle) values ('Aceptada: la pareja entra con sus dos jugadores con perfil',
    v_pareja->>'name' = 'Pérez Juan / López Martín' and jsonb_array_length(v_pareja->'players') = 2
      and v_pareja->'players'->0->>'id' is not null and v_pareja->'players'->1->>'id' is not null,
    v_pareja::text);
  insert into resultados (caso, ok) values ('El teléfono no queda en el torneo',
    (select datos::text from torneos where id = 'tprueba-insc') not like '%999101%');
  v_id1 := v_pareja->'players'->0->>'id';

  -- El mismo Juan Pérez en la otra inscripción: mismo perfil
  v_pareja := aceptar_inscripcion((select id from inscripciones where torneo_id = 'tprueba-insc' and telefono = '5493446999111'));
  insert into resultados (caso, ok, detalle) values ('El mismo jugador en otra inscripción usa el mismo perfil', v_pareja->'players'->0->>'id' = v_id1, v_pareja::text);

  v_vieja := aceptar_inscripcion((select id from inscripciones where torneo_id = 'tprueba-insc' and telefono = '5493446999110'));
  insert into resultados (caso, ok, detalle) values ('Inscripción vieja: entra como antes, sin perfiles', v_vieja->'players' is null and v_vieja->>'name' = 'Juan Viejo / Pedro Viejo', v_vieja::text);
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PRUEBA2' as fin from resultados;
rollback;
