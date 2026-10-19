-- Pruebas de 20261031_fichas_complejos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila con la cantidad de casos, si todos dan bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

-- Preparación: un complejo del organizador de prueba y otro usuario cualquiera
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000f1', 'otro-ficha@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-ficha', (select valor::uuid from ids where clave = 'org'), true);

-- 1) El dueño carga la ficha
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into complejo_fichas (complejo_id, portada_url, fotos, tipo_canchas, techadas, iluminacion, servicios)
  values ('cprueba-ficha', 'https://x.supabase.co/a.jpg', array['https://x.supabase.co/1.jpg', 'https://x.supabase.co/2.jpg'], 'cristal', 'techadas', 'led', array['cantina', 'vestuarios', 'paletas']);
  insert into resultados (caso, ok) values ('El dueño carga su ficha', exists (select 1 from complejo_fichas where complejo_id = 'cprueba-ficha'));
  update complejo_fichas set servicios = array['cantina', 'estacionamiento'] where complejo_id = 'cprueba-ficha';
  insert into resultados (caso, ok) values ('El dueño la cambia', (select servicios = array['cantina', 'estacionamiento'] from complejo_fichas where complejo_id = 'cprueba-ficha'));
  begin
    update complejo_fichas set fotos = array['https://1', 'https://2', 'https://3', 'https://4', 'https://5', 'https://6'] where complejo_id = 'cprueba-ficha';
    insert into resultados (caso, ok) values ('Más de 5 fotos: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Más de 5 fotos: rechazado', sqlstate = '23514', sqlerrm); end;
  begin
    update complejo_fichas set fotos = array['javascript:alert(1)'] where complejo_id = 'cprueba-ficha';
    insert into resultados (caso, ok) values ('Una foto que no es https: rechazada', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Una foto que no es https: rechazada', sqlerrm = 'foto_invalida', sqlerrm); end;
  begin
    update complejo_fichas set servicios = array['pileta'] where complejo_id = 'cprueba-ficha';
    insert into resultados (caso, ok) values ('Un servicio que no está en la lista: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un servicio que no está en la lista: rechazado', sqlstate = '23514', sqlerrm); end;
end $$;

-- 2) Otro usuario no la cambia
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  update complejo_fichas set tipo_canchas = 'muro' where complejo_id = 'cprueba-ficha';
  insert into resultados (caso, ok) values ('Otro usuario no la cambia', (select tipo_canchas from complejo_fichas where complejo_id = 'cprueba-ficha') = 'cristal');
  begin
    insert into complejo_fichas (complejo_id) values ('cprueba-ficha-otro');
    insert into resultados (caso, ok) values ('Otro usuario no carga fichas', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Otro usuario no carga fichas', true, sqlerrm); end;
end $$;

-- 3) Cualquiera (sin entrar) la ve
reset role;
set local role anon;
do $$
begin
  insert into resultados (caso, ok) values ('Se ve sin entrar', (select tipo_canchas from complejo_fichas where complejo_id = 'cprueba-ficha') = 'cristal');
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
