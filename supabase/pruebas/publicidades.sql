-- Pruebas de 20261035_publicidades.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('creador', (select id::text from organizers where username = 'creador-prueba'));
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));
insert into ids values ('hoy', (now() at time zone 'America/Argentina/Buenos_Aires')::date::text);

-- Tres anunciantes: uno al día, uno vencido hace 20 días y uno dado de baja
insert into plataforma_clientes (tipo, ref_id, nombre, modo, vence) values
  ('publicidad', 'ad-aldia', 'Al día', 'prueba', (select valor::date from ids where clave = 'hoy') + 20),
  ('publicidad', 'ad-vencida', 'Vencida', 'prueba', (select valor::date from ids where clave = 'hoy') - 20);
insert into plataforma_clientes (tipo, ref_id, nombre, modo, activo) values ('publicidad', 'ad-baja', 'De baja', 'bonificado', false);

-- 1) El público: qué se oculta, y cada clic queda anotado
set local role anon;
do $$
declare v text[];
begin
  select array_agg(x) into v from publicidades_ocultas() x where x like 'ad-%';
  insert into resultados (caso, ok, detalle) values ('Se ocultan la vencida y la dada de baja (no la que está al día)',
    'ad-vencida' = any(v) and 'ad-baja' = any(v) and not ('ad-aldia' = any(v)), array_to_string(v, ','));
  perform contar_clic('ad-aldia');
  perform contar_clic('ad-aldia');
  perform contar_clic('');
  perform contar_clic(repeat('x', 80));
  insert into resultados (caso, ok) values ('Sin sesión se pueden contar clics (los ids raros se ignoran)', true);
  begin
    perform 1 from publicidad_clics limit 1;
    insert into resultados (caso, ok) values ('El público no lee la tabla de clics', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El público no lee la tabla de clics', sqlstate = '42501', sqlerrm); end;
end $$;

-- 2) El creador ve los números
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from clics_publicidades((select valor::date from ids where clave = 'hoy')) x where x.ad_id = 'ad-aldia';
  insert into resultados (caso, ok, detalle) values ('El creador ve 2 clics de la que está al día (en total y desde hoy)', r.total = 2 and r.desde = 2, r.total || ' / ' || r.desde);
end $$;

-- 3) Un organizador no ve los clics
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  begin
    perform clics_publicidades(current_date);
    insert into resultados (caso, ok) values ('Un organizador no ve los números de clics', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Un organizador no ve los números de clics', sqlerrm = 'no_autorizado', sqlerrm); end;
  select count(*) into n from publicidad_clics;
  insert into resultados (caso, ok, detalle) values ('Ni lee la tabla de clics', n = 0, n::text);
end $$;

-- 4) Al cobrarle a la vencida, vuelve a mostrarse
reset role;
insert into plataforma_movimientos (tipo, cliente_id, periodo, concepto, monto, medio, fecha)
select 'ingreso', id, to_char((select valor::date from ids where clave = 'hoy'), 'YYYY-MM'), 'Cuota', 15000, 'transferencia', (select valor::date from ids where clave = 'hoy')
from plataforma_clientes where ref_id = 'ad-vencida';
insert into resultados (caso, ok, detalle) values ('Al cobrarle la cuota del mes, la vencida vuelve a mostrarse',
  not exists (select 1 from publicidades_ocultas() x where x = 'ad-vencida'),
  (select modo || ' / ' || coalesce(pagado_hasta, '-') from plataforma_clientes where ref_id = 'ad-vencida'));

select n, ok, caso, detalle from resultados order by n;
rollback;
