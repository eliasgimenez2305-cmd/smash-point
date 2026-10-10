-- Pruebas de 20261015_reservas_jugadores.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración. Crea dos jugadores de mentira y un complejo de prueba del organizador-prueba. Todo se
-- deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (como administrador de la base)
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'jugador1@prueba.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'jugador2@prueba.test');
insert into complejos (id, dueno_id, reservas_habilitadas)
values ('cprueba-j', (select id from organizers where username = 'organizador-prueba'), true);
with c as (
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_90, reserva_online)
  values ('cprueba-j', 'Cancha online', '14:00', '22:00', 14000, true) returning id
) insert into ids select 'online', id::text from c;
with c as (
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_90, reserva_online)
  values ('cprueba-j', 'Cancha clases', '09:00', '17:00', 10000, false) returning id
) insert into ids select 'clases', id::text from c;
insert into ids values ('hoy', ((now() at time zone 'America/Argentina/Buenos_Aires')::date)::text);

-- 1) Jugador 1
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_online uuid := (select valor::uuid from ids where clave = 'online');
  v_clases uuid := (select valor::uuid from ids where clave = 'clases');
  v_hoy date := (select valor::date from ids where clave = 'hoy');
  v_id uuid;
  r reservas%rowtype;
  n int;
begin
  -- Sin perfil no puede pedir
  begin
    perform pedir_turno(v_online, v_hoy + 2, 18 * 60, 90);
    insert into resultados (caso, ok) values ('Sin perfil: no puede pedir', false);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('Sin perfil: no puede pedir', sqlerrm = 'sin_perfil', sqlerrm);
  end;

  insert into jugadores (id, nombre, apellido, telefono) values (auth.uid(), 'Juan', 'Prueba', '5493446111111');
  insert into resultados (caso, ok) values ('Jugador crea su perfil', true);

  begin
    insert into jugadores (id, nombre, apellido, telefono) values ('00000000-0000-4000-8000-0000000000a2', 'Otro', 'Ajeno', '5493446222222');
    insert into resultados (caso, ok) values ('No puede crear el perfil de otro', false);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('No puede crear el perfil de otro', sqlstate = '42501', sqlerrm);
  end;

  v_id := pedir_turno(v_online, v_hoy + 2, 18 * 60, 90);
  select * into r from reservas where id = v_id;
  insert into ids values ('r1', v_id::text);
  insert into resultados (caso, ok, detalle) values ('Pide turno: queda pendiente, online, con su nombre, precio y vencimiento a las 24 h',
    r.estado = 'pendiente' and r.origen = 'online' and r.nombre = 'Juan Prueba' and r.precio = 14000 and r.jugador_id = auth.uid()
    and r.vence_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
    and r.inicio = ((v_hoy + 2)::timestamp + interval '18 hours') at time zone 'America/Argentina/Buenos_Aires', r.estado || ' ' || r.vence_at);

  -- Errores del pedido
  begin perform pedir_turno(v_online, v_hoy - 1, 18 * 60, 90); insert into resultados (caso, ok) values ('Horario pasado: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Horario pasado: rechazado', sqlerrm = 'horario_pasado', sqlerrm); end;
  begin perform pedir_turno(v_online, v_hoy + 2, 16 * 60, 60); insert into resultados (caso, ok) values ('Duración sin precio: rechazada', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Duración sin precio: rechazada', sqlerrm = 'duracion_invalida', sqlerrm); end;
  begin perform pedir_turno(v_clases, v_hoy + 2, 10 * 60, 90); insert into resultados (caso, ok) values ('Cancha sin reserva online: rechazada', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cancha sin reserva online: rechazada', sqlerrm = 'cancha_invalida', sqlerrm); end;
  begin perform pedir_turno(v_online, v_hoy + 2, 18 * 60 + 15, 90); insert into resultados (caso, ok) values ('18:15: fuera de la grilla', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('18:15: fuera de la grilla', sqlerrm = 'fuera_de_horario', sqlerrm); end;
  begin perform pedir_turno(v_online, v_hoy + 2, 21 * 60, 90); insert into resultados (caso, ok) values ('21:00 + 90 min pasa el cierre: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('21:00 + 90 min pasa el cierre: rechazado', sqlerrm = 'fuera_de_horario', sqlerrm); end;
  begin perform pedir_turno(v_online, v_hoy + 40, 18 * 60, 90); insert into resultados (caso, ok) values ('A 40 días: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('A 40 días: rechazado', sqlerrm = 'muy_adelante', sqlerrm); end;

  -- No puede tocar la reserva directo (solo por las funciones)
  update reservas set estado = 'confirmada' where id = v_id;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('No puede confirmarse su propio turno', n = 0, n::text);

  -- Un turno que pidió hace un rato y es en 2 días: se cancela avisando al complejo
  v_id := pedir_turno(v_online, v_hoy + 3, 15 * 60, 90);
  insert into ids values ('r2', v_id::text);

  -- Seguridad: un jugador no puede crear torneos, eventos ni portadas
  begin perform guardar_torneo(jsonb_build_object('id', 'tjug', 'name', 'X', 'organizerId', auth.uid()::text, 'categories', '[]'::jsonb), 0, null);
    insert into resultados (caso, ok) values ('Jugador no puede crear torneos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Jugador no puede crear torneos', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin perform guardar_en_lista('sp:events', jsonb_build_object('id', 'ejug', 'name', 'X', 'organizerId', auth.uid()::text));
    insert into resultados (caso, ok) values ('Jugador no puede crear eventos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Jugador no puede crear eventos', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin perform guardar_portada(auth.uid(), 'x');
    insert into resultados (caso, ok) values ('Jugador no puede guardar portada', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Jugador no puede guardar portada', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 2) Jugador 2
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);

do $$
declare
  v_online uuid := (select valor::uuid from ids where clave = 'online');
  v_hoy date := (select valor::date from ids where clave = 'hoy');
  n int;
begin
  insert into jugadores (id, nombre, apellido, telefono) values (auth.uid(), 'Ana', 'Prueba', '5493446222222');
  begin perform pedir_turno(v_online, v_hoy + 2, 18 * 60 + 30, 90); insert into resultados (caso, ok) values ('Turno pisado con un pedido pendiente: ocupado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Turno pisado con un pedido pendiente: ocupado', sqlerrm = 'ocupado', sqlerrm); end;
  select count(*) into n from reservas where complejo_id = 'cprueba-j';
  insert into resultados (caso, ok, detalle) values ('No ve los turnos de otros jugadores', n = 0, n::text);
  begin perform cancelar_mi_reserva((select valor::uuid from ids where clave = 'r1')); insert into resultados (caso, ok) values ('No puede cancelar el turno de otro', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede cancelar el turno de otro', sqlerrm = 'no_encontrada', sqlerrm); end;
end $$;

-- 3) Como administrador: preparar los casos de plazos, vencimiento y bloqueo
reset role;
update reservas set created_at = now() - interval '1 hour' where id = (select valor::uuid from ids where clave = 'r2');
insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id, created_at, vence_at)
select 'cprueba-j', valor::uuid, (now() at time zone 'America/Argentina/Buenos_Aires')::date, now() + interval '5 hours', now() + interval '6 hours 30 minutes',
       'confirmada', 'online', 'Juan Prueba', '00000000-0000-4000-8000-0000000000a1', now() - interval '1 hour', null
from ids where clave = 'online';
insert into ids select 'r3', id::text from reservas where jugador_id = '00000000-0000-4000-8000-0000000000a1' and inicio < now() + interval '6 hours' and estado = 'confirmada';
-- Un pedido pendiente que ya venció (otra cancha del mismo horario no hay: se usa otro día)
insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, estado, origen, nombre, jugador_id, vence_at)
select 'cprueba-j', valor::uuid, (now() at time zone 'America/Argentina/Buenos_Aires')::date + 5,
       ((((now() at time zone 'America/Argentina/Buenos_Aires')::date + 5)::timestamp + interval '14 hours') at time zone 'America/Argentina/Buenos_Aires'),
       ((((now() at time zone 'America/Argentina/Buenos_Aires')::date + 5)::timestamp + interval '15 hours 30 minutes') at time zone 'America/Argentina/Buenos_Aires'),
       'pendiente', 'online', 'Ana Prueba', '00000000-0000-4000-8000-0000000000a2', now() - interval '1 minute'
from ids where clave = 'online';
insert into jugadores_bloqueados (complejo_id, jugador_id) values ('cprueba-j', '00000000-0000-4000-8000-0000000000a2');

-- 4) Jugador 1: cancelaciones
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  t text;
  n int;
begin
  t := cancelar_mi_reserva((select valor::uuid from ids where clave = 'r1'));
  insert into resultados (caso, ok, detalle) values ('Cancela dentro de los 30 min: sin aviso al complejo', t = 'silenciosa', t);
  t := cancelar_mi_reserva((select valor::uuid from ids where clave = 'r2'));
  insert into resultados (caso, ok, detalle) values ('Cancela después de 30 min y a más de 24 h: con aviso', t = 'avisada', t);
  begin perform cancelar_mi_reserva((select valor::uuid from ids where clave = 'r3')); insert into resultados (caso, ok) values ('A menos de 24 h (pedido hace 1 h): no puede cancelar', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('A menos de 24 h (pedido hace 1 h): no puede cancelar', sqlerrm = 'fuera_de_plazo', sqlerrm); end;
  select count(*) into n from reservas where jugador_id = auth.uid();
  insert into resultados (caso, ok, detalle) values ('El jugador ve sus turnos', n = 3, n::text);
  select count(*) into n from reservas where estado = 'cancelada' and cancelada_por = 'jugador' and jugador_id = auth.uid();
  insert into resultados (caso, ok, detalle) values ('Quedan como canceladas por el jugador', n = 2, n::text);
end $$;

-- 5) Jugador 2 bloqueado
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);

do $$
begin
  perform pedir_turno((select valor::uuid from ids where clave = 'online'), (select valor::date from ids where clave = 'hoy') + 4, 18 * 60, 90);
  insert into resultados (caso, ok) values ('Jugador bloqueado por el complejo: no puede pedir', false);
exception when others then
  insert into resultados (caso, ok, detalle) values ('Jugador bloqueado por el complejo: no puede pedir', sqlerrm = 'bloqueado', sqlerrm);
end $$;

-- 6) Dueño del complejo
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.organizers where username = 'organizador-prueba'), 'role', 'authenticated')::text, true);

do $$
declare
  n int;
begin
  select count(*) into n from reservas where complejo_id = 'cprueba-j' and origen = 'online';
  insert into resultados (caso, ok, detalle) values ('El dueño ve los pedidos online', n >= 4, n::text);
  perform guardar_torneo(jsonb_build_object('id', 'torg-prueba', 'name', 'X', 'organizerId', auth.uid()::text, 'categories', '[]'::jsonb), 0, null);
  insert into resultados (caso, ok) values ('El organizador sigue pudiendo crear torneos', exists (select 1 from torneos where id = 'torg-prueba'));
  delete from jugadores_bloqueados where complejo_id = 'cprueba-j';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El dueño puede desbloquear', n = 1, n::text);
  select count(*) into n from jugadores;
  insert into resultados (caso, ok, detalle) values ('El dueño no ve la tabla de jugadores', n = 0, n::text);
end $$;

-- 7) Público (sin login): disponibilidad sin datos, y el pedido vencido ya no ocupa
reset role;

do $$
declare
  n int;
  v_fecha date := (now() at time zone 'America/Argentina/Buenos_Aires')::date + 5;
begin
  set local role anon;
  select count(*) into n from disponibilidad_canchas('cprueba-j', v_fecha);
  reset role;
  insert into resultados (caso, ok, detalle) values ('Pedido vencido: ya no ocupa el horario', n = 0, n::text);
  insert into resultados (caso, ok) values ('Y queda marcado como vencido', exists (select 1 from reservas where complejo_id = 'cprueba-j' and estado = 'vencida'));

  set local role anon;
  select count(*) into n from disponibilidad_canchas('cprueba-j', (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  reset role;
  insert into resultados (caso, ok, detalle) values ('El público ve los horarios ocupados de hoy', n = 1, n::text);

  begin
    set local role anon;
    perform pedir_turno((select valor::uuid from ids where clave = 'online'), v_fecha, 18 * 60, 90);
    reset role;
    insert into resultados (caso, ok) values ('Sin login no se puede pedir turno', false);
  exception when insufficient_privilege then
    insert into resultados (caso, ok) values ('Sin login no se puede pedir turno', true);
  end;
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
