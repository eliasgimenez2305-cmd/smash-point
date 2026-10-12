-- Pruebas de 20261026_compras_gastos_fijos.sql. Correr SOLO en el proyecto de PRUEBA.
-- Todo se deshace al final. Resultado: resumen con todo_ok = true.
begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000d1', 'emp-compras@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-comp', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-comp', 'emp-compras@prueba.test', true, true);
with p as (insert into productos (complejo_id, nombre, precio, stock) values ('cprueba-comp', 'Agua', 1500, 2) returning id)
insert into ids select 'agua', id::text from p;

-- 1) El dueño compra
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_agua text := (select valor from ids where clave = 'agua');
  v_prov uuid;
  j jsonb;
begin
  insert into proveedores (complejo_id, nombre) values ('cprueba-comp', 'Distribuidora Sur') returning id into v_prov;
  insert into ids values ('prov', v_prov::text);
  j := registrar_compra('cprueba-comp', v_prov, '2030-01-10', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 48, 'costo', 500), jsonb_build_object('descripcion', 'Bolsas', 'cantidad', 1, 'costo', 3000)), 'efectivo');
  insert into ids values ('compra1', j->>'compra_id');
  insert into resultados (caso, ok, detalle) values ('Compra: total 27.000', (j->>'total')::numeric = 27000, j::text);
  insert into resultados (caso, ok, detalle) values ('Suma 48 al stock (2 → 50)', (select stock from productos where id = v_agua::uuid) = 50, null);
  insert into resultados (caso, ok, detalle) values ('Actualiza el costo a 500', (select costo from producto_costos where producto_id = v_agua::uuid) = 500, null);
  insert into resultados (caso, ok, detalle) values ('Pagada en efectivo ese día', (select pagada_at = '2030-01-10' and medio = 'efectivo' from compras where id = (j->>'compra_id')::uuid), null);

  j := registrar_compra('cprueba-comp', v_prov, '2030-01-11', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 24, 'costo', 550)), null);
  insert into ids values ('compra2', j->>'compra_id');
  insert into resultados (caso, ok, detalle) values ('Compra a pagar: queda debiendo', (select pagada_at is null from compras where id = (j->>'compra_id')::uuid), null);
  insert into resultados (caso, ok, detalle) values ('El costo pasa a 550', (select costo from producto_costos where producto_id = v_agua::uuid) = 550, null);
  perform pagar_compra((j->>'compra_id')::uuid, 'transferencia', '2030-01-15');
  insert into resultados (caso, ok, detalle) values ('Se paga después', (select pagada_at = '2030-01-15' and medio = 'transferencia' from compras where id = (j->>'compra_id')::uuid), null);
  begin
    perform pagar_compra((j->>'compra_id')::uuid, 'efectivo', null);
    insert into resultados (caso, ok) values ('No se paga dos veces', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se paga dos veces', sqlerrm = 'compra_ya_pagada', sqlerrm); end;

  perform anular_compra((select valor::uuid from ids where clave = 'compra2'));
  insert into resultados (caso, ok, detalle) values ('Anulada: el stock vuelve (74 → 50)', (select stock from productos where id = v_agua::uuid) = 50, null);

  -- Gastos fijos
  insert into gastos_fijos (concepto, monto, dia) values ('Luz', 80000, 10) returning id into v_prov;
  insert into ids values ('luz', v_prov::text);
  insert into caja_movimientos (fecha, tipo, concepto, monto, medio, gasto_fijo_id, periodo) values ('2030-01-10', 'gasto', 'Luz', 80000, 'transferencia', v_prov, '2030-01');
  insert into resultados (caso, ok) values ('Gasto fijo pagado en enero', true);
  begin
    insert into caja_movimientos (fecha, tipo, concepto, monto, medio, gasto_fijo_id, periodo) values ('2030-01-12', 'gasto', 'Luz', 80000, 'transferencia', v_prov, '2030-01');
    insert into resultados (caso, ok) values ('No se paga dos veces el mismo mes', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se paga dos veces el mismo mes', sqlstate = '23505', sqlerrm); end;
end $$;

-- 2) Un empleado no compra ni ve compras ni gastos fijos
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform registrar_compra('cprueba-comp', null, '2030-01-10', '[{"descripcion":"x","cantidad":1,"costo":1}]'::jsonb, 'efectivo');
    insert into resultados (caso, ok) values ('El empleado no compra', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no compra', sqlerrm = 'no_autorizado', sqlerrm); end;
  insert into resultados (caso, ok) values ('El empleado no ve compras', not exists (select 1 from compras where complejo_id = 'cprueba-comp'));
  insert into resultados (caso, ok) values ('El empleado no ve proveedores', not exists (select 1 from proveedores where complejo_id = 'cprueba-comp'));
  insert into resultados (caso, ok) values ('El empleado no ve gastos fijos', not exists (select 1 from gastos_fijos));
  begin
    insert into compras (complejo_id, fecha, total) values ('cprueba-comp', '2030-01-10', 1);
    insert into resultados (caso, ok) values ('No se cargan compras a mano', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se cargan compras a mano', sqlstate = '42501', sqlerrm); end;
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
