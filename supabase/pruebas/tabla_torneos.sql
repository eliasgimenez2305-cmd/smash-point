-- Pruebas de 20261009_tabla_torneos.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración y con los datos de ejemplo (torneo 'tprueba1' del usuario organizador-prueba, con el
-- partido de grupo m1, m2 y el de llave b1, y una inscripción pendiente). Todo se deshace al final.
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
grant all on resultados to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Hacerse pasar por el organizador de prueba
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.organizers where username = 'organizador-prueba'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  r jsonb;
  rev0 int := (select rev from torneos where id = 'tprueba1');
  t jsonb;
begin
  -- 1. Celular A carga el partido m1 sabiendo la versión actual
  r := guardar_partidos('tprueba1', '[{"categoria":"c4ta","partido":"m1","cambios":{"sets":[{"a":6,"b":3},{"a":6,"b":4}]}}]', rev0, '{"jugados":1}');
  insert into resultados (caso, ok, detalle) values ('A guarda m1: ok, sin devolver el torneo', r->>'estado' = 'ok' and (r->>'rev')::int = rev0 + 1 and r->'torneo' = 'null'::jsonb, r::text);

  -- 2. Celular B, que todavía tenía la versión vieja, carga m2: no choca y recibe el torneo al día
  r := guardar_partidos('tprueba1', '[{"categoria":"c4ta","partido":"m2","cambios":{"sets":[{"a":7,"b":5},{"a":6,"b":2}]}}]', rev0, null);
  t := r->'torneo';
  insert into resultados (caso, ok, detalle) values ('B guarda m2 con versión vieja: ok y recibe el torneo',
    r->>'estado' = 'ok' and t is not null and t->'categories'->0->'groups'->0->'matches'->0->'sets'->0->>'a' = '6'
    and t->'categories'->0->'groups'->0->'matches'->1->'sets'->0->>'a' = '7', left(r::text, 200));

  -- 3. Quedaron los dos resultados en la tabla
  t := (select datos from torneos where id = 'tprueba1');
  insert into resultados (caso, ok, detalle) values ('Tabla: m1 y m2 guardados',
    jsonb_array_length(t->'categories'->0->'groups'->0->'matches'->0->'sets') = 2 and jsonb_array_length(t->'categories'->0->'groups'->0->'matches'->1->'sets') = 2, null);

  -- 4. El espejo (lista vieja) está al día
  t := (select x from app_data, jsonb_array_elements(value) x where key = 'sp:tournaments' and x->>'id' = 'tprueba1');
  insert into resultados (caso, ok, detalle) values ('Espejo al día (rev y resultados)',
    (t->>'rev')::int = rev0 + 2 and t->'categories'->0->'groups'->0->'matches'->1->'sets'->0->>'a' = '7', 'rev ' || (t->>'rev'));

  -- 5. Resultado de la llave, W.O. y "en curso"; una clave que no se permite se ignora
  r := guardar_partidos('tprueba1', '[{"categoria":"c4ta","partido":"b1","cambios":{"walkover":"p2","pairA":"trampa"}},{"categoria":"c4ta","partido":"m3","cambios":{"liveStatus":"en_curso","schedule":{"date":"2026-10-20","time":"12:00","court":2}}}]', rev0 + 2, null);
  t := (select datos from torneos where id = 'tprueba1');
  insert into resultados (caso, ok, detalle) values ('Llave W.O. y en curso + horario; pairA ignorado',
    t->'categories'->0->'bracket'->0->0->>'walkover' = 'p2' and t->'categories'->0->'bracket'->0->0->>'pairA' = 'p1'
    and t->'categories'->0->'groups'->0->'matches'->2->>'liveStatus' = 'en_curso' and t->'categories'->0->'groups'->0->'matches'->2->'schedule'->>'court' = '2', null);

  -- 6. Un partido que no existe se saltea y se informa
  r := guardar_partidos('tprueba1', '[{"categoria":"c4ta","partido":"no-existe","cambios":{"sets":[]}}]', null, null);
  insert into resultados (caso, ok, detalle) values ('Partido inexistente: omitido', r->'omitidos' = '["no-existe"]'::jsonb, r->>'omitidos');

  -- 7. guardar_torneo con versión vieja: conflicto (y devuelve la actual)
  r := guardar_torneo((select datos from torneos where id = 'tprueba1'), rev0, null);
  insert into resultados (caso, ok, detalle) values ('guardar_torneo versión vieja: conflicto', r->>'estado' = 'conflicto' and (r->'torneo'->>'rev')::int = (select rev from torneos where id = 'tprueba1'), r->>'estado');

  -- 8. guardar_torneo con la versión actual: ok, y guarda el resumen
  r := guardar_torneo((select datos from torneos where id = 'tprueba1') || '{"name":"PRUEBA COPIA 2"}', (select rev from torneos where id = 'tprueba1'), '{"nombre":"PRUEBA COPIA 2"}');
  insert into resultados (caso, ok, detalle) values ('guardar_torneo versión actual: ok + resumen',
    r->>'estado' = 'ok' and (select datos->>'name' from torneos where id = 'tprueba1') = 'PRUEBA COPIA 2' and (select resumen->>'nombre' from torneos where id = 'tprueba1') = 'PRUEBA COPIA 2', r::text);

  -- 9. Aceptar la inscripción pendiente: la pareja entra al torneo y sube la versión
  r := aceptar_inscripcion((select id from inscripciones where torneo_id = 'tprueba1' and estado = 'pendiente' limit 1));
  t := (select datos from torneos where id = 'tprueba1');
  insert into resultados (caso, ok, detalle) values ('Aceptar inscripción: pareja con disponibilidad',
    jsonb_array_length(t->'categories'->0->'pairs') = 4 and t->'categories'->0->'pairs'->3->>'name' = 'Cuatro A / Cuatro B'
    and t->'categories'->0->'pairs'->3->'availability'->0->>'to' = '14:00', r->>'name');

  -- 10. No puede tocar un torneo que no es suyo
  begin
    r := guardar_partidos('tinfo', '[]', null, null);
    insert into resultados (caso, ok, detalle) values ('Torneo ajeno: bloqueado', false, r::text);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('Torneo ajeno: bloqueado', sqlerrm = 'no_autorizado', sqlerrm);
  end;
  begin
    r := borrar_torneo('tinfo');
    insert into resultados (caso, ok, detalle) values ('Borrar torneo ajeno: bloqueado', false, r::text);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('Borrar torneo ajeno: bloqueado', sqlerrm = 'no_autorizado', sqlerrm);
  end;

  -- 11. Torneo nuevo propio, y después borrarlo
  r := guardar_torneo(jsonb_build_object('id', 'tnuevo', 'name', 'NUEVO', 'organizerId', auth.uid()::text, 'categories', '[]'::jsonb), 0, '{"nombre":"NUEVO"}');
  insert into resultados (caso, ok, detalle) values ('Torneo nuevo: rev 1 y en el espejo',
    r->>'rev' = '1' and exists (select 1 from app_data, jsonb_array_elements(value) x where key = 'sp:tournaments' and x->>'id' = 'tnuevo'), r::text);
  r := borrar_torneo('tnuevo');
  insert into resultados (caso, ok, detalle) values ('Borrar torneo propio: sale de la tabla y del espejo',
    not exists (select 1 from torneos where id = 'tnuevo') and not exists (select 1 from app_data, jsonb_array_elements(value) x where key = 'sp:tournaments' and x->>'id' = 'tnuevo'), null);
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
