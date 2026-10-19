-- Pruebas de 20261034_planes_en_la_app.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador): un complejo del organizador de prueba con una cancha, y clientes de la
-- plataforma: el complejo con plan de 1 empleado, vencido hace 30 días; el organizador, al día
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into ids values ('hoy', (now() at time zone 'America/Argentina/Buenos_Aires')::date::text);
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-plan', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-plan', 'Cancha 1', '08:00', '23:00') returning id)
insert into ids select 'cancha', id::text from c;
with p as (insert into plataforma_planes (nombre, para, precio, modulo_reservas, empleados) values ('Plan chico', 'complejo', 1000, true, 1) returning id)
insert into ids select 'plan', id::text from p;
with c as (
  insert into plataforma_clientes (tipo, ref_id, nombre, plan_id, modo, vence, dias_gracia)
  select 'complejo', 'cprueba-plan', 'Complejo de prueba', (select valor::uuid from ids where clave = 'plan'), 'prueba', (select valor::date from ids where clave = 'hoy') - 30, 7
  returning id)
insert into ids select 'cli_complejo', id::text from c;
with c as (
  insert into plataforma_clientes (tipo, ref_id, nombre, modo, vence)
  select 'organizador', valor, 'Organizador de prueba', 'bonificado', null from ids where clave = 'org'
  returning id)
insert into ids select 'cli_org', id::text from c;
insert into colaboradores (complejo_id, email) values ('cprueba-plan', 'uno@prueba.test');

-- 1) El dueño del complejo vencido
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  r record;
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_dia date := (select valor::date from ids where clave = 'hoy') + 2;
begin
  select * into r from mi_plan() x where x.ref_id = 'cprueba-plan';
  insert into resultados (caso, ok, detalle) values ('mi_plan: el dueño ve su complejo vencido', r.estado = 'vencido' and r.plan_nombre = 'Plan chico', r.estado || ' / ' || coalesce(r.plan_nombre, '-'));
  select * into r from mi_plan() x where x.tipo = 'organizador';
  insert into resultados (caso, ok, detalle) values ('mi_plan: y su cuenta de organizador bonificada', r.estado = 'bonificado', r.estado);
  begin
    insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
    values ('cprueba-plan', v_cancha, v_dia, v_dia + time '18:00', v_dia + time '19:00', 'Juan');
    insert into resultados (caso, ok) values ('Complejo vencido: no carga turnos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Complejo vencido: no carga turnos', sqlerrm = 'plan_vencido', sqlerrm); end;
  begin
    insert into cuentas (complejo_id, nombre) values ('cprueba-plan', 'Pedro');
    insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
    select 'cprueba-plan', id, 'Agua', 1, 1000 from cuentas where complejo_id = 'cprueba-plan';
    insert into resultados (caso, ok) values ('Complejo vencido: no anota consumos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Complejo vencido: no anota consumos', sqlerrm = 'plan_vencido', sqlerrm); end;
  begin
    perform abrir_caja('cprueba-plan', 0);
    insert into resultados (caso, ok) values ('Complejo vencido: no abre caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Complejo vencido: no abre caja', sqlerrm = 'plan_vencido', sqlerrm); end;
  insert into resultados (caso, ok, detalle) values ('Complejo vencido: sí ve sus canchas', (select count(*) from canchas where complejo_id = 'cprueba-plan') = 1, null);
  begin
    insert into colaboradores (complejo_id, email) values ('cprueba-plan', 'dos@prueba.test');
    insert into resultados (caso, ok) values ('Plan de 1 empleado: no agrega un segundo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Plan de 1 empleado: no agrega un segundo', sqlerrm = 'tope_empleados', sqlerrm); end;
end $$;

-- 2) En los días de gracia todavía se puede trabajar
reset role;
update plataforma_clientes set vence = (select valor::date from ids where clave = 'hoy') - 3 where id = (select valor::uuid from ids where clave = 'cli_complejo');
set local role authenticated;
do $$
declare
  v_cancha uuid := (select valor::uuid from ids where clave = 'cancha');
  v_dia date := (select valor::date from ids where clave = 'hoy') + 2;
begin
  insert into resultados (caso, ok, detalle) values ('En gracia: estado en_gracia', (select estado from mi_plan() x where x.ref_id = 'cprueba-plan') = 'en_gracia', null);
  insert into reservas (complejo_id, cancha_id, fecha, inicio, fin, nombre)
  values ('cprueba-plan', v_cancha, v_dia, v_dia + time '18:00', v_dia + time '19:00', 'Juan');
  insert into resultados (caso, ok) values ('En gracia: sí carga turnos', true);
end $$;

-- 3) Organizador suspendido: no crea torneos nuevos y la página pública lo sabe
reset role;
update plataforma_clientes set suspendido = true where id = (select valor::uuid from ids where clave = 'cli_org');
set local role authenticated;
do $$
begin
  begin
    perform guardar_torneo(jsonb_build_object('id', 'tplan', 'name', 'Torneo nuevo', 'organizerId', (select valor from ids where clave = 'org'), 'categories', '[]'::jsonb), 0, null);
    insert into resultados (caso, ok) values ('Organizador suspendido: no crea torneos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Organizador suspendido: no crea torneos', sqlerrm = 'plan_vencido', sqlerrm); end;
end $$;
reset role;
set local role anon;
do $$
begin
  insert into resultados (caso, ok) values ('El público ve que está suspendido', exists (select 1 from cuentas_suspendidas() s where s.tipo = 'organizador' and s.ref_id = (select valor from ids where clave = 'org')));
end $$;

-- 4) Sin cliente cargado no hay bloqueo
reset role;
delete from plataforma_clientes where id = (select valor::uuid from ids where clave = 'cli_org');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare j jsonb;
begin
  j := guardar_torneo(jsonb_build_object('id', 'tplan2', 'name', 'Torneo libre', 'organizerId', (select valor from ids where clave = 'org'), 'categories', '[]'::jsonb), 0, null);
  insert into resultados (caso, ok, detalle) values ('Sin cliente cargado: crea torneos', j->>'estado' = 'ok', j::text);
end $$;

reset role;
select n, ok, caso, detalle from resultados order by n;
rollback;
