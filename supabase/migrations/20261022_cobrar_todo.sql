-- "Sumame todo": cobrar en un solo pago la inscripción de un jugador y lo que consumió.
-- Necesita 20261018 (cobros de inscripciones) y 20261021 (consumos).
--
-- - cuenta_jugadores: vincula un jugador de un torneo (torneo, categoría, pareja, jugador) con su
--   cuenta de consumos. Solo se puede si el torneo es del dueño de ese complejo.
-- - inscripciones_de_cuenta(cuenta): lo que debe de inscripción cada jugador vinculado (precio por
--   jugador del torneo o de su categoría, menos lo ya pagado).
-- - cuentas_con_saldo ahora trae también debe_inscripciones.
-- - cobrar_todo(cuenta, monto, medio): reparte el pago, primero la inscripción y el resto a los
--   consumos. Por dentro quedan dos pagos (pagos_inscripcion y cuenta_pagos), así la caja sigue
--   separando inscripciones de consumos. Todo en una sola operación.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create table if not exists public.cuenta_jugadores (
  torneo_id text not null,
  categoria_id text not null,
  pareja_id text not null,
  jugador smallint not null check (jugador in (1, 2)),
  cuenta_id uuid not null,
  complejo_id text not null,
  created_at timestamptz not null default now(),
  primary key (torneo_id, categoria_id, pareja_id, jugador),
  foreign key (cuenta_id, complejo_id) references public.cuentas (id, complejo_id) on delete cascade
);
create index if not exists cuenta_jugadores_por_cuenta on public.cuenta_jugadores (cuenta_id);

-- ¿El torneo es del dueño de ese complejo?
create or replace function public.torneo_del_complejo(p_torneo text, p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from torneos t join complejos x on x.dueno_id = t.organizador_id
    where t.id = p_torneo and x.id = p_complejo
  );
$$;

revoke all on function public.torneo_del_complejo(text, text) from public, anon;
grant execute on function public.torneo_del_complejo(text, text) to authenticated;

alter table public.cuenta_jugadores enable row level security;
revoke all on public.cuenta_jugadores from public, anon, authenticated;
grant select, insert, delete on public.cuenta_jugadores to authenticated;

drop policy if exists "Ven vínculos" on public.cuenta_jugadores;
create policy "Ven vínculos" on public.cuenta_jugadores for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Vinculan" on public.cuenta_jugadores;
create policy "Vinculan" on public.cuenta_jugadores for insert to authenticated
  with check (public.puede_consumos(complejo_id) and public.torneo_del_complejo(torneo_id, complejo_id));
drop policy if exists "Desvinculan" on public.cuenta_jugadores;
create policy "Desvinculan" on public.cuenta_jugadores for delete to authenticated using (public.puede_consumos(complejo_id));

-- Deuda de inscripción de cada jugador vinculado a la cuenta (uso interno, sin control de permisos)
create or replace function public._inscripciones_de_cuenta(p_cuenta uuid)
returns table (torneo_id text, torneo text, categoria_id text, categoria text, pareja_id text, jugador smallint,
               nombre text, precio numeric, pagado numeric, debe numeric, organizador_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.torneo_id, t.datos->>'name', l.categoria_id, c.val->>'name', l.pareja_id, l.jugador,
         coalesce(nullif(btrim(case when c.val->>'format' = 'super8_individual' then pr.val->>'name'
                                    else split_part(pr.val->>'name', '/', l.jugador) end), ''), 'Jugador ' || l.jugador),
         pre.precio,
         coalesce(pg.pagado, 0),
         greatest(0, coalesce(pre.precio, 0) - coalesce(pg.pagado, 0)),
         t.organizador_id
  from cuenta_jugadores l
  join torneos t on t.id = l.torneo_id
  cross join lateral (select e.val from jsonb_array_elements(coalesce(t.datos->'categories', '[]'::jsonb)) as e(val) where e.val->>'id' = l.categoria_id) c
  cross join lateral (select e.val from jsonb_array_elements(coalesce(c.val->'pairs', '[]'::jsonb)) as e(val) where e.val->>'id' = l.pareja_id) pr
  cross join lateral (select nullif(coalesce(c.val->>'precioJugador', t.datos->>'precioJugador'), '')::numeric as precio) pre
  left join lateral (
    select sum(p.monto) as pagado from pagos_inscripcion p
    where p.torneo_id = l.torneo_id and p.categoria_id = l.categoria_id and p.pareja_id = l.pareja_id and p.jugador = l.jugador
  ) pg on true
  where l.cuenta_id = p_cuenta;
$$;

revoke all on function public._inscripciones_de_cuenta(uuid) from public, anon, authenticated;

create or replace function public.inscripciones_de_cuenta(p_cuenta uuid)
returns table (torneo_id text, torneo text, categoria_id text, categoria text, pareja_id text, jugador smallint,
               nombre text, precio numeric, pagado numeric, debe numeric, organizador_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from cuentas where id = p_cuenta and public.puede_consumos(complejo_id)) then
    raise exception 'no_autorizado';
  end if;
  return query select * from public._inscripciones_de_cuenta(p_cuenta);
end;
$$;

revoke all on function public.inscripciones_de_cuenta(uuid) from public, anon;
grant execute on function public.inscripciones_de_cuenta(uuid) to authenticated;

-- Igual que en 20261021_consumos.sql, más lo que debe de inscripciones
drop function if exists public.cuentas_con_saldo(text);
create function public.cuentas_con_saldo(p_complejo text)
returns table (id uuid, nombre text, telefono text, nota text, consumido numeric, pagado numeric, ultimo timestamptz, debe_inscripciones numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.puede_consumos(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  return query
    select c.id, c.nombre, c.telefono, c.nota,
           coalesce((select sum(k.cantidad * k.precio_unitario) from cuenta_consumos k where k.cuenta_id = c.id), 0),
           coalesce((select sum(p.monto) from cuenta_pagos p where p.cuenta_id = c.id), 0),
           greatest(c.created_at,
                    (select max(k.created_at) from cuenta_consumos k where k.cuenta_id = c.id),
                    (select max(p.created_at) from cuenta_pagos p where p.cuenta_id = c.id)),
           coalesce((select sum(i.debe) from public._inscripciones_de_cuenta(c.id) i), 0)
    from cuentas c
    where c.complejo_id = p_complejo;
end;
$$;

revoke all on function public.cuentas_con_saldo(text) from public, anon;
grant execute on function public.cuentas_con_saldo(text) to authenticated;

-- Un pago que cubre primero las inscripciones y después los consumos. Devuelve cuánto fue a cada cosa.
create or replace function public.cobrar_todo(p_cuenta uuid, p_monto numeric, p_medio text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c cuentas%rowtype;
  v_resto numeric := p_monto;
  v_ins numeric := 0;
  v_aplica numeric;
  r record;
begin
  select * into v_c from cuentas where id = p_cuenta;
  if not found or not public.puede_consumos(v_c.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if p_monto is null or p_monto <= 0 or p_monto >= 100000000 or p_medio not in ('efectivo', 'transferencia', 'mercado_pago') then
    raise exception 'datos_invalidos';
  end if;

  for r in select * from public._inscripciones_de_cuenta(p_cuenta) i where i.debe > 0 order by i.torneo_id, i.categoria_id, i.pareja_id, i.jugador loop
    exit when v_resto <= 0;
    v_aplica := least(v_resto, r.debe);
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
    values (r.torneo_id, r.organizador_id, r.categoria_id, r.pareja_id, r.jugador, v_aplica, p_medio);
    v_ins := v_ins + v_aplica;
    v_resto := v_resto - v_aplica;
  end loop;

  if v_resto > 0 then
    insert into cuenta_pagos (complejo_id, cuenta_id, monto, medio) values (v_c.complejo_id, p_cuenta, v_resto, p_medio);
  end if;
  return jsonb_build_object('inscripciones', v_ins, 'consumos', greatest(v_resto, 0));
end;
$$;

revoke all on function public.cobrar_todo(uuid, numeric, text) from public, anon;
grant execute on function public.cobrar_todo(uuid, numeric, text) to authenticated;
