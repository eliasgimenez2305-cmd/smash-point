-- Pruebas de 20261041_telefonos_empleados.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- (y con la función "cuentas" prendida). Todo se deshace al final. Resultado: una fila con la cantidad
-- de casos, si dieron todos bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador)
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')),
  ('e', gen_random_uuid()::text), ('f', gen_random_uuid()::text), ('g', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', tel, conf, now(), now()
from (values ('e', '5493446999401', now()), ('f', '5493446999402', null), ('g', '5493446999403', now())) v(clave, tel, conf)
join ids using (clave);
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-emp', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, telefono, nombre, p_agenda) values
  ('cprueba-emp', '5493446999401', 'Empleado tel', true),
  ('cprueba-emp', '5493446999402', 'Sin confirmar', true);
-- Perfiles: P sin cuenta y R con cuenta (de G) en un torneo del organizador; Q fuera de sus torneos
insert into perfiles_jugador (apellido, nombre, telefono) values ('Prueba', 'P', '5493446999411'), ('Prueba', 'Q', '5493446999412');
insert into perfiles_jugador (apellido, nombre, telefono, cuenta_id) select 'Prueba', 'R', '5493446999403', valor::uuid from ids where clave = 'g';
insert into jugadores (id, nombre, apellido, telefono) select valor::uuid, 'R', 'Prueba', '5493446999403' from ids where clave = 'g';
insert into ids select 'p', id::text from perfiles_jugador where apellido = 'Prueba' and nombre = 'P';
insert into ids select 'q', id::text from perfiles_jugador where apellido = 'Prueba' and nombre = 'Q';
insert into ids select 'r', id::text from perfiles_jugador where apellido = 'Prueba' and nombre = 'R';
insert into torneos (id, organizador_id, datos)
select 'tprueba-tel', null, jsonb_build_object('id', 'tprueba-tel', 'name', 'Prueba teléfonos', 'organizerId', (select valor from ids where clave = 'org'),
  'categories', jsonb_build_array(jsonb_build_object('id', 'c1', 'name', '4TA', 'groups', '[]'::jsonb, 'pairs', jsonb_build_array(
    jsonb_build_object('id', 'x1', 'name', 'Prueba P / Prueba R', 'players', jsonb_build_array(
      jsonb_build_object('id', (select valor from ids where clave = 'p'), 'name', 'Prueba P'),
      jsonb_build_object('id', (select valor from ids where clave = 'r'), 'name', 'Prueba R')))))));

-- Reglas de la tabla de empleados
do $$
begin
  begin
    insert into colaboradores (complejo_id, nombre) values ('cprueba-emp', 'Sin nada');
    insert into resultados (caso, ok) values ('Empleado sin mail ni teléfono: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Empleado sin mail ni teléfono: lo rechaza', true, sqlerrm); end;
  begin
    insert into colaboradores (complejo_id, telefono) values ('cprueba-emp', '5493446999401');
    insert into resultados (caso, ok) values ('Mismo teléfono dos veces en el complejo: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Mismo teléfono dos veces en el complejo: lo rechaza', sqlstate = '23505', sqlerrm); end;
end $$;

-- 1) El empleado con teléfono confirmado
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'e'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok) values ('Empleado por teléfono: ve el complejo', exists (select 1 from mis_complejos_colaborador() where complejo_id = 'cprueba-emp'));
  insert into resultados (caso, ok) values ('Empleado por teléfono: tiene permiso de agenda', colaborador_permiso('cprueba-emp', 'agenda'));
  insert into resultados (caso, ok) values ('Empleado por teléfono: no tiene permiso de cantina', not colaborador_permiso('cprueba-emp', 'consumos'));
end $$;

-- 2) Con el teléfono sin confirmar
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'f'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok) values ('Teléfono sin confirmar: no ve el complejo', not exists (select 1 from mis_complejos_colaborador() where complejo_id = 'cprueba-emp'));
end $$;

-- 3) G cambió su teléfono (ya confirmado): su ficha y su perfil pasan al número nuevo
reset role;
update auth.users set phone = '5493446999404' where id = (select valor::uuid from ids where clave = 'g');
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'g'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v text;
begin
  v := sincronizar_mi_telefono();
  insert into resultados (caso, ok, detalle) values ('Cambio de teléfono: ficha y perfil al número nuevo',
    v = '5493446999404' and (select telefono from jugadores where id = auth.uid()) = '5493446999404', v);
end $$;
reset role;
do $$
begin
  insert into resultados (caso, ok) values ('Cambio de teléfono: el perfil conserva su ID con el número nuevo',
    (select telefono from perfiles_jugador where id = (select valor::uuid from ids where clave = 'r')) = '5493446999404');
end $$;

-- 4) El organizador ve y corrige teléfonos de sus torneos
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from telefono_de_jugador((select valor::uuid from ids where clave = 'p'));
  insert into resultados (caso, ok, detalle) values ('Organizador ve el teléfono de un jugador de su torneo', r.telefono = '5493446999411' and not r.con_cuenta, r.telefono);
  perform corregir_telefono_jugador((select valor::uuid from ids where clave = 'p'), '5493446999421');
  insert into resultados (caso, ok, detalle) values ('Organizador corrige el teléfono de un jugador sin cuenta',
    (select telefono from telefono_de_jugador((select valor::uuid from ids where clave = 'p'))) = '5493446999421', null);
  begin
    perform corregir_telefono_jugador((select valor::uuid from ids where clave = 'r'), '5493446999422');
    insert into resultados (caso, ok) values ('Jugador con cuenta: el organizador no le cambia el teléfono', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Jugador con cuenta: el organizador no le cambia el teléfono', sqlerrm = 'tiene_cuenta', sqlerrm); end;
  begin
    perform telefono_de_jugador((select valor::uuid from ids where clave = 'q'));
    insert into resultados (caso, ok) values ('Jugador que no está en sus torneos: no ve su teléfono', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Jugador que no está en sus torneos: no ve su teléfono', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    perform corregir_telefono_jugador((select valor::uuid from ids where clave = 'p'), '3446999421');
    insert into resultados (caso, ok) values ('Teléfono mal escrito: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Teléfono mal escrito: lo rechaza', sqlerrm = 'telefono_invalido', sqlerrm); end;
end $$;

-- 5) Alguien que no es organizador
reset role;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform telefono_de_jugador((select valor::uuid from ids where clave = 'p'));
    insert into resultados (caso, ok) values ('Un jugador no ve teléfonos ajenos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un jugador no ve teléfonos ajenos', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PRUEBA4' as fin from resultados;
rollback;
