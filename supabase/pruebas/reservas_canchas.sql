-- Pruebas de 20261014_reservas_canchas.sql. Correr SOLO en el proyecto de PRUEBA, después de la
-- migración. Usa el usuario organizador-prueba como dueño de un complejo de prueba. Todo se deshace
-- al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
grant all on resultados to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Dos complejos de prueba del organizador-prueba: uno con Reservas habilitadas y otro sin habilitar
insert into complejos (id, dueno_id, reservas_habilitadas) values
  ('cprueba-reservas', (select id from organizers where username = 'organizador-prueba'), true),
  ('cprueba-off', (select id from organizers where username = 'organizador-prueba'), false);

-- 1) Como el dueño
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.organizers where username = 'organizador-prueba'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  c1 uuid;
  r1 uuid;
  b1 uuid;
  n int;
begin
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_90) values ('cprueba-reservas', 'Cancha 1', '14:00', '22:00', 14000) returning id into c1;
  insert into resultados (caso, ok) values ('Dueño crea una cancha', c1 is not null);

  begin
    insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-off', 'Cancha X', '14:00', '22:00');
    insert into resultados (caso, ok) values ('Complejo sin Reservas habilitadas: no puede crear canchas', false);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('Complejo sin Reservas habilitadas: no puede crear canchas', sqlstate = '42501', sqlerrm);
  end;

  begin
    insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-reservas', 'Cancha Y', '14:15', '22:00');
    insert into resultados (caso, ok) values ('Horario que no es en punto ni y media: rechazado', false);
  exception when check_violation then
    insert into resultados (caso, ok) values ('Horario que no es en punto ni y media: rechazado', true);
  end;

  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-reservas', c1, '2026-10-20', '2026-10-20 14:00-03', '2026-10-20 15:30-03', 'Juan') returning id into r1;
  insert into resultados (caso, ok) values ('Turno 14:00 a 15:30 cargado', r1 is not null);

  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
    values ('cprueba-reservas', c1, '2026-10-20', '2026-10-20 15:00-03', '2026-10-20 16:00-03', 'Pisa');
    insert into resultados (caso, ok) values ('Turno que se pisa (15:00): rechazado', false);
  exception when exclusion_violation then
    insert into resultados (caso, ok) values ('Turno que se pisa (15:00): rechazado', true);
  end;

  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-reservas', c1, '2026-10-20', '2026-10-20 15:30-03', '2026-10-20 17:00-03', 'Pedro');
  insert into resultados (caso, ok) values ('Turno pegado al anterior (15:30): ok', true);

  begin
    insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, nota)
    values ('cprueba-reservas', c1, 'bloqueo', '2026-10-20', '2026-10-20 16:00-03', '2026-10-20 18:00-03', 'lluvia');
    insert into resultados (caso, ok) values ('Bloqueo encima de un turno: rechazado', false);
  exception when exclusion_violation then
    insert into resultados (caso, ok) values ('Bloqueo encima de un turno: rechazado', true);
  end;

  insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, nota)
  values ('cprueba-reservas', c1, 'bloqueo', '2026-10-20', '2026-10-20 17:00-03', '2026-10-20 18:00-03', 'mantenimiento') returning id into b1;
  insert into resultados (caso, ok) values ('Bloqueo en horario libre: ok', b1 is not null);

  update reservas set estado = 'cancelada', cancelada_at = now() where id = r1;
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-reservas', c1, '2026-10-20', '2026-10-20 14:00-03', '2026-10-20 15:00-03', 'Ana');
  insert into resultados (caso, ok) values ('Turno cancelado libera el horario', true);

  delete from reservas where id = r1;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Un turno no se puede borrar (se cancela)', n = 0, n::text);

  delete from reservas where id = b1;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Un bloqueo sí se puede borrar', n = 1, n::text);

  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, telefono)
    values ('cprueba-reservas', c1, '2026-10-21', '2026-10-21 14:00-03', '2026-10-21 15:00-03', 'Tel', '12345');
    insert into resultados (caso, ok) values ('WhatsApp inválido: rechazado', false);
  exception when check_violation then
    insert into resultados (caso, ok) values ('WhatsApp inválido: rechazado', true);
  end;

  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin)
    values ('cprueba-reservas', c1, '2026-10-21', '2026-10-21 14:00-03', '2026-10-21 15:00-03');
    insert into resultados (caso, ok) values ('Turno sin nombre: rechazado', false);
  exception when check_violation then
    insert into resultados (caso, ok) values ('Turno sin nombre: rechazado', true);
  end;

  -- Turno pasada la medianoche (fecha de la grilla 20/10, a la 00:30 del 21)
  insert into canchas (complejo_id, nombre, apertura, cierre, precio_60) values ('cprueba-reservas', 'Cancha noche', '18:00', '01:00', 10000);
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-reservas', (select id from canchas where nombre = 'Cancha noche' and complejo_id = 'cprueba-reservas'), '2026-10-20', '2026-10-21 00:00-03', '2026-10-21 01:00-03', 'Noche');
  insert into resultados (caso, ok) values ('Cancha que cierra pasada la medianoche: turno de 00:00 a 01:00', true);

  begin
    delete from canchas where id = c1;
    insert into resultados (caso, ok) values ('Cancha con reservas: no se puede borrar', false);
  exception when foreign_key_violation then
    insert into resultados (caso, ok) values ('Cancha con reservas: no se puede borrar', true);
  end;

  update complejos set reservas_habilitadas = true where id = 'cprueba-off';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('El dueño no puede habilitarse Reservas solo', n = 0, n::text);

  select count(*) into n from reservas where complejo_id = 'cprueba-reservas';
  insert into resultados (caso, ok, detalle) values ('El dueño ve sus reservas', n = 4, n::text);
end $$;

-- 2) Como otro usuario logueado (no es dueño de nada)
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);

do $$
declare
  n int;
begin
  select count(*) into n from reservas where complejo_id = 'cprueba-reservas';
  insert into resultados (caso, ok, detalle) values ('Otro usuario no ve las reservas', n = 0, n::text);
  begin
    insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-reservas', 'Intrusa', '14:00', '22:00');
    insert into resultados (caso, ok) values ('Otro usuario no puede crear canchas', false);
  exception when others then
    insert into resultados (caso, ok, detalle) values ('Otro usuario no puede crear canchas', sqlstate = '42501', sqlerrm);
  end;
  update canchas set precio_90 = 1 where complejo_id = 'cprueba-reservas';
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Otro usuario no puede cambiar precios', n = 0, n::text);
end $$;

-- 3) Como el público (sin login). El rol anon no tiene acceso a las tablas temporales (ni a la de
-- resultados), así que se cambia a anon solo para cada consulta y se vuelve antes de anotar.
reset role;

do $$
declare
  n int;
begin
  set local role anon;
  select count(*) into n from canchas where complejo_id = 'cprueba-reservas';
  reset role;
  insert into resultados (caso, ok, detalle) values ('El público ve las canchas', n = 2, n::text);
  begin
    set local role anon;
    select count(*) into n from reservas;
    reset role;
    insert into resultados (caso, ok) values ('El público no puede leer las reservas', false);
  exception when insufficient_privilege then
    -- al saltar el error, el rol vuelve solo al que había antes del bloque
    insert into resultados (caso, ok) values ('El público no puede leer las reservas', true);
  end;
end $$;

select n, ok, caso, detalle from resultados order by n;
rollback;
