-- Reserva de canchas, etapa 3: colaboradores (empleados) del complejo.
-- Necesita 20261014_reservas_canchas.sql y 20261015_reservas_jugadores.sql.
--
-- El dueño agrega el mail del empleado. El empleado entra con el mismo código por mail que los
-- jugadores (sin contraseña ni cuenta creada a mano); si su mail confirmado está en la lista de un
-- complejo con Reservas habilitadas, maneja la agenda de ese complejo igual que el dueño: carga,
-- confirma, rechaza y cancela turnos, bloquea horarios, marca "no vino" y registra el cobro. No toca
-- canchas, horarios ni precios, ni la lista de colaboradores, ni bloquea jugadores, ni torneos.
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

-- El colaborador maneja las reservas de su complejo como el dueño (mismas reglas: los turnos no se
-- borran, se cancelan; los bloqueos sí se pueden borrar)
drop policy if exists "El colaborador ve las reservas" on public.reservas;
create policy "El colaborador ve las reservas" on public.reservas for select to authenticated using (public.es_colaborador(complejo_id));
drop policy if exists "El colaborador carga reservas" on public.reservas;
create policy "El colaborador carga reservas" on public.reservas for insert to authenticated with check (public.es_colaborador(complejo_id));
drop policy if exists "El colaborador cambia reservas" on public.reservas;
create policy "El colaborador cambia reservas" on public.reservas for update to authenticated
  using (public.es_colaborador(complejo_id)) with check (public.es_colaborador(complejo_id));
drop policy if exists "El colaborador borra bloqueos" on public.reservas;
create policy "El colaborador borra bloqueos" on public.reservas for delete to authenticated
  using (public.es_colaborador(complejo_id) and tipo = 'bloqueo');
