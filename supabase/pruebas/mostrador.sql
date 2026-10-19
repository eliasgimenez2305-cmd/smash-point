-- Pruebas de 20261024_mostrador.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado).
-- Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

-- Preparación (como administrador): complejo con agua (stock 10, costo 500) y una paleta (stock 2,
-- costo 150.000), una cuenta y un empleado de la cantina
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000b1', 'mostrador@prueba.test', now());
insert into complejos (id, dueno_id, reservas_habilitadas) values ('cprueba-most', (select valor::uuid from ids where clave = 'org'), true);
insert into colaboradores (complejo_id, email, p_agenda, p_consumos) values ('cprueba-most', 'mostrador@prueba.test', false, true);
with p as (insert into productos (complejo_id, nombre, precio, stock, rubro) values ('cprueba-most', 'Agua 500', 1500, 10, 'Bebidas') returning id)
insert into ids select 'agua', id::text from p;
with p as (insert into productos (complejo_id, nombre, precio, stock, rubro) values ('cprueba-most', 'Paleta Bullpadel Vertex 04 2025', 250000, 2, 'Paletas') returning id)
insert into ids select 'paleta', id::text from p;
insert into producto_costos (producto_id, complejo_id, costo) select valor::uuid, 'cprueba-most', 500 from ids where clave = 'agua';
insert into producto_costos (producto_id, complejo_id, costo) select valor::uuid, 'cprueba-most', 150000 from ids where clave = 'paleta';
with c as (insert into cuentas (complejo_id, nombre) values ('cprueba-most', 'Martín Moyano') returning id)
insert into ids select 'cuenta', id::text from c;

-- 1) El empleado vende
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_agua text := (select valor from ids where clave = 'agua');
  v_paleta text := (select valor from ids where clave = 'paleta');
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  j jsonb;
  n int;
begin
  -- 2 aguas + algo suelto, en efectivo
  j := vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 2), jsonb_build_object('descripcion', 'Encordado', 'precio', 8000, 'cantidad', 1)),
              '[{"medio":"efectivo","monto":11000}]'::jsonb);
  insert into resultados (caso, ok, detalle) values ('Vende 2 aguas + encordado: total 11.000', (j->>'total')::numeric = 11000, j::text);
  insert into ids values ('venta1', j->>'venta_id');
  insert into resultados (caso, ok, detalle) values ('Descuenta el stock del agua', (select stock from productos where id = v_agua::uuid) = 8, null);
  insert into resultados (caso, ok, detalle) values ('El precio sale de la base', (select precio_unitario from venta_items where venta_id = (j->>'venta_id')::uuid and producto_id = v_agua::uuid) = 1500, null);
  insert into resultados (caso, ok, detalle) values ('Queda a nombre del empleado', (select vendido_por_email from ventas where id = (j->>'venta_id')::uuid) = 'mostrador@prueba.test', null);

  -- Paleta con 10% de descuento, pagada en dos partes
  j := vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_paleta, 'cantidad', 1)),
              '[{"medio":"efectivo","monto":100000},{"medio":"transferencia","monto":125000}]'::jsonb, -25000);
  insert into resultados (caso, ok, detalle) values ('Paleta con descuento, pago dividido', (j->>'total')::numeric = 225000 and (select count(*) from venta_pagos where venta_id = (j->>'venta_id')::uuid) = 2, j::text);

  -- Paleta con seña de 50.000 y el resto a cuenta
  j := vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_paleta, 'cantidad', 1)),
              '[{"medio":"efectivo","monto":50000}]'::jsonb, 0, v_cuenta);
  insert into resultados (caso, ok, detalle) values ('Seña: 200.000 quedan a cuenta', (j->>'a_cuenta')::numeric = 200000, j::text);
  insert into ids values ('venta3', j->>'venta_id');
  insert into resultados (caso, ok, detalle) values ('La cuenta debe 200.000',
    (select consumido - pagado from cuentas_con_saldo('cprueba-most') x where x.id = v_cuenta) = 200000, null);
  insert into resultados (caso, ok, detalle) values ('La paleta quedó sin stock', (select stock from productos where id = v_paleta::uuid) = 0, null);

  -- Errores
  begin
    perform vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[{"medio":"efectivo","monto":500}]'::jsonb);
    insert into resultados (caso, ok) values ('Falta pagar sin cuenta: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Falta pagar sin cuenta: rechazado', sqlerrm = 'falta_pagar', sqlerrm); end;
  begin
    perform vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[{"medio":"efectivo","monto":5000}]'::jsonb);
    insert into resultados (caso, ok) values ('Pago de más: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Pago de más: rechazado', sqlerrm = 'pago_de_mas', sqlerrm); end;
  begin
    perform vender('cprueba-most', jsonb_build_array(jsonb_build_object('producto_id', v_agua, 'cantidad', 1)), '[]'::jsonb, -5000);
    insert into resultados (caso, ok) values ('Descuento mayor al total: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Descuento mayor al total: rechazado', sqlerrm = 'ajuste_invalido', sqlerrm); end;

  -- El empleado no ve costos ni anula
  select count(*) into n from venta_items_costo;
  insert into resultados (caso, ok, detalle) values ('El empleado no ve los costos', n = 0, n::text);
  select count(*) into n from producto_costos;
  insert into resultados (caso, ok, detalle) values ('El empleado no ve el costo de los productos', n = 0, n::text);
  begin
    perform anular_venta((select valor::uuid from ids where clave = 'venta1'));
    insert into resultados (caso, ok) values ('El empleado no anula ventas', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El empleado no anula ventas', sqlerrm = 'no_autorizado', sqlerrm); end;
  begin
    insert into ventas (complejo_id, subtotal, total) values ('cprueba-most', 1, 1);
    insert into resultados (caso, ok) values ('No se cargan ventas a mano', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No se cargan ventas a mano', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) El dueño ve la ganancia y anula la venta de la seña
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_cuenta uuid := (select valor::uuid from ids where clave = 'cuenta');
  g numeric;
begin
  select sum(i.cantidad * (i.precio_unitario - c.costo_unitario)) into g
    from venta_items i join venta_items_costo c on c.item_id = i.id
   where i.venta_id = (select valor::uuid from ids where clave = 'venta1');
  insert into resultados (caso, ok, detalle) values ('El dueño ve la ganancia de las aguas (2 x 1.000)', g = 2000, g::text);
  perform anular_venta((select valor::uuid from ids where clave = 'venta3'));
  insert into resultados (caso, ok, detalle) values ('Anulada: la paleta vuelve al stock', (select stock from productos where id = (select valor::uuid from ids where clave = 'paleta')) = 1, null);
  insert into resultados (caso, ok, detalle) values ('Anulada: la cuenta ya no debe',
    (select consumido - pagado from cuentas_con_saldo('cprueba-most') x where x.id = v_cuenta) = 0, null);
  insert into resultados (caso, ok, detalle) values ('Anulada: queda marcada', (select anulada from ventas where id = (select valor::uuid from ids where clave = 'venta3')), null);
end $$;

-- 3) Alguien sin permiso no vende
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
do $$
begin
  perform vender('cprueba-most', '[{"descripcion":"x","precio":1,"cantidad":1}]'::jsonb, '[{"medio":"efectivo","monto":1}]'::jsonb);
  insert into resultados (caso, ok) values ('Sin permiso: no vende', false);
exception when others then
  insert into resultados (caso, ok, detalle) values ('Sin permiso: no vende', sqlerrm = 'no_autorizado', sqlerrm);
end $$;

reset role;
select n, ok, caso, detalle from resultados order by n;
rollback;
