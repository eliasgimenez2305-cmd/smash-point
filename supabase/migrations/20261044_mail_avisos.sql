-- Avisos por mail (paso 6): si un pedido de turno o la cancelación de un turno por el jugador sigue
-- SIN LEER a los 15 minutos, le llega un mail a quien lo recibió en la campanita (ver 20261042_avisos.sql).
--
-- - El mail NO es el de entrar (los de los organizadores pueden ser inventados): cada uno carga un
--   "mail para recibir avisos" aparte (tabla mail_avisos) y recién se usa cuando lo confirma tocando
--   el link del mail de confirmación. Se puede pausar o borrar.
-- - Los mails los manda la función enviar-mail (supabase/functions/enviar-mail), llamada con pg_net.
--   Usa los secretos de Vault "mail_url" (dirección de la función) y "push_secreto" (la misma clave
--   que ya usa enviar-push). Si faltan, no se manda nada.
-- - Tarea programada cada 5 minutos: 'smashpoint-mails'.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261043.

create table if not exists public.mail_avisos (
  usuario_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  confirmado_at timestamptz,
  token uuid,
  pedido_at timestamptz not null default now(),
  pausado boolean not null default false
);
alter table public.mail_avisos enable row level security;
revoke all on public.mail_avisos from public, anon, authenticated;

alter table public.notificaciones add column if not exists mail_at timestamptz;

-- Llamada a enviar-mail (sin esperar respuesta)
create or replace function public._llamar_enviar_mail(p_cuerpo jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secreto text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'mail_url';
  select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'push_secreto';
  if v_url is null or v_secreto is null then
    return false;
  end if;
  perform net.http_post(
    url := v_url,
    body := p_cuerpo,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secreto', v_secreto)
  );
  return true;
end;
$$;
revoke all on function public._llamar_enviar_mail(jsonb) from public, anon, authenticated;

-- Mi mail de avisos: {email, confirmado, pausado} o null
create or replace function public.mi_mail_avisos()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('email', email, 'confirmado', confirmado_at is not null, 'pausado', pausado)
  from mail_avisos where usuario_id = auth.uid();
$$;
revoke all on function public.mi_mail_avisos() from public, anon;
grant execute on function public.mi_mail_avisos() to authenticated;

-- Cargar (o cambiar, o reenviar) el mail: queda sin confirmar y sale el mail con el link
create or replace function public.pedir_mail_avisos(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_ultimo timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sin_sesion';
  end if;
  if v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'mail_invalido';
  end if;
  select pedido_at into v_ultimo from mail_avisos where usuario_id = auth.uid() and confirmado_at is null;
  if v_ultimo is not null and v_ultimo > now() - interval '1 minute' then
    raise exception 'esperar';
  end if;
  insert into mail_avisos (usuario_id, email, confirmado_at, token, pedido_at, pausado)
  values (auth.uid(), v_email, null, gen_random_uuid(), now(), false)
  on conflict (usuario_id) do update set email = excluded.email, confirmado_at = null, token = excluded.token, pedido_at = now(), pausado = false;
  if not _llamar_enviar_mail(jsonb_build_object('tipo', 'confirmar', 'usuario', auth.uid())) then
    raise exception 'mail_no_configurado';
  end if;
end;
$$;
revoke all on function public.pedir_mail_avisos(text) from public, anon;
grant execute on function public.pedir_mail_avisos(text) to authenticated;

-- Link del mail de confirmación (anda sin sesión; el link vence a los 2 días)
create or replace function public.confirmar_mail_avisos(p_token uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  update mail_avisos set confirmado_at = now(), token = null
  where token = p_token and pedido_at > now() - interval '2 days'
  returning email into v_email;
  if v_email is null then
    raise exception 'link_vencido';
  end if;
  return v_email;
end;
$$;
revoke all on function public.confirmar_mail_avisos(uuid) from public;
grant execute on function public.confirmar_mail_avisos(uuid) to anon, authenticated;

create or replace function public.pausar_mail_avisos(p_pausado boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update mail_avisos set pausado = coalesce(p_pausado, false) where usuario_id = auth.uid();
$$;
revoke all on function public.pausar_mail_avisos(boolean) from public, anon;
grant execute on function public.pausar_mail_avisos(boolean) to authenticated;

create or replace function public.quitar_mail_avisos()
returns void
language sql
security definer
set search_path = public
as $$
  delete from mail_avisos where usuario_id = auth.uid();
$$;
revoke all on function public.quitar_mail_avisos() from public, anon;
grant execute on function public.quitar_mail_avisos() to authenticated;

-- Cada 5 minutos: pedidos de turno y cancelaciones del jugador sin leer hace 15 minutos o más
-- (y de menos de un día), a quien tenga el mail confirmado y sin pausar. Cada aviso, un solo mail.
create or replace function public.mandar_mails_pendientes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n record;
  v_total integer := 0;
begin
  for n in
    select a.id from notificaciones a
    join mail_avisos m on m.usuario_id = a.usuario_id and m.confirmado_at is not null and not m.pausado
    where a.tipo in ('turno_pedido', 'turno_cancelado_jugador')
      and a.leida_at is null and a.mail_at is null
      and a.creada_at <= now() - interval '15 minutes'
      and a.creada_at > now() - interval '1 day'
    order by a.creada_at
    limit 50
  loop
    exit when not _llamar_enviar_mail(jsonb_build_object('tipo', 'aviso', 'id', n.id));
    update notificaciones set mail_at = now() where id = n.id;
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$;
revoke all on function public.mandar_mails_pendientes() from public, anon, authenticated;

select cron.unschedule('smashpoint-mails') where exists (select 1 from cron.job where jobname = 'smashpoint-mails');
select cron.schedule('smashpoint-mails', '*/5 * * * *', 'select public.mandar_mails_pendientes()');

-- Vuelta atrás (si hiciera falta):
--   select cron.unschedule('smashpoint-mails');
--   drop function if exists public.mandar_mails_pendientes(), public.quitar_mail_avisos(), public.pausar_mail_avisos(boolean),
--     public.confirmar_mail_avisos(uuid), public.pedir_mail_avisos(text), public.mi_mail_avisos(), public._llamar_enviar_mail(jsonb);
--   alter table public.notificaciones drop column if exists mail_at;
--   drop table if exists public.mail_avisos;
