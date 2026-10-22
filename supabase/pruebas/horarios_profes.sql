-- Pruebas de 20261048_horarios_profes.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (con las funciones prendidas). Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('otro', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', '5493446999901', now(), now(), now() from ids where clave = 'otro';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-horario', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-horario', 'Cancha 1', '00:00', '23:30'), ('cprueba-horario', 'Cancha 2', '00:00', '23:30') returning id, nombre)
insert into ids select case nombre when 'Cancha 1' then 'c1' else 'c2' end, id::text from c;
with p as (insert into profes_complejo (complejo_id, nombre, modo, precio_hora) values ('cprueba-horario', 'Profe Juan', 'alquila', 10000) returning id)
insert into ids select 'profe', id::text from p;
-- El próximo lunes (desde pasado mañana) la Cancha 1 ya tiene un turno de 8 a 9
insert into ids select 'lunes', (_fecha_ar(now()) + 2 + ((8 - extract(dow from _fecha_ar(now()) + 2)::int) % 7))::text;
insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre, precio)
select 'cprueba-horario', (select valor::uuid from ids where clave = 'c1'), d,
  (d + time '08:00') at time zone 'America/Argentina/Buenos_Aires', (d + time '09:00') at time zone 'America/Argentina/Buenos_Aires', 'Ocupado', 10000
from (select valor::date d from ids where clave = 'lunes') x;

create temp view clases as select r.* from reservas r where r.profe_id = (select valor::uuid from ids where clave = 'profe');
grant select on clases to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  v_profe uuid := (select valor::uuid from ids where clave = 'profe');
  c1 uuid := (select valor::uuid from ids where clave = 'c1');
  c2 uuid := (select valor::uuid from ids where clave = 'c2');
  v_lunes date := (select valor::date from ids where clave = 'lunes');
  x jsonb; h uuid; v_esperadas int; v_cancelada uuid;
begin
  x := crear_horario_profe(v_profe, c1, array[1, 3, 5], 7 * 60, 12 * 60, _fecha_ar(now()) + 1);
  h := (x->>'id')::uuid;
  insert into ids values ('horario', h::text);
  select count(*) into v_esperadas from generate_series(_fecha_ar(now()) + 1, _fecha_ar(now()) + 56, interval '1 day') g where extract(dow from g) in (1, 3, 5);
  insert into resultados (caso, ok, detalle) values ('Crear L-X-V de 7 a 12: reserva 8 semanas menos el lunes ocupado',
    (x->>'creadas')::int = v_esperadas - 1 and x->'ocupadas' = to_jsonb(array[v_lunes]), x::text || ' esperadas ' || v_esperadas);
  insert into resultados (caso, ok) values ('Cada clase es un bloque de 5 horas que vale 5 horas de alquiler',
    (select bool_and(fin - inicio = interval '5 hours' and precio = 50000 and tipo = 'clase' and to_char(inicio at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') = '07:00') from clases where horario_id = h));
  insert into resultados (caso, ok) values ('Al dueño le llega el aviso del lunes ocupado',
    exists (select 1 from notificaciones where usuario_id = auth.uid() and tipo = 'clase_no_reservada' and ref = h::text || ':' || v_lunes::text));

  perform generar_horarios();
  insert into resultados (caso, ok) values ('La tarea de cada mañana no duplica', (select count(*) from clases where horario_id = h) = v_esperadas - 1);

  -- El profe se enferma: se cancela una clase y queda libre (no se vuelve a reservar)
  select id into v_cancelada from clases where horario_id = h and estado = 'confirmada' order by fecha limit 1;
  update reservas set estado = 'cancelada', cancelada_at = now(), cancelada_por = 'complejo' where id = v_cancelada;
  perform generar_horarios();
  insert into resultados (caso, ok) values ('Clase cancelada en la agenda: no se vuelve a reservar',
    (select count(*) from clases where horario_id = h and estado = 'confirmada') = v_esperadas - 2);

  -- Cambiar a martes y jueves de 8 a 10 en la Cancha 2
  x := cambiar_horario_profe(h, c2, array[2, 4], 8 * 60, 10 * 60, _fecha_ar(now()) + 1);
  insert into resultados (caso, ok, detalle) values ('Cambiar el horario: las que vienen pasan a Ma-Ju 8 a 10 en la Cancha 2',
    (select bool_and(extract(dow from fecha) in (2, 4) and cancha_id = c2 and fin - inicio = interval '2 hours' and precio = 20000) from clases where horario_id = h and estado = 'confirmada')
    and (select count(*) from clases where horario_id = h and estado = 'confirmada') > 0,
    (select count(*)::text from clases where horario_id = h and estado = 'confirmada'));

  perform terminar_horario_profe(h, _fecha_ar(now()) + 15);
  perform generar_horarios();
  insert into resultados (caso, ok) values ('Terminar: desde esa fecha no quedan clases',
    not exists (select 1 from clases where horario_id = h and estado = 'confirmada' and fecha >= _fecha_ar(now()) + 15)
    and exists (select 1 from clases where horario_id = h and estado = 'confirmada' and fecha < _fecha_ar(now()) + 15));
end $$;

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'otro'), 'role', 'authenticated')::text, true);
do $$
begin
  perform crear_horario_profe((select valor::uuid from ids where clave = 'profe'), (select valor::uuid from ids where clave = 'c1'), array[1], 600, 660);
  insert into resultados (caso, ok) values ('Sin permiso no crea horarios', false);
exception when others then insert into resultados (caso, ok, detalle) values ('Sin permiso no crea horarios', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_HORARIOS' as fin from resultados;
rollback;
