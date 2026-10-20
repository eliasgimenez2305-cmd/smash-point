-- Pruebas de 20261038_perfiles_jugador.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila con la cantidad de casos,
-- si dieron todos bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));

-- 1) El organizador busca y crea jugadores
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_a uuid; v_b uuid; v_c uuid; v_n int;
begin
  select count(*) into v_n from buscar_jugadores('5493446999001');
  insert into resultados (caso, ok, detalle) values ('Teléfono nuevo: no encuentra a nadie', v_n = 0, v_n::text);

  v_a := crear_jugador('Gimenez', 'Elias', '5493446999001');
  insert into resultados (caso, ok) values ('Crea el perfil', v_a is not null);

  v_b := crear_jugador(' gimenez ', 'ELÍAS', '5493446999001');
  insert into resultados (caso, ok) values ('Mismo teléfono y mismo nombre: devuelve el mismo perfil', v_b = v_a);

  v_c := crear_jugador('Gimenez', 'Tomas', '5493446999001');
  insert into resultados (caso, ok) values ('Mismo teléfono y otro nombre (un hijo): perfil nuevo', v_c <> v_a);

  select count(*) into v_n from buscar_jugadores('5493446999001');
  insert into resultados (caso, ok, detalle) values ('Busca por teléfono: aparecen los dos', v_n = 2, v_n::text);

  insert into resultados (caso, ok, detalle) values ('La búsqueda no devuelve el teléfono',
    pg_get_function_result('public.buscar_jugadores(text)'::regprocedure) not ilike '%telefono%',
    pg_get_function_result('public.buscar_jugadores(text)'::regprocedure));

  begin
    perform crear_jugador('Perez', 'Juan', '3446999001');
    insert into resultados (caso, ok) values ('Teléfono mal escrito: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Teléfono mal escrito: lo rechaza', sqlerrm = 'datos_invalidos', sqlerrm); end;

  begin
    perform crear_jugador('', 'Juan', '5493446999002');
    insert into resultados (caso, ok) values ('Sin apellido: lo rechaza', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin apellido: lo rechaza', sqlerrm = 'datos_invalidos', sqlerrm); end;

  begin
    perform 1 from perfiles_jugador limit 1;
    insert into resultados (caso, ok) values ('La tabla no se lee directo (teléfonos privados)', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('La tabla no se lee directo (teléfonos privados)', true, sqlerrm); end;
end $$;

-- 2) Alguien con cuenta que no es organizador ni empleado
reset role;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin
    perform buscar_jugadores('5493446999001');
    insert into resultados (caso, ok) values ('Un jugador no busca teléfonos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un jugador no busca teléfonos', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    perform crear_jugador('Perez', 'Juan', '5493446999003');
    insert into resultados (caso, ok) values ('Un jugador no crea perfiles', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un jugador no crea perfiles', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 3) Sin sesión
reset role;
set local role anon;
do $$
begin
  begin
    perform buscar_jugadores('5493446999001');
    insert into resultados (caso, ok) values ('Sin sesión no busca', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin sesión no busca', true, sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan from resultados;
rollback;
