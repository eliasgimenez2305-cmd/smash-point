-- Planes de Smash Point (solo el creador): qué se le deja hacer a cada organizador o complejo y cuánto
-- paga. Los precios los maneja el creador desde su panel; acá solo quedan sugeridos.
--
-- - plataforma_planes: cada plan, para quién es (organizador, complejo o publicidad), su precio mensual
--   y qué módulos incluye (torneos, reservas, cantina, reportes) con el tope de empleados (null = sin tope).
-- - plataforma_clientes suma: plan_id, modo (prueba / bonificado / pago), vence (fin de la prueba o
--   de la bonificación; null = sin fin), dias_gracia, suspendido y pagado_hasta (el último mes de cuota
--   cobrado, lo lleva la base con cada cobro). El estado (al día, por vencer, en gracia, vencido…) se
--   calcula con esos datos (ver src/planes.js).
-- - Al cobrar una cuota de alguien en Prueba, pasa solo a modo Pago.
-- Nadie más que el creador ve ni toca estas tablas (en la etapa 2 cada uno va a poder leer su propio plan).
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261032_auditoria.sql.
-- Prueba: supabase/pruebas/planes.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

create table if not exists public.plataforma_planes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(btrim(nombre)) between 1 and 40),
  para text not null check (para in ('organizador', 'complejo', 'publicidad')),
  precio numeric(12, 2) check (precio is null or (precio >= 0 and precio < 100000000)),
  modulo_torneos boolean not null default false,
  modulo_reservas boolean not null default false,
  modulo_cantina boolean not null default false,
  reportes boolean not null default false,
  empleados int check (empleados is null or empleados between 0 and 100),
  orden int not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.plataforma_planes enable row level security;
revoke all on public.plataforma_planes from public, anon, authenticated;
grant select, insert, update, delete on public.plataforma_planes to authenticated;
drop policy if exists "Solo el creador: planes" on public.plataforma_planes;
create policy "Solo el creador: planes" on public.plataforma_planes for all to authenticated
  using (public.es_creador()) with check (public.es_creador());

-- Planes sugeridos (el creador cambia nombres, precios y lo que incluye cada uno)
insert into public.plataforma_planes (nombre, para, precio, modulo_torneos, modulo_reservas, modulo_cantina, reportes, empleados, orden)
select * from (values
  ('Torneos', 'organizador', 45000::numeric, true, false, false, false, null::int, 1),
  ('Complejo', 'complejo', 50000, false, true, false, false, 2, 2),
  ('Cantina', 'complejo', 40000, false, false, true, false, 2, 3),
  ('Complejo + Cantina', 'complejo', 80000, false, true, true, false, 4, 4),
  ('Full', 'complejo', 100000, true, true, true, true, null, 5),
  ('Publicidad', 'publicidad', 15000, false, false, false, false, null, 6)
) as v(nombre, para, precio, t, r, c, rep, emp, orden)
where not exists (select 1 from public.plataforma_planes);

alter table public.plataforma_clientes add column if not exists plan_id uuid references public.plataforma_planes(id) on delete set null;
alter table public.plataforma_clientes add column if not exists modo text not null default 'pago';
alter table public.plataforma_clientes add column if not exists vence date;
alter table public.plataforma_clientes add column if not exists dias_gracia int not null default 7;
alter table public.plataforma_clientes add column if not exists suspendido boolean not null default false;
alter table public.plataforma_clientes add column if not exists pagado_hasta text;
alter table public.plataforma_clientes drop constraint if exists plataforma_clientes_modo_check;
alter table public.plataforma_clientes add constraint plataforma_clientes_modo_check check (modo in ('prueba', 'bonificado', 'pago'));
alter table public.plataforma_clientes drop constraint if exists plataforma_clientes_gracia_check;
alter table public.plataforma_clientes add constraint plataforma_clientes_gracia_check check (dias_gracia between 0 and 60);
alter table public.plataforma_clientes drop constraint if exists plataforma_clientes_pagado_check;
alter table public.plataforma_clientes add constraint plataforma_clientes_pagado_check check (pagado_hasta is null or pagado_hasta ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Los organizadores y complejos que ya eran clientes arrancan gratis (bonificados, sin fecha de fin)
update public.plataforma_clientes set modo = 'bonificado'
where tipo in ('organizador', 'complejo') and modo = 'pago' and pagado_hasta is null
  and not exists (select 1 from public.plataforma_movimientos m where m.cliente_id = plataforma_clientes.id and m.periodo is not null);

-- El último mes de cuota cobrado de cada cliente, al día con cada cobro (y si se borra uno)
create or replace function public.plataforma_pagado_hasta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cliente uuid;
begin
  foreach v_cliente in array array_remove(array[
    case when tg_op <> 'INSERT' then old.cliente_id end,
    case when tg_op <> 'DELETE' then new.cliente_id end
  ], null) loop
    update plataforma_clientes c
    set pagado_hasta = (select max(m.periodo) from plataforma_movimientos m where m.cliente_id = v_cliente and m.tipo = 'ingreso' and m.periodo is not null)
    where c.id = v_cliente;
  end loop;
  -- Cobrar una cuota a alguien en Prueba lo pasa a Pago
  if tg_op = 'INSERT' and new.tipo = 'ingreso' and new.periodo is not null and new.cliente_id is not null then
    update plataforma_clientes set modo = 'pago' where id = new.cliente_id and modo = 'prueba';
  end if;
  return null;
end;
$$;

drop trigger if exists plataforma_pagado_hasta on public.plataforma_movimientos;
create trigger plataforma_pagado_hasta after insert or update or delete on public.plataforma_movimientos
  for each row execute function public.plataforma_pagado_hasta();

-- Al día para los que ya tenían cobros
update public.plataforma_clientes c
set pagado_hasta = (select max(m.periodo) from public.plataforma_movimientos m where m.cliente_id = c.id and m.tipo = 'ingreso' and m.periodo is not null);

-- ============================================================
-- Vuelta atrás
-- ============================================================
--   drop trigger if exists plataforma_pagado_hasta on public.plataforma_movimientos;
--   drop function if exists public.plataforma_pagado_hasta();
--   alter table public.plataforma_clientes drop column if exists plan_id, drop column if exists modo,
--     drop column if exists vence, drop column if exists dias_gracia, drop column if exists suspendido,
--     drop column if exists pagado_hasta;
--   drop table if exists public.plataforma_planes;
