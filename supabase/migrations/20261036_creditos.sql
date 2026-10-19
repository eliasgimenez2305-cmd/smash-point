-- Planes, etapa 4: pago por torneo. Un organizador en modo "Por torneo" no paga cuota: el creador le
-- carga créditos (cobrados o regalados) y cada torneo que publica usa uno.
--
-- - plataforma_planes.tipo_cobro: mensual (los planes de siempre), por_torneo (precio de un torneo
--   Clásico) o por_torneo_corto (Americano o Súper 8). Se suman sugeridos "Torneo suelto" y "Torneo corto".
-- - plataforma_clientes.modo suma 'por_torneo' (no vence: el estado es "Por torneo").
-- - plataforma_creditos: cada crédito de un cliente, de tipo torneo o corto; al usarse queda con el
--   torneo (torneo_id). Lo maneja solo el creador.
-- - Al publicar un torneo (pasar a "Torneo público", o crearlo público) un organizador Por torneo usa un
--   crédito: los Americanos y Súper 8 usan primero uno corto y si no tiene, uno de torneo; los Clásicos,
--   uno de torneo. Sin crédito: 'sin_creditos'. Un torneo ya pagado se puede ocultar y volver a publicar
--   sin gastar otro. Los que ya estaban públicos antes no gastan.
-- - mi_plan() suma los créditos disponibles y los torneos ya pagados.
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261035_publicidades.sql.
-- Prueba: supabase/pruebas/creditos.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

alter table public.plataforma_planes add column if not exists tipo_cobro text not null default 'mensual';
alter table public.plataforma_planes drop constraint if exists plataforma_planes_tipo_cobro_check;
alter table public.plataforma_planes add constraint plataforma_planes_tipo_cobro_check check (tipo_cobro in ('mensual', 'por_torneo', 'por_torneo_corto'));

insert into public.plataforma_planes (nombre, para, precio, modulo_torneos, tipo_cobro, orden)
select v.nombre, 'organizador', v.precio, true, v.tipo_cobro, v.orden
from (values ('Torneo suelto', 25000::numeric, 'por_torneo', 7), ('Torneo corto', 8000::numeric, 'por_torneo_corto', 8)) as v(nombre, precio, tipo_cobro, orden)
where not exists (select 1 from public.plataforma_planes p where p.tipo_cobro = v.tipo_cobro);

alter table public.plataforma_clientes drop constraint if exists plataforma_clientes_modo_check;
alter table public.plataforma_clientes add constraint plataforma_clientes_modo_check check (modo in ('prueba', 'bonificado', 'pago', 'por_torneo'));

create table if not exists public.plataforma_creditos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.plataforma_clientes(id) on delete cascade,
  tipo text not null check (tipo in ('torneo', 'corto')),
  torneo_id text,                -- el torneo en que se usó (null = disponible)
  usado_at timestamptz,
  movimiento_id uuid references public.plataforma_movimientos(id) on delete set null, -- el cobro, si se cobró
  nota text check (nota is null or char_length(nota) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists plataforma_creditos_cliente on public.plataforma_creditos (cliente_id, torneo_id);
create unique index if not exists plataforma_creditos_un_torneo on public.plataforma_creditos (torneo_id) where torneo_id is not null;

alter table public.plataforma_creditos enable row level security;
revoke all on public.plataforma_creditos from public, anon, authenticated;
grant select, insert, update, delete on public.plataforma_creditos to authenticated;
drop policy if exists "Solo el creador: créditos" on public.plataforma_creditos;
create policy "Solo el creador: créditos" on public.plataforma_creditos for all to authenticated
  using (public.es_creador()) with check (public.es_creador());

-- El estado de un cliente Por torneo: no vence
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
  if c.modo = 'por_torneo' then return 'por_torneo'; end if;
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

-- Al publicar, usar un crédito (organizadores Por torneo)
create or replace function public.torneo_usa_credito()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cliente uuid;
  v_tipo text;
  v_credito uuid;
begin
  if coalesce(new.datos->>'publico', 'true') = 'false' then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.datos->>'publico', 'true') <> 'false' then return new; end if;
  if new.organizador_id is null or public.es_creador() then return new; end if;
  select id into v_cliente from plataforma_clientes
  where tipo = 'organizador' and ref_id = new.organizador_id::text and activo and modo = 'por_torneo'
  limit 1;
  if v_cliente is null then return new; end if;
  if exists (select 1 from plataforma_creditos where torneo_id = new.id) then return new; end if;

  v_tipo := coalesce(new.datos->>'type', case when new.datos->'matchFormat'->>'type' = 'americano' then 'americano' else 'clasico' end);
  select id into v_credito from plataforma_creditos
  where cliente_id = v_cliente and torneo_id is null
    and (tipo = 'torneo' or (tipo = 'corto' and v_tipo in ('americano', 'super8')))
  order by (tipo = 'corto') desc, created_at
  limit 1
  for update skip locked;
  if v_credito is null then
    raise exception 'sin_creditos';
  end if;
  update plataforma_creditos set torneo_id = new.id, usado_at = now() where id = v_credito;
  return new;
end;
$$;

drop trigger if exists torneo_usa_credito on public.torneos;
create trigger torneo_usa_credito before insert or update on public.torneos
  for each row execute function public.torneo_usa_credito();

-- mi_plan con los créditos disponibles y los torneos ya pagados
drop function if exists public.mi_plan();
create function public.mi_plan()
returns table (tipo text, ref_id text, nombre text, estado text, fin date, dias_gracia int, modo text, plan_nombre text,
               modulo_torneos boolean, modulo_reservas boolean, modulo_cantina boolean, reportes boolean, empleados int,
               creditos_torneo int, creditos_corto int, torneos_pagados text[])
language sql
stable
security definer
set search_path = public
as $$
  select c.tipo, c.ref_id, c.nombre, public.plan_estado(c), public.plan_fin(c), c.dias_gracia, c.modo, p.nombre,
         p.modulo_torneos, p.modulo_reservas, p.modulo_cantina, p.reportes, p.empleados,
         (select count(*)::int from plataforma_creditos k where k.cliente_id = c.id and k.torneo_id is null and k.tipo = 'torneo'),
         (select count(*)::int from plataforma_creditos k where k.cliente_id = c.id and k.torneo_id is null and k.tipo = 'corto'),
         coalesce((select array_agg(k.torneo_id) from plataforma_creditos k where k.cliente_id = c.id and k.torneo_id is not null), '{}')
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

-- ============================================================
-- Vuelta atrás (plan_estado y mi_plan vuelven a su versión de 20261034: volver a correr esos bloques)
-- ============================================================
--   drop trigger if exists torneo_usa_credito on public.torneos;
--   drop function if exists public.torneo_usa_credito();
--   drop table if exists public.plataforma_creditos;
--   alter table public.plataforma_planes drop column if exists tipo_cobro;
