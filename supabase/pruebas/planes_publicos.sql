-- Pruebas de 20261055_planes_publicos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
grant all on resultados to anon, authenticated;
grant usage on sequence resultados_n_seq to anon, authenticated;

insert into plataforma_planes (nombre, para, precio, modulo_reservas, orden, en_la_web, destacado)
values ('PRUEBA web', 'complejo', 11111, true, 900, true, true),
       ('PRUEBA oculto', 'complejo', 22222, true, 901, false, false),
       ('PRUEBA apagado', 'organizador', 33333, false, 902, true, false),
       ('PRUEBA publicidad', 'publicidad', 44444, false, 903, true, false);
update plataforma_planes set activo = false where nombre = 'PRUEBA apagado';

-- Como visitante (sin iniciar sesión)
set local role anon;
insert into resultados (caso, ok, detalle) values
  ('Un visitante ve el plan en la web, con destacado', exists (select 1 from planes_publicos() where nombre = 'PRUEBA web' and destacado and precio = 11111), null),
  ('No ve el plan que no está en la web', not exists (select 1 from planes_publicos() where nombre = 'PRUEBA oculto'), null),
  ('No ve el plan apagado', not exists (select 1 from planes_publicos() where nombre = 'PRUEBA apagado'), null),
  ('No ve los planes de publicidad', not exists (select 1 from planes_publicos() where nombre = 'PRUEBA publicidad'), null);
do $$
begin
  -- Con RLS ve cero filas (o directamente no tiene permiso): las dos cosas valen
  insert into resultados (caso, ok, detalle) values ('Un visitante no lee la tabla de planes directo', not exists (select 1 from plataforma_planes), 've filas');
exception when others then insert into resultados (caso, ok, detalle) values ('Un visitante no lee la tabla de planes directo', true, sqlerrm);
end $$;
reset role;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_PLANES_PUBLICOS' as fin from resultados;
rollback;
