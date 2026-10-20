-- Cuentas de jugador con teléfono y contraseña (el código para crear la cuenta o recuperar la
-- contraseña llega por SMS o WhatsApp; lo manda Supabase Auth con el proveedor configurado).
-- Al crear la cuenta, el jugador reclama su perfil (ver 20261038_perfiles_jugador.sql): si un
-- organizador ya lo había anotado con ese teléfono, hereda sus torneos y puntos.
--
-- - mis_perfiles_por_telefono(): los perfiles sin cuenta que tienen el teléfono de MI cuenta.
-- - completar_cuenta(): engancha el perfil elegido (o crea uno) a mi cuenta y guarda mis datos en
--   jugadores (los que usan las reservas).
-- Las dos usan solo el teléfono ya verificado con el código (auth.users.phone_confirmed_at): nadie
-- puede reclamar un perfil ajeno escribiendo un número.
--
-- En Supabase > Authentication > Sign In / Providers > Phone: activar el teléfono y elegir el
-- proveedor (Twilio, con el canal de WhatsApp). En PRUEBA alcanza con números de prueba (Test OTP).
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261039.

-- El teléfono verificado de la cuenta que llama (null si no tiene o no lo verificó)
create or replace function public._mi_telefono()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.phone from auth.users u
   where u.id = auth.uid() and u.phone is not null and u.phone <> '' and u.phone_confirmed_at is not null;
$$;
revoke all on function public._mi_telefono() from public, anon, authenticated;

create or replace function public.mis_perfiles_por_telefono()
returns table (id uuid, apellido text, nombre text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.apellido, p.nombre
    from perfiles_jugador p
   where public._mi_telefono() is not null
     and p.telefono = public._mi_telefono()
     and p.cuenta_id is null
   order by p.created_at;
$$;
revoke all on function public.mis_perfiles_por_telefono() from public, anon;
grant execute on function public.mis_perfiles_por_telefono() to authenticated;

-- p_perfil: el perfil que eligió ("soy yo"), o null si es nuevo. Devuelve sus datos de jugador.
create or replace function public.completar_cuenta(p_perfil uuid, p_apellido text, p_nombre text, p_fecha_nacimiento date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel text := public._mi_telefono();
  v_perfil perfiles_jugador%rowtype;
  v_apellido text := btrim(regexp_replace(coalesce(p_apellido, ''), '\s+', ' ', 'g'));
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_jugador jugadores%rowtype;
begin
  if auth.uid() is null or v_tel is null then
    raise exception 'sin_telefono';
  end if;
  if v_tel !~ '^549[0-9]{10}$' then
    raise exception 'telefono_invalido';
  end if;

  -- Si ya tengo perfil, no se reclama otro (se actualizan los datos)
  select * into v_perfil from perfiles_jugador where cuenta_id = auth.uid();
  if not found and p_perfil is not null then
    select * into v_perfil from perfiles_jugador
     where id = p_perfil and telefono = v_tel and cuenta_id is null
     for update;
    if not found then
      raise exception 'perfil_invalido';
    end if;
  end if;

  -- Nombre: el que escribe; si eligió un perfil y no escribió, el del perfil
  if v_apellido = '' then v_apellido := coalesce(v_perfil.apellido, ''); end if;
  if v_nombre = '' then v_nombre := coalesce(v_perfil.nombre, ''); end if;
  if char_length(v_apellido) not between 1 and 40 or char_length(v_nombre) not between 1 and 40 then
    raise exception 'datos_invalidos';
  end if;

  if v_perfil.id is null then
    insert into perfiles_jugador (apellido, nombre, telefono, cuenta_id, creado_por)
    values (v_apellido, v_nombre, v_tel, auth.uid(), auth.uid())
    returning * into v_perfil;
  else
    update perfiles_jugador set cuenta_id = auth.uid(), apellido = v_apellido, nombre = v_nombre
     where id = v_perfil.id
    returning * into v_perfil;
  end if;

  insert into jugadores (id, nombre, apellido, telefono, fecha_nacimiento)
  values (auth.uid(), v_nombre, v_apellido, v_tel, p_fecha_nacimiento)
  on conflict (id) do update set nombre = excluded.nombre, apellido = excluded.apellido,
    telefono = excluded.telefono, fecha_nacimiento = coalesce(excluded.fecha_nacimiento, jugadores.fecha_nacimiento)
  returning * into v_jugador;

  return to_jsonb(v_jugador) || jsonb_build_object('perfil_id', v_perfil.id);
end;
$$;
revoke all on function public.completar_cuenta(uuid, text, text, date) from public, anon;
grant execute on function public.completar_cuenta(uuid, text, text, date) to authenticated;

-- Vuelta atrás (si hiciera falta):
--   drop function if exists public.completar_cuenta(uuid, text, text, date), public.mis_perfiles_por_telefono(), public._mi_telefono();
