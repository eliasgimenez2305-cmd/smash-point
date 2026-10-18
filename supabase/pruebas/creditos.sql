-- Pruebas de 20261036_creditos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración.
-- Todo se deshace al final (no queda nada guardado). Resultado: una fila por caso con "ok" true/false.

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('creador', (select id::text from organizers where username = 'creador-prueba'));
insert into ids values ('org', (select id::text from organizers where username = 'organizador-prueba'));

-- El creador pone al organizador en modo Por torneo y le carga 1 crédito de torneo y 1 corto
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'creador'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_cli uuid;
begin
  insert into plataforma_clientes (tipo, ref_id, nombre, modo) select 'organizador', valor, 'Organizador por torneo', 'por_torneo' from ids where clave = 'org' returning id into v_cli;
  insert into ids values ('cli', v_cli::text);
  insert into plataforma_creditos (cliente_id, tipo) values (v_cli, 'torneo'), (v_cli, 'corto');
  insert into resultados (caso, ok, detalle) values ('Los planes sugeridos por torneo existen',
    exists (select 1 from plataforma_planes where tipo_cobro = 'por_torneo' and precio = 25000) and exists (select 1 from plataforma_planes where tipo_cobro = 'por_torneo_corto' and precio = 8000), null);
  insert into resultados (caso, ok, detalle) values ('Estado "Por torneo" (no vence)', (select plan_estado(c) from plataforma_clientes c where id = v_cli) = 'por_torneo', null);
end $$;

-- El organizador
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'org'), 'role', 'authenticated')::text, true);
do $$
declare
  j jsonb;
  r record;
  v_org text := (select valor from ids where clave = 'org');
  t_am jsonb := jsonb_build_object('id', 'tcred-am', 'name', 'Americano', 'organizerId', v_org, 'type', 'americano', 'categories', '[]'::jsonb);
  t_c1 jsonb := jsonb_build_object('id', 'tcred-c1', 'name', 'Clásico 1', 'organizerId', v_org, 'type', 'clasico', 'categories', '[]'::jsonb);
  t_c2 jsonb := jsonb_build_object('id', 'tcred-c2', 'name', 'Clásico 2', 'organizerId', v_org, 'type', 'clasico', 'categories', '[]'::jsonb);
  rev_de text := 'select rev from torneos where id = $1';
begin
  -- Crear oculto no gasta
  perform guardar_torneo(t_am || '{"publico": false}', 0, null);
  perform guardar_torneo(t_c1 || '{"publico": false}', 0, null);
  perform guardar_torneo(t_c2 || '{"publico": false}', 0, null);
  insert into resultados (caso, ok, detalle) values ('Crear torneos ocultos no gasta créditos',
    (select creditos_torneo = 1 and creditos_corto = 1 from mi_plan() x where x.tipo = 'organizador'), null);

  -- Publicar el Americano usa el crédito corto
  j := guardar_torneo(t_am || '{"publico": true}', (select rev from torneos where id = 'tcred-am'), null);
  select * into r from mi_plan() x where x.tipo = 'organizador';
  insert into resultados (caso, ok, detalle) values ('Publicar un Americano usa el crédito corto', r.creditos_corto = 0 and r.creditos_torneo = 1 and 'tcred-am' = any(r.torneos_pagados), r.creditos_torneo || '/' || r.creditos_corto);

  -- Publicar un Clásico usa el de torneo
  j := guardar_torneo(t_c1 || '{"publico": true}', (select rev from torneos where id = 'tcred-c1'), null);
  insert into resultados (caso, ok, detalle) values ('Publicar un Clásico usa el crédito de torneo', (select creditos_torneo = 0 from mi_plan() x where x.tipo = 'organizador'), null);

  -- Sin créditos no se publica
  begin
    j := guardar_torneo(t_c2 || '{"publico": true}', (select rev from torneos where id = 'tcred-c2'), null);
    insert into resultados (caso, ok) values ('Sin créditos no se publica', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Sin créditos no se publica', sqlerrm = 'sin_creditos', sqlerrm); end;

  -- Ocultar y volver a publicar uno ya pagado no gasta otro
  j := guardar_torneo(t_c1 || '{"publico": false}', (select rev from torneos where id = 'tcred-c1'), null);
  j := guardar_torneo(t_c1 || '{"publico": true}', (select rev from torneos where id = 'tcred-c1'), null);
  insert into resultados (caso, ok, detalle) values ('Ocultar y volver a publicar uno pagado no gasta', j->>'estado' = 'ok', j::text);

  -- Cargar resultados de un torneo publicado no gasta
  j := guardar_torneo(t_c1 || '{"publico": true, "name": "Clásico 1 (cambio)"}', (select rev from torneos where id = 'tcred-c1'), null);
  insert into resultados (caso, ok, detalle) values ('Editar un torneo ya publicado no gasta', j->>'estado' = 'ok', j::text);

  -- El organizador no ve ni toca los créditos directo
  begin
    insert into plataforma_creditos (cliente_id, tipo) values ((select valor::uuid from ids where clave = 'cli'), 'torneo');
    insert into resultados (caso, ok) values ('El organizador no se carga créditos', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('El organizador no se carga créditos', sqlstate = '42501', sqlerrm); end;
end $$;

-- Un organizador sin modo Por torneo publica libre
reset role;
update plataforma_clientes set modo = 'bonificado' where id = (select valor::uuid from ids where clave = 'cli');
set local role authenticated;
do $$
declare j jsonb;
begin
  j := guardar_torneo(jsonb_build_object('id', 'tcred-c2', 'name', 'Clásico 2', 'organizerId', (select valor from ids where clave = 'org'), 'type', 'clasico', 'publico', true, 'categories', '[]'::jsonb), (select rev from torneos where id = 'tcred-c2'), null);
  insert into resultados (caso, ok, detalle) values ('Con plan bonificado se publica sin créditos', j->>'estado' = 'ok', j::text);
end $$;

reset role;
select n, ok, caso, detalle from resultados order by n;
rollback;
