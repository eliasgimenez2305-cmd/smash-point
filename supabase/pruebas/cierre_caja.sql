-- Pruebas de 20261025_cierre_caja.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: resumen con todo_ok = true.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación: complejo, una cancha, agua a 1.500 y un empleado con agenda y cantina
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000c1', 'caja@prueba.test', now());
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000c2', 'otro@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-caja', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-caja', 'caja@prueba.test', true, true);
with c as (insert into canchas (complejo_id, nombre, apertura, cierre) values ('cprueba-caja', 'Cancha 1', '08:00', '23:00') returning id)
insert into ids select 'cancha', id::text from c;
with p as (insert into productos (complejo_id, nombre, precio, stock) values ('cprueba-caja', 'Agua', 1500, 50) returning id)
insert into ids select 'agua', id::text from p;

-- 1) El empleado abre su caja con $10.000, vende y cobra un turno
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v uuid;
begin
  v := abrir_caja('cprueba-caja', 10000);
  insert into ids values ('turno', v::text);
  insert into resultados (caso, ok) values ('Abre la caja con fondo de 10.000', v is not null);
  begin
    perform abrir_caja('cprueba-caja', 0);
    insert into resultados (caso, ok) values ('No abre dos cajas a la vez', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No abre dos cajas a la vez', sqlerrm = 'caja_ya_abierta', sqlerrm); end;
  perform vender('cprueba-caja', jsonb_build_array(jsonb_build_object('producto_id', (select valor from ids where clave = 'agua'), 'cantidad', 2)), '[{"medio":"efectivo","monto":3000}]'::jsonb);
  perform vender('cprueba-caja', jsonb_build_array(jsonb_build_object('producto_id', (select valor from ids where clave = 'agua'), 'cantidad', 1)), '[{"medio":"transferencia","monto":1500}]'::jsonb);
end $$;
-- El turno cobrado en efectivo (la base anota quién cobró)
reset role;
insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, nombre, precio, medio_pago)
select 'cprueba-caja', valor::uuid, 'turno', '2030-01-10', '2030-01-10 20:00-03', '2030-01-10 21:30-03', 'confirmada', 'Juan', 20000, 'efectivo'
from ids where clave = 'cancha';
insert into resultados (caso, ok) values ('El turno queda cobrado por el empleado',
  (select cobrado_por from reservas where complejo_id = 'cprueba-caja') = '00000000-0000-4000-8000-0000000000c1');
set local role authenticated;

do $$
declare
  v uuid := (select valor::uuid from ids where clave = 'turno');
  r jsonb;
begin
  perform mover_caja(v, 'retiro', 5000, 'Retiro del dueño');
  perform mover_caja(v, 'gasto', 1000, 'Hielo');
  r := resumen_caja(v);
  insert into resultados (caso, ok, detalle) values ('Efectivo esperado: 10.000 + 3.000 + 20.000 − 5.000 − 1.000 = 27.000', (r->>'efectivo_esperado')::numeric = 27000, r::text);
  insert into resultados (caso, ok, detalle) values ('Transferencias: 1.500', (r->'por_medio'->>'transferencia')::numeric = 1500, r->>'por_medio');
  insert into resultados (caso, ok, detalle) values ('Por origen: mostrador 4.500 y turnos 20.000', (r->'por_origen'->>'mostrador')::numeric = 4500 and (r->'por_origen'->>'turnos')::numeric = 20000, r->>'por_origen');
  begin
    perform mover_caja(v, 'retiro', 0, 'x');
    insert into resultados (caso, ok) values ('Monto 0: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Monto 0: rechazado', sqlstate = '23514', sqlerrm); end;
  begin
    insert into caja_turnos (complejo_id, usuario) values ('cprueba-caja', auth.uid());
    insert into resultados (caso, ok) values ('No se cargan cajas a mano', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se cargan cajas a mano', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) Otra persona no ve ni cierra esa caja
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
do $$
begin
  begin
    perform resumen_caja((select valor::uuid from ids where clave = 'turno'));
    insert into resultados (caso, ok) values ('Otra persona no ve la caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Otra persona no ve la caja', sqlerrm = 'no_autorizado', sqlerrm); end;
  insert into resultados (caso, ok) values ('Otra persona no lista la caja', not exists (select 1 from caja_turnos where complejo_id = 'cprueba-caja'));
  begin
    perform abrir_caja('cprueba-caja', 0);
    insert into resultados (caso, ok) values ('Sin permiso no abre caja', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin permiso no abre caja', sqlerrm = 'no_autorizado', sqlerrm); end;
end $$;

-- 3) El empleado cierra contando 26.500: faltan 500
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
do $$
declare
  v uuid := (select valor::uuid from ids where clave = 'turno');
  r jsonb;
begin
  r := cerrar_caja(v, 26500, 'Faltan 500');
  insert into resultados (caso, ok, detalle) values ('Cierra: diferencia −500', (r->>'diferencia')::numeric = -500, r::text);
  begin
    perform mover_caja(v, 'gasto', 100, 'Tarde');
    insert into resultados (caso, ok) values ('Caja cerrada: no se mueve', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Caja cerrada: no se mueve', sqlerrm = 'caja_cerrada', sqlerrm); end;
  insert into resultados (caso, ok) values ('Puede abrir otra caja después de cerrar', abrir_caja('cprueba-caja', 0) is not null);
end $$;

-- 4) El dueño ve el cierre del empleado
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok, detalle) values ('El dueño ve el cierre con lo contado y lo esperado',
    exists (select 1 from caja_turnos where complejo_id = 'cprueba-caja' and usuario_email = 'caja@prueba.test' and contado = 26500 and esperado = 27000), null);
  insert into resultados (caso, ok) values ('El dueño ve los movimientos de la caja',
    (select count(*) from caja_movimientos_turno where complejo_id = 'cprueba-caja') = 2);
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
