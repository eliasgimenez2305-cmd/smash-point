-- Pruebas de 20261043_push.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no manda notificaciones: los aparatos de prueba no tienen suscripción real).

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('a', gen_random_uuid()::text), ('b', gen_random_uuid()::text);
insert into auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', tel, now(), now(), now()
from (values ('a', '5493446999601'), ('b', '5493446999602')) v(clave, tel) join ids using (clave);

-- Como A: guarda su aparato, no acepta datos malos
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform guardar_suscripcion('https://push.ejemplo/aparato-1', 'clave', 'auth', 'Prueba');
  insert into resultados (caso, ok) values ('A guarda su aparato', (select count(*) from push_suscripciones) = 1);
  perform guardar_suscripcion('https://push.ejemplo/aparato-1', 'clave2', 'auth2', 'Prueba');
  insert into resultados (caso, ok) values ('Guardarlo de nuevo no lo duplica', (select count(*) from push_suscripciones) = 1);
  begin
    perform guardar_suscripcion('http://inseguro', 'x', 'y');
    insert into resultados (caso, ok) values ('Rechaza direcciones que no son https', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Rechaza direcciones que no son https', true, sqlerrm); end;
  begin
    insert into push_suscripciones (usuario_id, endpoint, p256dh, auth) values (auth.uid(), 'https://push.ejemplo/directo', 'x', 'y');
    insert into resultados (caso, ok) values ('No puede escribir la tabla directo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede escribir la tabla directo', true, sqlerrm); end;
end $$;

-- Como B: no ve el de A; si usa el mismo navegador, el aparato pasa a B
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'b'), 'role', 'authenticated')::text, true);
do $$
begin
  insert into resultados (caso, ok) values ('B no ve los aparatos de A', (select count(*) from push_suscripciones) = 0);
  perform quitar_suscripcion('https://push.ejemplo/aparato-1');
  perform guardar_suscripcion('https://push.ejemplo/aparato-1', 'clave3', 'auth3');
  insert into resultados (caso, ok) values ('Mismo navegador con otra cuenta: pasa a B', (select count(*) from push_suscripciones) = 1);
end $$;
reset role;

do $$
declare v_n int;
begin
  insert into resultados (caso, ok) values ('A ya no tiene ese aparato',
    not exists (select 1 from push_suscripciones s join ids on ids.valor = s.usuario_id::text where ids.clave = 'a'));
  -- Un aviso nuevo no falla aunque falten los secretos o la función no conteste
  insert into notificaciones (usuario_id, tipo, titulo, ref) select valor::uuid, 'prueba', 'Aviso de prueba', 'p1' from ids where clave = 'b';
  get diagnostics v_n = row_count;
  insert into resultados (caso, ok) values ('El aviso se anota igual (con aparato y disparador)', v_n = 1);
end $$;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PUSH' as fin from resultados;
rollback;
