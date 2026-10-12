-- Pruebas de 20261028_clases.sql. Correr SOLO en el proyecto de PRUEBA. Todo se deshace al final.
-- Resultado: resumen con todo_ok = true.
begin;
create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000e1', 'emp-clases@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-clases', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-clases', 'emp-clases@prueba.test', true, false);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-clases', 'Cancha 1', '08:00', '23:00') returning id)
insert into ids select 'cancha', id::text from c;

-- 1) El dueño carga dos profes y una clase
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v uuid;
begin
  insert into profes_complejo (complejo_id, nombre, modo, precio_hora) values ('cprueba-clases', 'Profe Alquila', 'alquila', 12000) returning id into v;
  insert into ids values ('pa', v::text);
  insert into profes_complejo (complejo_id, nombre, modo, pago_clase) values ('cprueba-clases', 'Profe Complejo', 'complejo', 8000) returning id into v;
  insert into ids values ('pc', v::text);
  insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre, precio, profe_id)
  values ('cprueba-clases', (select valor::uuid from ids where clave = 'cancha'), 'clase', '2030-01-10', '2030-01-10 10:00-03', '2030-01-10 11:00-03', 'confirmada', 'Clase · Profe Alquila', 12000, (select valor::uuid from ids where clave = 'pa'))
  returning id into v;
  insert into ids values ('clase', v::text);
  insert into resultados (caso, ok) values ('Carga una clase en la agenda', true);
  begin
    insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre)
    values ('cprueba-clases', (select valor::uuid from ids where clave = 'cancha'), 'turno', '2030-01-10', '2030-01-10 10:30-03', '2030-01-10 11:30-03', 'confirmada', 'Pisa la clase');
    insert into resultados (caso, ok) values ('Un turno no puede pisar la clase', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un turno no puede pisar la clase', sqlstate = '23P01', sqlerrm); end;
  begin
    insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre)
    values ('cprueba-clases', (select valor::uuid from ids where clave = 'cancha'), 'otro', '2030-01-11', '2030-01-11 10:00-03', '2030-01-11 11:00-03', 'confirmada', 'x');
    insert into resultados (caso, ok) values ('Tipo desconocido: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Tipo desconocido: rechazado', sqlstate = '23514', sqlerrm); end;
  insert into alumnos (complejo_id, profe_id, nombre, cuota) values ('cprueba-clases', (select valor::uuid from ids where clave = 'pc'), 'Alumna Uno', 30000) returning id into v;
  insert into ids values ('alumno', v::text);
  insert into pagos_profes (complejo_id, profe_id, periodo, monto, medio) values ('cprueba-clases', (select valor::uuid from ids where clave = 'pc'), '2030-01', 16000, 'transferencia');
  insert into resultados (caso, ok) values ('El dueño le paga al profe', true);
end $$;

-- 2) El empleado de agenda: abre su caja, cobra la clase alquilada y una cuota
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v uuid;
  r jsonb;
begin
  v := abrir_caja('cprueba-clases', 0);
  insert into ids values ('caja', v::text);
  update reservas set medio_pago = 'efectivo' where id = (select valor::uuid from ids where clave = 'clase');
  insert into resultados (caso, ok) values ('La clase cobrada queda a nombre del empleado',
    (select cobrado_por from reservas where id = (select valor::uuid from ids where clave = 'clase')) = '00000000-0000-4000-8000-0000000000e1');
  insert into cuotas_alumnos (complejo_id, alumno_id, periodo, monto, medio) values ('cprueba-clases', (select valor::uuid from ids where clave = 'alumno'), '2030-01', 30000, 'efectivo');
  insert into resultados (caso, ok) values ('Cobra la cuota de enero',
    (select cobrado_por_email from cuotas_alumnos where alumno_id = (select valor::uuid from ids where clave = 'alumno')) = 'emp-clases@prueba.test');
  begin
    insert into cuotas_alumnos (complejo_id, alumno_id, periodo, monto, medio) values ('cprueba-clases', (select valor::uuid from ids where clave = 'alumno'), '2030-01', 30000, 'efectivo');
    insert into resultados (caso, ok) values ('No se cobra dos veces el mismo mes', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se cobra dos veces el mismo mes', sqlstate = '23505', sqlerrm); end;
  r := resumen_caja(v);
  insert into resultados (caso, ok, detalle) values ('Su caja suma clase 12.000 y cuota 30.000', (r->>'efectivo_esperado')::numeric = 42000 and (r->'por_origen'->>'clases')::numeric = 30000, r::text);
  insert into resultados (caso, ok) values ('El empleado ve los profes', (select count(*) from profes_complejo where complejo_id = 'cprueba-clases') = 2);
  insert into resultados (caso, ok) values ('El empleado no ve los pagos a profes', not exists (select 1 from pagos_profes where complejo_id = 'cprueba-clases'));
  begin
    insert into profes_complejo (complejo_id, nombre, modo) values ('cprueba-clases', 'X', 'alquila');
    insert into resultados (caso, ok) values ('El empleado no carga profes', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no carga profes', sqlstate = '42501', sqlerrm); end;
  begin
    insert into pagos_profes (complejo_id, profe_id, periodo, monto, medio) values ('cprueba-clases', (select valor::uuid from ids where clave = 'pc'), '2030-02', 1, 'efectivo');
    insert into resultados (caso, ok) values ('El empleado no le paga al profe', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no le paga al profe', sqlstate = '42501', sqlerrm); end;
end $$;

-- 3) Alguien sin permiso no ve alumnos ni cobra cuotas
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
do $$
begin
  insert into resultados (caso, ok) values ('Sin permiso no ve alumnos', not exists (select 1 from alumnos where complejo_id = 'cprueba-clases'));
  begin
    insert into cuotas_alumnos (complejo_id, alumno_id, periodo, monto, medio) values ('cprueba-clases', (select valor::uuid from ids where clave = 'alumno'), '2030-02', 1, 'efectivo');
    insert into resultados (caso, ok) values ('Sin permiso no cobra cuotas', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin permiso no cobra cuotas', sqlstate = '42501', sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
