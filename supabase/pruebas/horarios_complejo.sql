-- Pruebas de 20261050_horarios_complejo.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba')), ('otro', gen_random_uuid()::text);
insert into auth.users (id, aud, role, email, created_at, updated_at) select valor::uuid, 'authenticated', 'authenticated', 'otro@inventado.test', now(), now() from ids where clave = 'otro';
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-hc', (select valor::uuid from ids where clave = 'org'), true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-hc', 'Cancha 1', '08:00', '23:00'), ('cprueba-hc', 'Cancha 2', '10:00', '20:00') returning id, nombre)
insert into ids select case nombre when 'Cancha 1' then 'c1' else 'c2' end, id::text from c;
update canchas set horario_propio = true where id = (select valor::uuid from ids where clave = 'c2');

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare c1 uuid := (select valor::uuid from ids where clave = 'c1'); c2 uuid := (select valor::uuid from ids where clave = 'c2'); x record;
begin
  select * into x from _horario_dia(c1, date '2026-10-26');
  insert into resultados (caso, ok, detalle) values ('Sin horario del complejo: el de la cancha', x.desde = 480 and x.hasta = 1380, x::text);

  perform guardar_horarios_complejo('cprueba-hc',
    '{"0": null, "1": [420, 1440], "2": [420, 1440], "3": [420, 1440], "4": [420, 1440], "5": [420, 1440], "6": [480, 1560]}',
    '{"0": null, "1": [840, 1380], "2": [840, 1380], "3": [840, 1380], "4": [840, 1380], "5": [840, 1380], "6": [0, 1440]}');
  select * into x from _horario_dia(c1, date '2026-10-26');
  insert into resultados (caso, ok, detalle) values ('Lunes: el complejo abre de 7 a 24', x.desde = 420 and x.hasta = 1440, x::text);
  select * into x from _horario_dia(c1, date '2026-10-26', true);
  insert into resultados (caso, ok, detalle) values ('Lunes online: de 14 a 23', x.desde = 840 and x.hasta = 1380, x::text);
  select * into x from _horario_dia(c1, date '2026-10-31');
  insert into resultados (caso, ok, detalle) values ('Sábado: de 8 a 2 del domingo', x.desde = 480 and x.hasta = 1560, x::text);
  select * into x from _horario_dia(c1, date '2026-11-01');
  insert into resultados (caso, ok, detalle) values ('Domingo cerrado', x.desde is null, x::text);
  select * into x from _horario_dia(c2, date '2026-10-26', true);
  insert into resultados (caso, ok, detalle) values ('Cancha con horario propio (10 a 20) recortada al online (14 a 20)', x.desde = 840 and x.hasta = 1200, x::text);
  begin
    perform guardar_horarios_complejo('cprueba-hc', '{"1": [420, 425]}', null);
    insert into resultados (caso, ok) values ('No acepta horarios que no son de a media hora', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No acepta horarios que no son de a media hora', sqlerrm = 'horario_invalido', sqlerrm); end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'otro'), 'role', 'authenticated')::text, true);
do $$
begin
  perform guardar_horarios_complejo('cprueba-hc', null, null);
  insert into resultados (caso, ok) values ('Otro no cambia los horarios', false);
exception when others then insert into resultados (caso, ok, detalle) values ('Otro no cambia los horarios', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_HC' as fin from resultados;
rollback;
