-- Pruebas de 20261030_talles_codigo_rubros.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila con la cantidad de casos, si todos dan bien y los que fallan.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación: complejo, un empleado de la cantina y una cuenta
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000e1', 'talles@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-talles', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-talles', 'talles@prueba.test', false, true);
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-talles', 'Ana') returning id)
insert into ids select 'cuenta', id::text from c;

-- 1) El dueño carga una remera con talles S (2) y M (1), un agua con código y una categoría
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_remera uuid;
  v_agua uuid;
begin
  insert into productos (complejo_id, nombre, precio, stock, rubro) values ('cprueba-talles', 'Remera Black', 25000, 0, 'Indumentaria') returning id into v_remera;
  insert into ids values ('remera', v_remera::text);
  insert into producto_talles (producto_id, complejo_id, talle, stock, orden, codigo) values
    (v_remera, 'cprueba-talles', 'S', 2, 0, '779000000001'), (v_remera, 'cprueba-talles', 'M', 1, 1, '779000000002');
  insert into resultados (caso, ok) values ('El stock de la remera es la suma de los talles (3)', (select stock from productos where id = v_remera) = 3);
  insert into productos (complejo_id, nombre, precio, stock, codigo) values ('cprueba-talles', 'Agua', 1500, 10, '7790895000997') returning id into v_agua;
  insert into ids values ('agua', v_agua::text);
  begin
    insert into productos (complejo_id, nombre, precio, codigo) values ('cprueba-talles', 'Otra agua', 1500, '7790895000997');
    insert into resultados (caso, ok) values ('No se repite un código en el complejo', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se repite un código en el complejo', sqlstate = '23505', sqlerrm); end;
  update productos set stock = 100 where id = v_remera;
  insert into resultados (caso, ok) values ('Cambiar a mano el stock de la remera no lo desarma (sigue en 3)', (select stock from productos where id = v_remera) = 3);
  insert into rubros (complejo_id, nombre, icono, orden) values ('cprueba-talles', 'Indumentaria', 'indumentaria', 0);
  insert into resultados (caso, ok) values ('El dueño carga una categoría', exists (select 1 from rubros where complejo_id = 'cprueba-talles'));
end $$;

-- 2) El empleado de la cantina vende una M, ve talles y categorías, pero no los cambia
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_remera text := (select valor from ids where clave = 'remera');
  v_agua text := (select valor from ids where clave = 'agua');
  j jsonb;
begin
  j := vender('cprueba-talles', jsonb_build_array(jsonb_build_object('producto_id', v_remera, 'talle', 'M', 'cantidad', 1)), '[{"medio":"efectivo","monto":25000}]'::jsonb);
  insert into ids values ('venta', j->>'venta_id');
  insert into resultados (caso, ok) values ('Vende una M: la M queda en 0', (select stock from producto_talles where producto_id = v_remera::uuid and talle = 'M') = 0);
  insert into resultados (caso, ok) values ('La remera queda con 2', (select stock from productos where id = v_remera::uuid) = 2);
  insert into resultados (caso, ok, detalle) values ('En la venta figura "Remera Black M" con su talle',
    (select descripcion = 'Remera Black M' and talle = 'M' from venta_items where venta_id = (j->>'venta_id')::uuid),
    (select descripcion from venta_items where venta_id = (j->>'venta_id')::uuid));
  begin
    perform vender('cprueba-talles', jsonb_build_array(jsonb_build_object('producto_id', v_remera, 'cantidad', 1)), '[{"medio":"efectivo","monto":25000}]'::jsonb);
    insert into resultados (caso, ok) values ('Sin talle no se vende una prenda con talles', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin talle no se vende una prenda con talles', sqlerrm = 'elegir_talle', sqlerrm); end;
  begin
    perform vender('cprueba-talles', jsonb_build_array(jsonb_build_object('producto_id', v_remera, 'talle', 'XXL', 'cantidad', 1)), '[{"medio":"efectivo","monto":25000}]'::jsonb);
    insert into resultados (caso, ok) values ('Un talle que no existe: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un talle que no existe: rechazado', sqlerrm = 'talle_invalido', sqlerrm); end;
  begin
    perform vender('cprueba-talles', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'talle', 'M', 'cantidad', 1)), '[{"medio":"efectivo","monto":1500}]'::jsonb);
    insert into resultados (caso, ok) values ('Un talle en algo sin talles: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un talle en algo sin talles: rechazado', sqlerrm = 'talle_invalido', sqlerrm); end;
  perform vender('cprueba-talles', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 2)), '[{"medio":"efectivo","monto":3000}]'::jsonb);
  insert into resultados (caso, ok) values ('Lo que no tiene talles se vende como siempre', (select stock from productos where id = v_agua::uuid) = 8);
  insert into resultados (caso, ok) values ('El empleado ve los talles', (select count(*) from producto_talles where producto_id = v_remera::uuid) = 2);
  insert into resultados (caso, ok) values ('El empleado ve las categorías', exists (select 1 from rubros where complejo_id = 'cprueba-talles'));
  update producto_talles set stock = 50 where producto_id = v_remera::uuid;
  insert into resultados (caso, ok) values ('El empleado no cambia el stock de un talle a mano', (select stock from producto_talles where producto_id = v_remera::uuid and talle = 'S') = 2);
  begin
    insert into rubros (complejo_id, nombre) values ('cprueba-talles', 'Otra');
    insert into resultados (caso, ok) values ('El empleado no carga categorías', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no carga categorías', sqlstate = '42501', sqlerrm); end;
  -- Reponer
  begin
    perform sumar_stock(v_remera::uuid, 3);
    insert into resultados (caso, ok) values ('Reponer una prenda con talles pide el talle', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Reponer una prenda con talles pide el talle', sqlerrm = 'elegir_talle', sqlerrm); end;
  insert into resultados (caso, ok) values ('Repone 3 de S: queda en 5', sumar_stock_talle(v_remera::uuid, 'S', 3) = 5);
  insert into resultados (caso, ok) values ('La remera queda con 5', (select stock from productos where id = v_remera::uuid) = 5);
  -- Cuentas: no se anota una prenda con talles
  begin
    insert into cuenta_consumos (complejo_id, cuenta_id, producto_id, descripcion, cantidad, precio_unitario)
    values ('cprueba-talles', (select valor::uuid from ids where clave = 'cuenta'), v_remera::uuid, 'x', 1, 1);
    insert into resultados (caso, ok) values ('Desde Cuentas no se anota una prenda con talles', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Desde Cuentas no se anota una prenda con talles', sqlerrm = 'elegir_talle', sqlerrm); end;
end $$;

-- 3) El dueño compra 5 M, anula la compra y anula la venta
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_remera text := (select valor from ids where clave = 'remera');
  j jsonb;
begin
  j := registrar_compra('cprueba-talles', null, current_date, jsonb_build_array(jsonb_build_object('producto_id', v_remera, 'talle', 'M', 'cantidad', 5, 'costo', 12000)), 'efectivo');
  insert into resultados (caso, ok) values ('Compra 5 M: la M queda en 5', (select stock from producto_talles where producto_id = v_remera::uuid and talle = 'M') = 5);
  insert into resultados (caso, ok) values ('En la compra figura "Remera Black M"', (select descripcion = 'Remera Black M' and talle = 'M' from compra_items where compra_id = (j->>'compra_id')::uuid));
  perform anular_compra((j->>'compra_id')::uuid);
  insert into resultados (caso, ok) values ('Anular la compra: la M vuelve a 0', (select stock from producto_talles where producto_id = v_remera::uuid and talle = 'M') = 0);
  perform anular_venta((select valor::uuid from ids where clave = 'venta'));
  insert into resultados (caso, ok) values ('Anular la venta: la M vuelve a 1', (select stock from producto_talles where producto_id = v_remera::uuid and talle = 'M') = 1);
  insert into resultados (caso, ok) values ('La remera queda con 6 (S 5 + M 1)', (select stock from productos where id = v_remera::uuid) = 6);
  delete from producto_talles where producto_id = v_remera::uuid and talle = 'S';
  insert into resultados (caso, ok) values ('Borrar un talle descuenta su stock del producto', (select stock from productos where id = v_remera::uuid) = 1);
end $$;

reset role;
select count(*) as casos, bool_and(ok) as todo_ok, string_agg(caso || ': ' || coalesce(detalle, ''), ' / ') filter (where not ok) as fallan from resultados;
rollback;
