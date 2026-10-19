-- Pruebas de 20261033_planes.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated;
grant usage on sequence resultados_n_seq to authenticated;

insert into ids values ('creador', (select id::text from organizers where username = 'creador-prueba'));
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));

-- 1) El creador ve los planes sugeridos, carga un cliente en Prueba y le cobra una cuota
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_plan uuid;
  v_cli uuid;
  v_mov uuid;
  c record;
begin
  insert into resultados (caso, ok, detalle) values ('El creador ve los planes sugeridos (Full a 100.000)',
    exists (select 1 from plataforma_planes where nombre = 'Full' and precio = 100000 and modulo_torneos and modulo_reservas and modulo_cantina and empleados is null),
    (select string_agg(nombre, ', ' order by orden) from plataforma_planes));
  insert into plataforma_planes (nombre, para, precio, modulo_torneos) values ('Torneos anual', 'organizador', 450000, true) returning id into v_plan;
  update plataforma_planes set precio = 47000 where id = v_plan;
  insert into resultados (caso, ok) values ('El creador crea y cambia el precio de un plan', (select precio from plataforma_planes where id = v_plan) = 47000);

  insert into plataforma_clientes (tipo, nombre, cuota_mensual, plan_id, modo, vence, dias_gracia)
  values ('organizador', 'Club de prueba', 47000, v_plan, 'prueba', '2030-01-31', 5) returning id into v_cli;
  insert into plataforma_movimientos (tipo, cliente_id, periodo, concepto, monto, medio, fecha)
  values ('ingreso', v_cli, '2030-02', 'Cuota febrero', 47000, 'transferencia', '2030-02-03') returning id into v_mov;
  select * into c from plataforma_clientes where id = v_cli;
  insert into resultados (caso, ok, detalle) values ('Al cobrar la cuota: pagado hasta febrero y pasa de Prueba a Pago', c.pagado_hasta = '2030-02' and c.modo = 'pago', c.pagado_hasta || ' / ' || c.modo);

  insert into plataforma_movimientos (tipo, cliente_id, periodo, concepto, monto, medio, fecha)
  values ('ingreso', v_cli, '2030-03', 'Cuota marzo', 47000, 'efectivo', '2030-03-02');
  insert into resultados (caso, ok, detalle) values ('Otra cuota: pagado hasta marzo', (select pagado_hasta from plataforma_clientes where id = v_cli) = '2030-03', null);
  delete from plataforma_movimientos where cliente_id = v_cli and periodo = '2030-03';
  insert into resultados (caso, ok, detalle) values ('Si se borra el cobro de marzo, vuelve a febrero', (select pagado_hasta from plataforma_clientes where id = v_cli) = '2030-02', null);

  begin
    update plataforma_clientes set modo = 'gratis' where id = v_cli;
    insert into resultados (caso, ok) values ('Modo inválido: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Modo inválido: rechazado', sqlstate = '23514', sqlerrm); end;
  begin
    update plataforma_clientes set dias_gracia = 90 where id = v_cli;
    insert into resultados (caso, ok) values ('Más de 60 días de gracia: rechazado', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Más de 60 días de gracia: rechazado', sqlstate = '23514', sqlerrm); end;

  delete from plataforma_planes where id = v_plan;
  insert into resultados (caso, ok) values ('Borrar el plan deja al cliente sin plan (no se borra el cliente)', (select plan_id is null from plataforma_clientes where id = v_cli));
end $$;

-- 2) Un organizador no ve ni toca los planes
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from plataforma_planes;
  insert into resultados (caso, ok, detalle) values ('Un organizador no ve los planes', n = 0, n::text);
  update plataforma_planes set precio = 1;
  get diagnostics n = row_count;
  insert into resultados (caso, ok, detalle) values ('Un organizador no cambia precios', n = 0, n::text);
end $$;

reset role;
select n, ok, caso, detalle from resultados order by n;
rollback;
