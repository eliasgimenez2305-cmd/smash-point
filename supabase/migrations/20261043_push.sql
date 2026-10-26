-- Notificaciones push al celular (paso 5): cada aviso de la campanita (ver 20261042_avisos.sql) también
-- llega como notificación a los aparatos donde la persona tocó "Recibir avisos en este celular".
--
-- - push_suscripciones: los aparatos de cada cuenta (lo que da el navegador al aceptar los avisos).
--   Se guardan y se quitan con guardar_suscripcion() y quitar_suscripcion().
-- - Al anotarse un aviso, un disparador llama (con pg_net, sin esperar) a la función de Supabase
--   enviar-push (supabase/functions/enviar-push), que lo manda a esos aparatos.
-- - La dirección de la función y su clave se leen de Vault (Supabase > Project Settings > Vault):
--   secretos "push_url" y "push_secreto". Si no están, no se manda nada (la campanita sigue igual).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261042.

create table if not exists public.push_suscripciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  agente text,
  created_at timestamptz not null default now()
);
create index if not exists push_por_usuario on public.push_suscripciones (usuario_id);

alter table public.push_suscripciones enable row level security;
revoke all on public.push_suscripciones from public, anon, authenticated;
grant select, delete on public.push_suscripciones to authenticated;
drop policy if exists "Cada uno ve sus aparatos" on public.push_suscripciones;
create policy "Cada uno ve sus aparatos" on public.push_suscripciones for select to authenticated using (usuario_id = auth.uid());
drop policy if exists "Cada uno quita sus aparatos" on public.push_suscripciones;
create policy "Cada uno quita sus aparatos" on public.push_suscripciones for delete to authenticated using (usuario_id = auth.uid());

-- Guarda el aparato (si ese navegador ya estaba con otra cuenta, pasa a la cuenta actual)
create or replace function public.guardar_suscripcion(p_endpoint text, p_p256dh text, p_auth text, p_agente text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sin_sesion';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'datos_invalidos';
  end if;
  insert into push_suscripciones (usuario_id, endpoint, p256dh, auth, agente)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_agente, 200))
  on conflict (endpoint) do update set usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, agente = excluded.agente;
end;
$$;
revoke all on function public.guardar_suscripcion(text, text, text, text) from public, anon;
grant execute on function public.guardar_suscripcion(text, text, text, text) to authenticated;

create or replace function public.quitar_suscripcion(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from push_suscripciones where endpoint = p_endpoint and usuario_id = auth.uid();
$$;
revoke all on function public.quitar_suscripcion(text) from public, anon;
grant execute on function public.quitar_suscripcion(text) to authenticated;

-- Aviso nuevo → la función enviar-push (sin esperar la respuesta; si falla, el aviso queda igual)
create extension if not exists pg_net;

create or replace function public.push_aviso()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secreto text;
begin
  begin
    if not exists (select 1 from push_suscripciones where usuario_id = new.usuario_id) then
      return new;
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'push_url';
    select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'push_secreto';
    if v_url is null or v_secreto is null then
      return new;
    end if;
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secreto', v_secreto)
    );
  exception when others then
    raise warning 'push no enviada: %', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists push_aviso on public.notificaciones;
create trigger push_aviso after insert on public.notificaciones
  for each row execute function public.push_aviso();

-- Vuelta atrás (si hiciera falta):
--   drop trigger if exists push_aviso on public.notificaciones;
--   drop function if exists public.push_aviso(), public.quitar_suscripcion(text), public.guardar_suscripcion(text, text, text, text);
--   drop table if exists public.push_suscripciones;
