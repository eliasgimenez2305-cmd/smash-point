-- Pruebas de 20261047_editar_turnos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')),
  ('emp', gen_random_uuid()::text), ('jug', gen_random_uuid()::text), ('otro', gen_random_uuid()::text), ('serie', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', tel, now(), now(), now()
from (values ('emp', '5493446999801'), ('jug', '5493446999802'), ('otro', '5493446999803')) v(clave, tel) join ids using (clave);
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-editar', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-editar', 'Cancha 1', '00:00', '23:30'), ('cprueba-editar', 'Cancha 2', '00:00', '23:30') returning id, nombre)
insert into ids select case nombre when 'Cancha 1' then 'c1' else 'c2' end, id::text from c;
insert into colaboradores (complejo_id, telefono, p_agenda) values ('cprueba-editar', '5493446999801', true);

-- Turno fijo de 3 semanas a las 20, un turno pedido por el jugador y otro turno a las 22 del primer día
do $$
declare
  c1 uuid := (select valor::uuid from ids where clave = 'c1');
  s uuid := (select valor::uuid from ids where clave = 'serie');
  d date := current_date + 2;
  i int;
  r uuid;
begin
  for i in 0..2 loop
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, serie_id)
    values ('cprueba-editar', c1, d + 7 * i, (((d + 7 * i) + time '20:00') at time zone 'America/Argentina/Buenos_Aires'), (((d + 7 * i) + time '21:00') at time zone 'America/Argentina/Buenos_Aires'), 'Fijo', 10000, s) returning id into r;
    insert into ids values ('fijo' || i, r::text);
  end loop;
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio, estado, origen, jugador_id)
  values ('cprueba-editar', c1, d, ((d + time '18:00') at time zone 'America/Argentina/Buenos_Aires'), ((d + time '19:00') at time zone 'America/Argentina/Buenos_Aires'), 'Jugador', 10000, 'confirmada', 'online', (select valor::uuid from ids where clave = 'jug')) returning id into r;
  insert into ids values ('online', r::text);
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio)
  values ('cprueba-editar', c1, d, ((d + time '22:00') at time zone 'America/Argentina/Buenos_Aires'), ((d + time '23:00') at time zone 'America/Argentina/Buenos_Aires'), 'Otro', 10000) returning id into r;
  insert into ids values ('otro22', r::text);
end $$;

create temp view t as select r.*, i.clave from reservas r join ids i on i.valor = r.id::text;
grant select on t to authenticated;

-- Como el dueño
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  c1 uuid := (select valor::uuid from ids where clave = 'c1');
  c2 uuid := (select valor::uuid from ids where clave = 'c2');
  d date := current_date + 2;
  n int;
begin
  n := editar_turno((select valor::uuid from ids where clave = 'fijo0'), d, c1, 19 * 60, 60, 'Fijo', null, 10000, null, false);
  insert into resultados (caso, ok, detalle) values ('Solo este: cambia la hora de uno solo',
    n = 1 and (select to_char(inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') from t where clave = 'fijo0') = '19:00'
    and (select to_char(inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') from t where clave = 'fijo1') = '20:00', n::text);

  n := editar_turno((select valor::uuid from ids where clave = 'fijo1'), d + 7, c2, 21 * 60, 90, 'Fijo Perez', '5493446123456', 12000, 'Trae pelotas', true);
  insert into resultados (caso, ok, detalle) values ('Este y los que siguen: cambian cancha, hora, duración y datos de los dos últimos',
    n = 2 and (select bool_and(cancha_id = c2 and to_char(inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') = '21:00' and fin - inicio = interval '90 minutes'
      and nombre = 'Fijo Perez' and precio = 12000 and nota = 'Trae pelotas') from t where clave in ('fijo1', 'fijo2'))
    and (select cancha_id = c1 from t where clave = 'fijo0'), n::text);

  n := editar_turno((select valor::uuid from ids where clave = 'fijo1'), d + 14, c2, 21 * 60, 90, 'Fijo Perez', '5493446123456', 12000, null, true);
  insert into resultados (caso, ok, detalle) values ('Correr la serie una semana para adelante (sin pisarse entre ellos)',
    n = 2 and (select fecha from t where clave = 'fijo1') = d + 14 and (select fecha from t where clave = 'fijo2') = d + 21, n::text);

  begin
    perform editar_turno((select valor::uuid from ids where clave = 'online'), d, c1, 22 * 60 + 30, 60, 'Jugador', null, 10000, null, false);
    insert into resultados (caso, ok) values ('No deja pisar otro turno', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No deja pisar otro turno (y no cambia nada)',
    sqlstate = '23P01' and (select to_char(inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') from t where clave = 'online') = '18:00', sqlerrm); end;

  perform editar_turno((select valor::uuid from ids where clave = 'online'), d, c2, 17 * 60, 60, 'Jugador', null, 10000, null, false);
  insert into resultados (caso, ok, detalle) values ('Turno pedido por la app: al jugador le llega "Te cambiaron el turno"',
    exists (select 1 from notificaciones where usuario_id = (select valor::uuid from ids where clave = 'jug') and tipo = 'turno_cambiado' and texto like '%17:00%'),
    (select string_agg(texto, ' | ') from notificaciones where usuario_id = (select valor::uuid from ids where clave = 'jug')));

  -- Turno cobrado: el dueño le cambia el precio y la Caja se corrige
  update reservas set medio_pago = 'efectivo' where id = (select valor::uuid from ids where clave = 'otro22');
  perform editar_turno((select valor::uuid from ids where clave = 'otro22'), d, c1, 22 * 60, 60, 'Otro', null, 15000, null, false);
  insert into resultados (caso, ok) values ('El dueño cambia el precio de un turno cobrado y la Caja se corrige',
    (select monto from movimientos where ref_tipo = 'turno' and ref_pago_id = (select valor::uuid from ids where clave = 'otro22') and anulado_at is null) = 1500000);
end $$;

-- Como el empleado con agenda
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'emp'), 'role', 'authenticated')::text, true);
do $$
declare c1 uuid := (select valor::uuid from ids where clave = 'c1'); d date := current_date + 2;
begin
  perform editar_turno((select valor::uuid from ids where clave = 'otro22'), d, c1, 21 * 60 + 30, 60, 'Otro Gomez', null, 15000, null, false);
  insert into resultados (caso, ok) values ('El empleado con agenda cambia la hora y el nombre de un turno cobrado',
    (select nombre from t where clave = 'otro22') = 'Otro Gomez');
  begin
    perform editar_turno((select valor::uuid from ids where clave = 'otro22'), d, c1, 21 * 60 + 30, 60, 'Otro Gomez', null, 1, null, false);
    insert into resultados (caso, ok) values ('El empleado no cambia el precio de un turno cobrado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no cambia el precio de un turno cobrado', sqlerrm = 'turno_cobrado', sqlerrm); end;
end $$;

-- Otra cuenta sin permiso
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'otro'), 'role', 'authenticated')::text, true);
do $$
declare c1 uuid := (select valor::uuid from ids where clave = 'c1'); d date := current_date + 2;
begin
  perform editar_turno((select valor::uuid from ids where clave = 'otro22'), d, c1, 20 * 60, 60, 'X', null, 1, null, false);
  insert into resultados (caso, ok) values ('Sin permiso no edita', false);
exception when others then insert into resultados (caso, ok, detalle) values ('Sin permiso no edita', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_EDITAR' as fin from resultados;
rollback;
