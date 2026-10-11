-- Reserva de canchas, etapa 3: colaboradores (empleados) del complejo.
-- Necesita 20261014_reservas_canchas.sql y 20261015_reservas_jugadores.sql.
--
-- El dueño agrega el mail del empleado. El empleado entra con el mismo código por mail que los
-- jugadores (sin contraseña ni cuenta creada a mano); si su mail confirmado está en la lista de un
-- complejo con Reservas habilitadas, ve la agenda de ese complejo. Puede confirmar o rechazar
-- pedidos y registrar el cobro (efectivo o Mercado Pago), siempre por colaborador_reserva(), que
-- controla qué puede cambiar. No toca canchas, precios, perfil ni torneos.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create table if not exists public.colaboradores (
  complejo_id text not null references public.complejos(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nombre text check (nombre is null or char_length(btrim(nombre)) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (complejo_id, email)
);

-- ¿El usuario logueado es colaborador de este complejo? Se usa el mail confirmado de su cuenta
-- (el que validó con el código), no lo que diga el navegador.
create or replace function public.es_colaborador(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from colaboradores c
    join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
    join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email
    where c.complejo_id = p_complejo
  );
$$;

revoke all on function public.es_colaborador(text) from public, anon;
grant execute on function public.es_colaborador(text) to authenticated;

-- Complejos donde el usuario logueado es colaborador (para armar su panel)
create or replace function public.mis_complejos_colaborador()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select c.complejo_id
  from colaboradores c
  join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
  join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email;
$$;

revoke all on function public.mis_complejos_colaborador() from public, anon;
grant execute on function public.mis_complejos_colaborador() to authenticated;

alter table public.colaboradores enable row level security;
revoke all on public.colaboradores from public, anon, authenticated;
grant select, insert, update, delete on public.colaboradores to authenticated;

drop policy if exists "El dueño ve sus colaboradores" on public.colaboradores;
create policy "El dueño ve sus colaboradores" on public.colaboradores for select to authenticated using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño agrega colaboradores" on public.colaboradores;
create policy "El dueño agrega colaboradores" on public.colaboradores for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia colaboradores" on public.colaboradores;
create policy "El dueño cambia colaboradores" on public.colaboradores for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño quita colaboradores" on public.colaboradores;
create policy "El dueño quita colaboradores" on public.colaboradores for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- El colaborador ve las reservas de su complejo (no las puede cambiar directo)
drop policy if exists "El colaborador ve las reservas" on public.reservas;
create policy "El colaborador ve las reservas" on public.reservas for select to authenticated using (public.es_colaborador(complejo_id));

-- Lo que puede hacer el colaborador con una reserva (el dueño también puede usarla):
--   'confirmar' / 'rechazar' un pedido pendiente; 'cobro' en un turno confirmado (p_medio:
--   'efectivo', 'mercado_pago' o null = sin cobrar). Devuelve 'ok' o corta con no_autorizado,
--   no_encontrada, estado_invalido o datos_invalidos.
create or replace function public.colaborador_reserva(p_id uuid, p_accion text, p_medio text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r reservas%rowtype;
begin
  select * into v_r from reservas where id = p_id for update;
  if not found then
    raise exception 'no_encontrada';
  end if;
  if not (public.es_colaborador(v_r.complejo_id) or public.es_dueno_complejo(v_r.complejo_id)) then
    raise exception 'no_autorizado';
  end if;
  if v_r.tipo <> 'turno' then
    raise exception 'estado_invalido';
  end if;

  if p_accion in ('confirmar', 'rechazar') then
    if v_r.estado <> 'pendiente' then
      raise exception 'estado_invalido';
    end if;
    update reservas set estado = case when p_accion = 'confirmar' then 'confirmada' else 'rechazada' end where id = p_id;
  elsif p_accion = 'cobro' then
    if v_r.estado <> 'confirmada' then
      raise exception 'estado_invalido';
    end if;
    if p_medio is not null and p_medio not in ('efectivo', 'mercado_pago') then
      raise exception 'datos_invalidos';
    end if;
    update reservas set medio_pago = p_medio where id = p_id;
  else
    raise exception 'datos_invalidos';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.colaborador_reserva(uuid, text, text) from public, anon;
grant execute on function public.colaborador_reserva(uuid, text, text) to authenticated;
