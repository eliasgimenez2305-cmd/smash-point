-- Planes, etapa 2: la app respeta el plan de cada organizador y complejo (ver 20261033_planes.sql).
--
-- - plan_estado(): el mismo cálculo que src/planes.js (al día, prueba, bonificado, por vencer, en gracia,
--   vencido, suspendido, baja).
-- - plan_bloqueado(tipo, ref): hay un cliente activo de la plataforma para ese organizador o complejo y
--   está vencido (pasados los días de gracia) o suspendido. Quien no está cargado como cliente no se
--   bloquea (los que usan la app sin plan siguen libres).
-- - mi_plan(): cada organizador o empleado lee el plan de su cuenta y de sus complejos (para los carteles).
-- - cuentas_suspendidas(): los ids de organizadores y complejos suspendidos (la página pública los oculta).
-- - Bloqueos en la base, con el error 'plan_vencido':
--     organizador: no crea torneos nuevos ni recibe inscripciones online (los torneos que ya tiene se
--       siguen jugando: resultados, horarios y llaves no se tocan);
--     complejo: no carga turnos ni toma reservas online, no vende, no anota consumos, no abre caja ni
--       registra compras (lo que ya está se puede ver).
--   El creador nunca queda bloqueado.
-- - Tope de empleados del plan del complejo: 'tope_empleados'.
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261033_planes.sql.
-- Prueba: supabase/pruebas/planes_en_la_app.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

create or replace function public.plan_estado(c public.plataforma_clientes)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_fin date;
  v_base text := case c.modo when 'prueba' then 'prueba' when 'bonificado' then 'bonificado' else 'al_dia' end;
begin
  if not c.activo then return 'baja'; end if;
  if c.suspendido then return 'suspendido'; end if;
  if c.modo in ('prueba', 'bonificado') then
    v_fin := c.vence;
  elsif c.pagado_hasta is not null then
    v_fin := ((c.pagado_hasta || '-01')::date + interval '1 month' - interval '1 day')::date;
  elsif c.cuota_mensual is null then
    v_fin := null;
  else
    v_fin := (c.desde || '-01')::date - 1;
  end if;
  if v_fin is null then return v_base; end if;
  if v_hoy <= v_fin then
    return case when v_fin - v_hoy < 7 then 'por_vencer' else v_base end;
  end if;
  return case when v_hoy - v_fin <= c.dias_gracia then 'en_gracia' else 'vencido' end;
end;
$$;

create or replace function public.plan_fin(c public.plataforma_clientes)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when c.modo in ('prueba', 'bonificado') then c.vence
    when c.pagado_hasta is not null then ((c.pagado_hasta || '-01')::date + interval '1 month' - interval '1 day')::date
    when c.cuota_mensual is null then null
    else (c.desde || '-01')::date - 1
  end;
$$;

create or replace function public.plan_bloqueado(p_tipo text, p_ref text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_ref is not null and not public.es_creador() and exists (
    select 1 from plataforma_clientes c
    where c.tipo = p_tipo and c.ref_id = p_ref and c.activo and public.plan_estado(c) in ('vencido', 'suspendido')
  );
$$;

revoke all on function public.plan_bloqueado(text, text) from public;
grant execute on function public.plan_bloqueado(text, text) to anon, authenticated;

-- El plan de mi cuenta y de mis complejos (dueño o empleado)
create or replace function public.mi_plan()
returns table (tipo text, ref_id text, nombre text, estado text, fin date, dias_gracia int, modo text, plan_nombre text,
               modulo_torneos boolean, modulo_reservas boolean, modulo_cantina boolean, reportes boolean, empleados int)
language sql
stable
security definer
set search_path = public
as $$
  select c.tipo, c.ref_id, c.nombre, public.plan_estado(c), public.plan_fin(c), c.dias_gracia, c.modo, p.nombre,
         p.modulo_torneos, p.modulo_reservas, p.modulo_cantina, p.reportes, p.empleados
  from plataforma_clientes c
  left join plataforma_planes p on p.id = c.plan_id
  where c.activo and auth.uid() is not null and (
    (c.tipo = 'organizador' and c.ref_id = auth.uid()::text)
    or (c.tipo = 'complejo' and (
      c.ref_id in (select x.id from complejos x where x.dueno_id = auth.uid())
      or c.ref_id in (select m.complejo_id from public.mis_complejos_colaborador() m)
    ))
  );
$$;

revoke all on function public.mi_plan() from public, anon;
grant execute on function public.mi_plan() to authenticated;

-- Organizadores y complejos suspendidos: la página pública no los muestra
create or replace function public.cuentas_suspendidas()
returns table (tipo text, ref_id text)
language sql
stable
security definer
set search_path = public
as $$
  select c.tipo, c.ref_id from plataforma_clientes c
  where c.activo and c.suspendido and c.tipo in ('organizador', 'complejo') and c.ref_id is not null;
$$;

revoke all on function public.cuentas_suspendidas() from public;
grant execute on function public.cuentas_suspendidas() to anon, authenticated;

-- ============================================================
-- Bloqueos
-- ============================================================

-- Torneo nuevo de un organizador vencido o suspendido (guardar_torneo lo inserta)
create or replace function public.plan_torneo_nuevo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.plan_bloqueado('organizador', new.organizador_id::text) then
    raise exception 'plan_vencido';
  end if;
  return new;
end;
$$;
drop trigger if exists plan_torneo_nuevo on public.torneos;
create trigger plan_torneo_nuevo before insert on public.torneos
  for each row execute function public.plan_torneo_nuevo();

-- Inscripción online a un torneo de un organizador vencido o suspendido
create or replace function public.plan_inscripcion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.plan_bloqueado('organizador', new.organizador_id::text) then
    raise exception 'inscripciones_cerradas';
  end if;
  return new;
end;
$$;
drop trigger if exists plan_inscripcion on public.inscripciones;
create trigger plan_inscripcion before insert on public.inscripciones
  for each row execute function public.plan_inscripcion();

-- Lo que se carga en un complejo vencido o suspendido: turnos (y reservas online), ventas, consumos,
-- cajas y compras
create or replace function public.plan_complejo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.plan_bloqueado('complejo', new.complejo_id) then
    raise exception 'plan_vencido';
  end if;
  return new;
end;
$$;
drop trigger if exists plan_complejo on public.reservas;
create trigger plan_complejo before insert on public.reservas for each row execute function public.plan_complejo();
drop trigger if exists plan_complejo on public.ventas;
create trigger plan_complejo before insert on public.ventas for each row execute function public.plan_complejo();
drop trigger if exists plan_complejo on public.cuenta_consumos;
create trigger plan_complejo before insert on public.cuenta_consumos for each row execute function public.plan_complejo();
drop trigger if exists plan_complejo on public.caja_turnos;
create trigger plan_complejo before insert on public.caja_turnos for each row execute function public.plan_complejo();
drop trigger if exists plan_complejo on public.compras;
create trigger plan_complejo before insert on public.compras for each row execute function public.plan_complejo();

-- Tope de empleados del plan del complejo
create or replace function public.plan_tope_empleados()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tope int;
begin
  if public.es_creador() then return new; end if;
  select p.empleados into v_tope
  from plataforma_clientes c join plataforma_planes p on p.id = c.plan_id
  where c.tipo = 'complejo' and c.ref_id = new.complejo_id and c.activo
  limit 1;
  if v_tope is not null and (select count(*) from colaboradores where complejo_id = new.complejo_id) >= v_tope then
    raise exception 'tope_empleados';
  end if;
  return new;
end;
$$;
drop trigger if exists plan_tope_empleados on public.colaboradores;
create trigger plan_tope_empleados before insert on public.colaboradores
  for each row execute function public.plan_tope_empleados();

-- ============================================================
-- Vuelta atrás
-- ============================================================
--   drop trigger if exists plan_torneo_nuevo on public.torneos;
--   drop trigger if exists plan_inscripcion on public.inscripciones;
--   drop trigger if exists plan_complejo on public.reservas;
--   drop trigger if exists plan_complejo on public.ventas;
--   drop trigger if exists plan_complejo on public.cuenta_consumos;
--   drop trigger if exists plan_complejo on public.caja_turnos;
--   drop trigger if exists plan_complejo on public.compras;
--   drop trigger if exists plan_tope_empleados on public.colaboradores;
--   drop function if exists public.plan_torneo_nuevo(), public.plan_inscripcion(), public.plan_complejo(),
--     public.plan_tope_empleados(), public.cuentas_suspendidas(), public.mi_plan(),
--     public.plan_bloqueado(text, text), public.plan_fin(public.plataforma_clientes), public.plan_estado(public.plataforma_clientes);
