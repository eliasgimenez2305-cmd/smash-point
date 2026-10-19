-- Funciones en prueba: secciones que se publican apagadas y el creador prende desde su panel
-- (Funciones) cuando terminó de probarlas. Apagadas, no se ven en la app y la base no las acepta:
--
-- - reservas: turnos y reservas online (pedir_turno), clases (cuotas y pagos a profes).
-- - cuentas:  empleados de los complejos (no entran al panel ni se cargan nuevos). Las cuentas de
--             jugadores se cierran además con "Allow new users to sign up" apagado en Supabase.
-- - cantina:  mostrador, cuentas (fiado), productos, compras, caja del dueño y caja del día.
--
-- Las tres arrancan apagadas. En PRUEBA se prenden al final de este archivo para seguir probando.
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261036.

create table if not exists public.funciones (
  clave text primary key check (clave in ('reservas', 'cuentas', 'cantina')),
  activa boolean not null default false,
  cambiada_at timestamptz not null default now(),
  cambiada_por uuid
);
insert into public.funciones (clave) values ('reservas'), ('cuentas'), ('cantina') on conflict (clave) do nothing;

alter table public.funciones enable row level security;
revoke all on public.funciones from public, anon, authenticated;
grant select on public.funciones to anon, authenticated;
grant update (activa) on public.funciones to authenticated;

drop policy if exists "Todos ven las funciones" on public.funciones;
create policy "Todos ven las funciones" on public.funciones for select to anon, authenticated using (true);
drop policy if exists "El creador prende y apaga" on public.funciones;
create policy "El creador prende y apaga" on public.funciones for update to authenticated
  using (public.es_creador()) with check (public.es_creador());

-- Quién y cuándo lo cambió (lo fija la base)
create or replace function public.funciones_quien()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.cambiada_at := now();
  new.cambiada_por := auth.uid();
  return new;
end;
$$;
drop trigger if exists funciones_quien on public.funciones;
create trigger funciones_quien before update on public.funciones for each row execute function public.funciones_quien();

create or replace function public.funcion_activa(p_clave text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select activa from funciones where clave = p_clave), false);
$$;
revoke all on function public.funcion_activa(text) from public;
grant execute on function public.funcion_activa(text) to anon, authenticated;

-- ============================================================
-- Bloqueos: no se carga nada de una función apagada (error 'funcion_apagada')
-- ============================================================

create or replace function public.funcion_requerida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.funcion_activa(tg_argv[0]) then
    raise exception 'funcion_apagada';
  end if;
  return new;
end;
$$;

-- Reservas: turnos, bloqueos, pedidos online y clases
drop trigger if exists funcion_reservas on public.reservas;
create trigger funcion_reservas before insert on public.reservas for each row execute function public.funcion_requerida('reservas');
drop trigger if exists funcion_reservas on public.cuotas_alumnos;
create trigger funcion_reservas before insert on public.cuotas_alumnos for each row execute function public.funcion_requerida('reservas');
drop trigger if exists funcion_reservas on public.pagos_profes;
create trigger funcion_reservas before insert on public.pagos_profes for each row execute function public.funcion_requerida('reservas');

-- Empleados: no se cargan nuevos
drop trigger if exists funcion_cuentas on public.colaboradores;
create trigger funcion_cuentas before insert on public.colaboradores for each row execute function public.funcion_requerida('cuentas');

-- Cantina y caja
drop trigger if exists funcion_cantina on public.productos;
create trigger funcion_cantina before insert on public.productos for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.ventas;
create trigger funcion_cantina before insert on public.ventas for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.cuentas;
create trigger funcion_cantina before insert on public.cuentas for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.cuenta_consumos;
create trigger funcion_cantina before insert on public.cuenta_consumos for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.cuenta_pagos;
create trigger funcion_cantina before insert on public.cuenta_pagos for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.compras;
create trigger funcion_cantina before insert on public.compras for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.caja_turnos;
create trigger funcion_cantina before insert on public.caja_turnos for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.caja_movimientos;
create trigger funcion_cantina before insert on public.caja_movimientos for each row execute function public.funcion_requerida('cantina');
drop trigger if exists funcion_cantina on public.gastos_fijos;
create trigger funcion_cantina before insert on public.gastos_fijos for each row execute function public.funcion_requerida('cantina');

-- ============================================================
-- Empleados: con 'cuentas' apagada no tienen permisos ni ven complejos (misma definición que
-- 20261021_consumos.sql, más el chequeo de la función)
-- ============================================================

create or replace function public.colaborador_permiso(p_complejo text, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.funcion_activa('cuentas') and exists (
    select 1
    from colaboradores c
    join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
    join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email
    where c.complejo_id = p_complejo
      and case p_permiso
            when 'agenda' then c.p_agenda
            when 'canchas' then c.p_canchas
            when 'resultados' then c.p_resultados or c.p_torneos
            when 'torneos' then c.p_torneos
            when 'consumos' then c.p_consumos
            else false
          end
  );
$$;

create or replace function public.mis_complejos_colaborador()
returns table (complejo_id text, dueno_id uuid, p_agenda boolean, p_resultados boolean, p_torneos boolean, p_canchas boolean, p_consumos boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.complejo_id, x.dueno_id, c.p_agenda, c.p_resultados, c.p_torneos, c.p_canchas, c.p_consumos
  from colaboradores c
  join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
  join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email
  where public.funcion_activa('cuentas');
$$;

-- ============================================================
-- SOLO EN PRUEBA: prender todo para seguir probando. En el real NO correr esta línea (las funciones
-- se prenden desde el panel del creador cuando estén probadas).
-- ============================================================
-- update public.funciones set activa = true;

-- Vuelta atrás (si hiciera falta): volver a correr colaborador_permiso y mis_complejos_colaborador
-- de 20261021_consumos.sql, y
--   drop trigger if exists funcion_reservas on public.reservas;
--   drop trigger if exists funcion_reservas on public.cuotas_alumnos;
--   drop trigger if exists funcion_reservas on public.pagos_profes;
--   drop trigger if exists funcion_cuentas on public.colaboradores;
--   drop trigger if exists funcion_cantina on public.productos;  (y ventas, cuentas, cuenta_consumos,
--     cuenta_pagos, compras, caja_turnos, caja_movimientos, gastos_fijos)
--   drop function if exists public.funcion_requerida(), public.funcion_activa(text), public.funciones_quien();
--   drop table if exists public.funciones;
