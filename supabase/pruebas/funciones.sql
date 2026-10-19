-- Pruebas de 20261037_funciones.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador): un complejo del organizador de prueba con una cancha y un empleado,
-- y las tres funciones apagadas
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into ids values ('creador', (select id::text from organizers where role = 'creador' limit 1));
insert into ids values ('hoy', (now() at time zone 'America/Argentina/Buenos_Aires')::date::text);
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-func', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-func', 'Cancha 1', '08:00', '23:00') returning id)
insert into ids select 'cancha', id::text from c;
insert into colaboradores (complejo_id, email, p_agenda) select 'cprueba-func', lower(email), true from auth.users where id = (select valor::uuid from ids where clave = 'creador');
update funciones set activa = false;

-- 1) Todo apagado: el dueño no carga nada
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_dia date := (select valor::date from ids where clave = 'hoy') + 2;
begin
  insert into resultados (caso, ok, detalle) values ('Anónimo/usuario ve las funciones', (select count(*) from funciones) = 3, null);
  insert into resultados (caso, ok) values ('funcion_activa(reservas) = false', not funcion_activa('reservas'));
  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
    values ('cprueba-func', v_cancha, v_dia, v_dia + time '18:00', v_dia + time '19:00', 'Juan');
    insert into resultados (caso, ok) values ('Reservas apagada: no carga turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Reservas apagada: no carga turnos', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    perform pedir_turno(v_cancha, v_dia, 20 * 60, 60);
    insert into resultados (caso, ok) values ('Reservas apagada: no se piden turnos online', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Reservas apagada: no se piden turnos online', sqlerrm <> 'ok', sqlerrm); end;
  begin
    insert into cuentas (complejo_id, nombre) values ('cprueba-func', 'Pedro');
    insert into resultados (caso, ok) values ('Cantina apagada: no crea cuentas', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cantina apagada: no crea cuentas', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    insert into productos (complejo_id, nombre, precio) values ('cprueba-func', 'Agua', 1000);
    insert into resultados (caso, ok) values ('Cantina apagada: no carga productos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cantina apagada: no carga productos', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    perform abrir_caja('cprueba-func', 0);
    insert into resultados (caso, ok) values ('Cantina apagada: no abre caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cantina apagada: no abre caja', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    insert into caja_movimientos (fecha, tipo, concepto, monto, medio) values (current_date, 'gasto', 'Luz', 1000, 'efectivo');
    insert into resultados (caso, ok) values ('Cantina apagada: no carga movimientos de caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cantina apagada: no carga movimientos de caja', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    insert into colaboradores (complejo_id, email) values ('cprueba-func', 'otro@prueba.test');
    insert into resultados (caso, ok) values ('Cuentas apagada: no agrega empleados', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Cuentas apagada: no agrega empleados', sqlerrm = 'funcion_apagada', sqlerrm); end;
  begin
    update funciones set activa = true where clave = 'reservas';
    insert into resultados (caso, ok, detalle) values ('Un organizador no prende funciones', not funcion_activa('reservas'), null);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un organizador no prende funciones', true, sqlerrm); end;
end $$;

-- 2) El empleado (la cuenta del creador cargada como empleado) no tiene permisos con Cuentas apagada
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok) values ('Cuentas apagada: el empleado no ve el complejo', not exists (select 1 from mis_complejos_colaborador() where complejo_id = 'cprueba-func'));
  insert into resultados (caso, ok) values ('Cuentas apagada: el empleado no tiene permiso de agenda', not colaborador_permiso('cprueba-func', 'agenda'));
  -- 3) El creador prende las tres
  update funciones set activa = true;
  insert into resultados (caso, ok, detalle) values ('El creador prende las funciones', (select bool_and(activa) from funciones), null);
  insert into resultados (caso, ok, detalle) values ('Queda quién la prendió', (select bool_and(cambiada_por = auth.uid()) from funciones), null);
  insert into resultados (caso, ok) values ('Cuentas prendida: el empleado ve el complejo', exists (select 1 from mis_complejos_colaborador() where complejo_id = 'cprueba-func'));
end $$;

-- 4) Prendidas: el dueño carga normalmente
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_dia date := (select valor::date from ids where clave = 'hoy') + 2;
begin
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-func', v_cancha, v_dia, v_dia + time '18:00', v_dia + time '19:00', 'Juan');
  insert into resultados (caso, ok) values ('Reservas prendida: carga turnos', true);
  insert into cuentas (complejo_id, nombre) values ('cprueba-func', 'Pedro');
  insert into resultados (caso, ok) values ('Cantina prendida: crea cuentas', true);
  perform abrir_caja('cprueba-func', 0);
  insert into resultados (caso, ok) values ('Cantina prendida: abre caja', true);
exception when others then insert into resultados (caso, ok, detalle) values ('Prendidas: el dueño carga normalmente', false, sqlerrm);
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan from resultados;
rollback;
