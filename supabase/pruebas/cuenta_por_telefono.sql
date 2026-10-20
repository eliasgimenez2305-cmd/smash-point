-- Pruebas de 20261040_cuenta_por_telefono.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila con la cantidad de casos,
-- si dieron todos bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación (administrador): cuentas de mentira con teléfono y perfiles cargados por organizadores
insert into ids values ('a', gen_random_uuid()::text), ('b', gen_random_uuid()::text), ('c', gen_random_uuid()::text), ('d', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', tel, conf, now(), now()
from (values ('a', '5493446999301', now()), ('b', '5493446999302', null), ('c', '5493446999303', now()), ('d', '5493446999304', now())) v(clave, tel, conf)
join ids using (clave);
insert into perfiles_jugador (apellido, nombre, telefono) values
  ('Gomez', 'Padre', '5493446999301'),
  ('Gomez', 'Hijo', '5493446999301'),
  ('Otro', 'Jugador', '5493446999399');
insert into ids select 'hijo', id::text from perfiles_jugador where apellido = 'Gomez' and nombre = 'Hijo';
insert into ids select 'padre', id::text from perfiles_jugador where apellido = 'Gomez' and nombre = 'Padre';
insert into ids select 'otro', id::text from perfiles_jugador where apellido = 'Otro';

-- 1) La cuenta A (teléfono confirmado, con dos perfiles con su número)
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_n int; r jsonb;
begin
  select count(*) into v_n from mis_perfiles_por_telefono();
  insert into resultados (caso, ok, detalle) values ('Ve los dos perfiles con su teléfono', v_n = 2, v_n::text);

  r := completar_cuenta((select valor::uuid from ids where clave = 'hijo'), '', '');
  insert into resultados (caso, ok, detalle) values ('Reclama el perfil del hijo: sus datos salen del perfil',
    r->>'apellido' = 'Gomez' and r->>'nombre' = 'Hijo' and r->>'telefono' = '5493446999301' and r->>'perfil_id' = (select valor from ids where clave = 'hijo'), r::text);

  select count(*) into v_n from mis_perfiles_por_telefono();
  insert into resultados (caso, ok, detalle) values ('Ya no ve el perfil reclamado (queda el del padre)', v_n = 1, v_n::text);

  r := completar_cuenta((select valor::uuid from ids where clave = 'padre'), 'Gomez', 'Tomas');
  insert into resultados (caso, ok, detalle) values ('Con perfil ya reclamado no se lleva otro: actualiza el suyo',
    r->>'perfil_id' = (select valor from ids where clave = 'hijo') and r->>'nombre' = 'Tomas', r::text);

  insert into resultados (caso, ok) values ('Puede leer su fila de jugadores (para reservar)', exists (select 1 from jugadores where id = auth.uid()));
end $$;

-- 2) La cuenta B (teléfono SIN confirmar)
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'b'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform completar_cuenta(null, 'Perez', 'Juan');
    insert into resultados (caso, ok) values ('Sin teléfono confirmado no completa la cuenta', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin teléfono confirmado no completa la cuenta', sqlerrm = 'sin_telefono', sqlerrm); end;
  insert into resultados (caso, ok) values ('Sin teléfono confirmado no ve perfiles', not exists (select 1 from mis_perfiles_por_telefono()));
end $$;

-- 3) La cuenta C intenta reclamar el perfil de otro número
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'c'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform completar_cuenta((select valor::uuid from ids where clave = 'otro'), '', '');
    insert into resultados (caso, ok) values ('No puede reclamar un perfil de otro teléfono', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede reclamar un perfil de otro teléfono', sqlerrm = 'perfil_invalido', sqlerrm); end;
end $$;

-- 4) La cuenta D, jugador nuevo
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'd'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare r jsonb;
begin
  begin
    perform completar_cuenta(null, '', 'Juan');
    insert into resultados (caso, ok) values ('Nuevo sin apellido: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Nuevo sin apellido: lo rechaza', sqlerrm = 'datos_invalidos', sqlerrm); end;
  r := completar_cuenta(null, ' Nuevo ', 'Jugador');
  insert into resultados (caso, ok, detalle) values ('Jugador nuevo: se crea su perfil con su teléfono', r->>'apellido' = 'Nuevo' and r->>'perfil_id' is not null, r::text);
end $$;

reset role;
do $$
begin
  insert into resultados (caso, ok) values ('El perfil nuevo quedó enganchado a la cuenta',
    exists (select 1 from perfiles_jugador where cuenta_id = (select valor::uuid from ids where clave = 'd') and telefono = '5493446999304'));
  insert into resultados (caso, ok) values ('El perfil del padre sigue libre',
    (select cuenta_id from perfiles_jugador where id = (select valor::uuid from ids where clave = 'padre')) is null);
end $$;

-- 5) Sin sesión
set local role anon;
do $$
begin
  begin
    perform mis_perfiles_por_telefono();
    insert into resultados (caso, ok) values ('Sin sesión no ve perfiles', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin sesión no ve perfiles', true, sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PRUEBA3' as fin from resultados;
rollback;
