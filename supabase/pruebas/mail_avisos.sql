-- Pruebas de 20261044_mail_avisos.sql. Correr SOLO en el proyecto de PRUEBA, después de la migración
-- y con el secreto "mail_url" en Vault. Todo se deshace al final (los pedidos a enviar-mail también:
-- pg_net los manda recién cuando se confirma la transacción).

begin;

create temp table resultados (n serial, caso text, ok boolean, detalle text) on commit drop;
create temp table ids (clave text primary key, valor text) on commit drop;
grant all on resultados, ids to authenticated, anon;
grant usage on sequence resultados_n_seq to authenticated, anon;

insert into ids values ('a', gen_random_uuid()::text), ('b', gen_random_uuid()::text);
insert into auth.users (id, aud, role, email, created_at, updated_at)
select valor::uuid, 'authenticated', 'authenticated', clave || '@inventado.test', now(), now() from ids;

-- Como A
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  insert into resultados (caso, ok) values ('Sin mail cargado: mi_mail_avisos da null', mi_mail_avisos() is null);
  begin
    perform pedir_mail_avisos('no-es-un-mail');
    insert into resultados (caso, ok) values ('Rechaza un mail inválido', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Rechaza un mail inválido', sqlerrm = 'mail_invalido', sqlerrm); end;
  perform pedir_mail_avisos('  Organizador@Real.com ');
  insert into resultados (caso, ok, detalle) values ('Carga el mail sin confirmar (en minúscula)',
    mi_mail_avisos() = '{"email": "organizador@real.com", "confirmado": false, "pausado": false}'::jsonb, mi_mail_avisos()::text);
  begin
    perform pedir_mail_avisos('organizador@real.com');
    insert into resultados (caso, ok) values ('No deja pedir otro mail enseguida', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No deja pedir otro mail enseguida', sqlerrm = 'esperar', sqlerrm); end;
  begin
    perform 1 from mail_avisos;
    insert into resultados (caso, ok) values ('No puede leer la tabla directo (ni el token)', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('No puede leer la tabla directo (ni el token)', true, sqlerrm); end;
end $$;

-- Como B: no ve el mail de A
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'b'), 'role', 'authenticated')::text, true);
do $$
begin
  insert into resultados (caso, ok) values ('B no ve el mail de A', mi_mail_avisos() is null);
end $$;

-- Sin sesión: link equivocado y link bueno
reset role;
insert into ids select 'token', token::text from mail_avisos where usuario_id = (select valor::uuid from ids where clave = 'a');
set local role anon;
do $$
begin
  begin
    perform confirmar_mail_avisos(gen_random_uuid());
    insert into resultados (caso, ok) values ('Link equivocado: no confirma', false);
  exception when others then insert into resultados (caso, ok, detalle) values ('Link equivocado: no confirma', sqlerrm = 'link_vencido', sqlerrm); end;
  insert into resultados (caso, ok) values ('Link bueno: confirma sin sesión', confirmar_mail_avisos((select valor::uuid from ids where clave = 'token')) = 'organizador@real.com');
  begin
    perform confirmar_mail_avisos((select valor::uuid from ids where clave = 'token'));
    insert into resultados (caso, ok) values ('El link no se puede usar dos veces', false);
  exception when others then insert into resultados (caso, ok) values ('El link no se puede usar dos veces', true); end;
end $$;

-- Como A: pausar y reanudar
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select valor from ids where clave = 'a'), 'role', 'authenticated')::text, true);
do $$
begin
  perform pausar_mail_avisos(true);
  insert into resultados (caso, ok) values ('Pausa los mails', (mi_mail_avisos()->>'pausado')::boolean);
  perform pausar_mail_avisos(false);
  insert into resultados (caso, ok) values ('Confirmado y reanudado', mi_mail_avisos() = '{"email": "organizador@real.com", "confirmado": true, "pausado": false}'::jsonb);
end $$;
reset role;

-- Envío: solo pedidos y cancelaciones de turno sin leer hace 15 minutos o más, una sola vez
do $$
declare
  v_a uuid := (select valor::uuid from ids where clave = 'a');
  v_b uuid := (select valor::uuid from ids where clave = 'b');
begin
  insert into notificaciones (usuario_id, tipo, titulo, ref, creada_at, leida_at) values
    (v_a, 'turno_pedido', 'Pedido viejo', 'm1', now() - interval '20 minutes', null),
    (v_a, 'turno_cancelado_jugador', 'Cancelación vieja', 'm2', now() - interval '16 minutes', null),
    (v_a, 'turno_pedido', 'Pedido nuevo', 'm3', now() - interval '5 minutes', null),
    (v_a, 'turno_pedido', 'Pedido leído', 'm4', now() - interval '20 minutes', now()),
    (v_a, 'inscripcion_nueva', 'Inscripción', 'm5', now() - interval '20 minutes', null),
    (v_b, 'turno_pedido', 'Pedido de B sin mail', 'm6', now() - interval '20 minutes', null);
  perform mandar_mails_pendientes();
  insert into resultados (caso, ok, detalle) values ('Manda solo el pedido y la cancelación viejos sin leer de A',
    (select string_agg(ref, ',' order by ref) from notificaciones where mail_at is not null and usuario_id in (v_a, v_b)) = 'm1,m2',
    (select string_agg(ref, ',' order by ref) from notificaciones where mail_at is not null and usuario_id in (v_a, v_b)));
  perform mandar_mails_pendientes();
  insert into resultados (caso, ok) values ('No los vuelve a mandar',
    (select count(*) from notificaciones where mail_at is not null and usuario_id = v_a) = 2);
  update mail_avisos set pausado = true where usuario_id = v_a;
  update notificaciones set creada_at = now() - interval '20 minutes' where usuario_id = v_a and ref = 'm3';
  perform mandar_mails_pendientes();
  insert into resultados (caso, ok) values ('En pausa no manda', (select mail_at is null from notificaciones where usuario_id = v_a and ref = 'm3'));
end $$;

select count(*) as casos, bool_and(ok) as todo_ok, string_agg(case when not ok then caso || ' (' || coalesce(detalle, '') || ')' end, ' | ') as fallan, 'FIN_MAIL' as fin from resultados;
rollback;
