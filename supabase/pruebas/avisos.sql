-- Pruebas de 20261042_avisos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones "reservas" y "cuentas" prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador): complejo con cancha, un jugador con cuenta, un empleado con agenda y
-- otro con torneos, y un torneo del organizador
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')),
  ('j', gen_random_uuid()::text), ('e', gen_random_uuid()::text), ('t', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', tel, now(), now(), now()
from (values ('j', '5493446999501'), ('e', '5493446999502'), ('t', '5493446999503')) v(clave, tel) join ids using (clave);
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-av', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-av', 'Cancha 1', '00:00', '23:30') returning id)
insert into ids select 'cancha', id::text from c;
insert into colaboradores (complejo_id, telefono, p_agenda, p_torneos) values
  ('cprueba-av', '5493446999502', true, false),
  ('cprueba-av', '5493446999503', false, true);
insert into torneos (id, organizador_id, datos)
select 'tprueba-av', null, jsonb_build_object('id', 'tprueba-av', 'name', 'Torneo de avisos', 'organizerId', valor,
  'categories', jsonb_build_array(jsonb_build_object('id', 'c4', 'name', '4TA', 'pairs', '[]'::jsonb, 'groups', '[]'::jsonb)))
from ids where clave = 'org';

create temp view avisos_de as
  select n.*, i.clave from notificaciones n join ids i on i.valor = n.usuario_id::text;
grant select on avisos_de to authenticated;

do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_j uuid := (select valor::uuid from ids where clave = 'j');
  d date := current_date + 3;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid;
  v_n int;
begin
  -- Pedido online
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id)
  values ('cprueba-av', v_cancha, d, d + time '10:00', d + time '11:00', 'pendiente', 'online', 'Juan', v_j) returning id into r1;
  insert into resultados (caso, ok, detalle) values ('Pedido online: avisa al dueño y al empleado con agenda',
    (select count(*) from avisos_de where tipo = 'turno_pedido' and ref = r1::text and clave in ('org', 'e')) = 2, null);
  insert into resultados (caso, ok) values ('Pedido online: no avisa al empleado sin agenda',
    not exists (select 1 from avisos_de where tipo = 'turno_pedido' and clave = 't'));

  update reservas set estado = 'confirmada' where id = r1;
  insert into resultados (caso, ok, detalle) values ('Confirmado: avisa al jugador',
    exists (select 1 from avisos_de where tipo = 'turno_confirmado' and clave = 'j' and texto like '%confirmó tu turno del%'),
    (select texto from avisos_de where tipo = 'turno_confirmado' and clave = 'j' limit 1));

  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id)
  values ('cprueba-av', v_cancha, d, d + time '12:00', d + time '13:00', 'pendiente', 'online', 'Juan', v_j) returning id into r2;
  update reservas set estado = 'rechazada' where id = r2;
  insert into resultados (caso, ok) values ('Rechazado: avisa al jugador', exists (select 1 from avisos_de where tipo = 'turno_rechazado' and clave = 'j'));

  update reservas set estado = 'cancelada', cancelada_at = now(), cancelada_por = 'complejo' where id = r1;
  insert into resultados (caso, ok) values ('Cancelado por el complejo: avisa al jugador', exists (select 1 from avisos_de where tipo = 'turno_cancelado' and clave = 'j'));

  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id)
  values ('cprueba-av', v_cancha, d, d + time '14:00', d + time '15:00', 'confirmada', 'online', 'Juan', v_j) returning id into r3;
  update reservas set estado = 'cancelada', cancelada_at = now(), cancelada_por = 'jugador' where id = r3;
  insert into resultados (caso, ok) values ('Cancelado por el jugador: avisa al dueño y al empleado con agenda',
    (select count(*) from avisos_de where tipo = 'turno_cancelado_jugador' and clave in ('org', 'e')) = 2);

  -- Cargado a mano: no genera avisos
  select count(*) into v_n from notificaciones;
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre) values ('cprueba-av', v_cancha, d, d + time '16:00', d + time '17:00', 'Pedro');
  insert into resultados (caso, ok) values ('Turno cargado a mano: no genera avisos', (select count(*) from notificaciones) = v_n);

  -- Recordatorio 2 horas antes, sin repetirse
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id)
  values ('cprueba-av', v_cancha, current_date, date_trunc('minute', now()) + interval '2 hours', date_trunc('minute', now()) + interval '3 hours', 'confirmada', 'online', 'Juan', v_j) returning id into r4;
  perform avisar_recordatorios();
  perform avisar_recordatorios();
  insert into resultados (caso, ok, detalle) values ('Recordatorio 2 h antes, una sola vez',
    (select count(*) from avisos_de where tipo = 'turno_recordatorio' and ref = r4::text) = 1,
    (select count(*) from avisos_de where tipo = 'turno_recordatorio' and ref = r4::text)::text);

  -- Inscripción online
  insert into inscripciones (torneo_id, organizador_id, categoria_id, jugador1_nombre, jugador2_nombre, telefono, telefono1, telefono2, contacto)
  select 'tprueba-av', valor::uuid, 'c4', 'Perez Juan', 'Lopez Martin', '5493446999501', '5493446999501', '5493446999599', 1 from ids where clave = 'org';
  insert into resultados (caso, ok, detalle) values ('Inscripción nueva: avisa al organizador y al empleado con torneos',
    (select count(*) from avisos_de where tipo = 'inscripcion_nueva' and clave in ('org', 't')) = 2
      and not exists (select 1 from avisos_de where tipo = 'inscripcion_nueva' and clave = 'e'),
    (select texto from avisos_de where tipo = 'inscripcion_nueva' and clave = 'org' limit 1));
  update inscripciones set estado = 'aceptada' where torneo_id = 'tprueba-av';
  insert into resultados (caso, ok) values ('Inscripción aceptada: avisa al jugador con cuenta de ese teléfono',
    exists (select 1 from avisos_de where tipo = 'inscripcion_aceptada' and clave = 'j'));
end $$;

-- Cada uno ve y marca solo los suyos
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'j'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_n int;
begin
  insert into resultados (caso, ok) values ('El jugador ve solo sus avisos', (select bool_and(usuario_id = auth.uid()) from notificaciones));
  update notificaciones set leida_at = now() where leida_at is null;
  get diagnostics v_n = row_count;
  insert into resultados (caso, ok, detalle) values ('Marca sus avisos como leídos', v_n > 0, v_n::text);
  begin
    update notificaciones set titulo = 'otro';
    insert into resultados (caso, ok) values ('No puede cambiar el texto de un aviso', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede cambiar el texto de un aviso', true, sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PRUEBA5' as fin from resultados;
rollback;
