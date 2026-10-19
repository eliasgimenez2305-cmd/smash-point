-- Compras a proveedores y gastos fijos (solo el dueño).
--
-- Compras: "llegaron 48 aguas a $500 cada una". registrar_compra() en una sola operación:
--   - suma el stock de cada producto (si el producto controla stock),
--   - actualiza su costo (producto_costos), si se pide,
--   - y queda como gasto en la Caja el día que se paga (pagada_at). Si se compra "a pagar", queda
--     como deuda con el proveedor hasta que se marca pagada (pagar_compra).
--   anular_compra() devuelve el stock.
-- Gastos fijos: luz, alquiler, sueldos… se cargan una vez con el día del mes; en la Caja aparecen
--   cada mes como pendientes y al marcarlos pagados se anota el gasto (caja_movimientos con
--   gasto_fijo_id y periodo, uno por mes).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261025.

-- ============================================================
-- Proveedores y compras
-- ============================================================

create table if not exists public.proveedores (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  nota text check (nota is null or char_length(nota) <= 200),
  created_at timestamptz not null default now(),
  unique (id, complejo_id)
);

create table if not exists public.compras (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  proveedor_id uuid,
  fecha date not null,
  total numeric(12, 2) not null check (total >= 0),
  medio text check (medio is null or medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito')),
  pagada_at date, -- null = se debe
  nota text check (nota is null or char_length(nota) <= 200),
  cargada_por_email text,
  anulada boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, complejo_id),
  foreign key (proveedor_id, complejo_id) references public.proveedores (id, complejo_id) on delete set null (proveedor_id)
);
create index if not exists compras_por_complejo on public.compras (complejo_id, fecha desc);

create table if not exists public.compra_items (
  id uuid primary key default gen_random_uuid(),
  compra_id uuid not null,
  complejo_id text not null,
  producto_id uuid,
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 60),
  cantidad int not null check (cantidad between 1 and 100000),
  costo_unitario numeric(10, 2) not null check (costo_unitario >= 0),
  foreign key (compra_id, complejo_id) references public.compras (id, complejo_id) on delete cascade,
  foreign key (producto_id, complejo_id) references public.productos (id, complejo_id) on delete set null (producto_id)
);
create index if not exists compra_items_por_compra on public.compra_items (compra_id);

-- registrar_compra(complejo, proveedor, fecha, items, medio, nota, actualizar_costo)
--   items: [{ "producto_id": "…", "cantidad": 48, "costo": 500 }] o algo suelto [{ "descripcion": "Bolsas", "cantidad": 1, "costo": 3000 }]
--   medio: cómo se pagó; null = queda debiendo
create or replace function public.registrar_compra(p_complejo text, p_proveedor uuid, p_fecha date, p_items jsonb, p_medio text default null, p_nota text default null, p_actualizar_costo boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_compra uuid := gen_random_uuid();
  v_item jsonb;
  v_p productos%rowtype;
  v_cant int;
  v_costo numeric;
  v_desc text;
  v_total numeric := 0;
begin
  if not public.es_dueno_complejo(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 200 then
    raise exception 'datos_invalidos';
  end if;
  if p_proveedor is not null and not exists (select 1 from proveedores where id = p_proveedor and complejo_id = p_complejo) then
    raise exception 'proveedor_invalido';
  end if;

  insert into compras (id, complejo_id, proveedor_id, fecha, total, medio, pagada_at, nota, cargada_por_email)
  values (v_compra, p_complejo, p_proveedor, coalesce(p_fecha, current_date), 0, p_medio,
          case when p_medio is not null then coalesce(p_fecha, current_date) end,
          nullif(btrim(coalesce(p_nota, '')), ''), (select email from auth.users where id = auth.uid()));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item ->> 'cantidad')::int;
    v_costo := (v_item ->> 'costo')::numeric;
    if v_cant is null or v_cant < 1 or v_cant > 100000 or v_costo is null or v_costo < 0 or v_costo >= 100000000 then
      raise exception 'datos_invalidos';
    end if;
    if v_item ? 'producto_id' then
      select * into v_p from productos where id = (v_item ->> 'producto_id')::uuid and complejo_id = p_complejo for update;
      if not found then
        raise exception 'producto_invalido';
      end if;
      insert into compra_items (compra_id, complejo_id, producto_id, descripcion, cantidad, costo_unitario)
      values (v_compra, p_complejo, v_p.id, v_p.nombre, v_cant, v_costo);
      if v_p.stock is not null then
        update productos set stock = stock + v_cant where id = v_p.id;
      end if;
      if coalesce(p_actualizar_costo, true) then
        insert into producto_costos (producto_id, complejo_id, costo, updated_at) values (v_p.id, p_complejo, v_costo, now())
        on conflict (producto_id) do update set costo = excluded.costo, updated_at = now();
      end if;
    else
      v_desc := btrim(coalesce(v_item ->> 'descripcion', ''));
      if v_desc = '' or char_length(v_desc) > 60 then
        raise exception 'datos_invalidos';
      end if;
      insert into compra_items (compra_id, complejo_id, descripcion, cantidad, costo_unitario)
      values (v_compra, p_complejo, v_desc, v_cant, v_costo);
    end if;
    v_total := v_total + v_cant * v_costo;
  end loop;

  update compras set total = v_total where id = v_compra;
  return jsonb_build_object('compra_id', v_compra, 'total', v_total);
end;
$$;

revoke all on function public.registrar_compra(text, uuid, date, jsonb, text, text, boolean) from public, anon;
grant execute on function public.registrar_compra(text, uuid, date, jsonb, text, text, boolean) to authenticated;

-- Pagar una compra que había quedado debiendo
create or replace function public.pagar_compra(p_compra uuid, p_medio text, p_fecha date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c compras%rowtype;
begin
  select * into c from compras where id = p_compra for update;
  if not found or not public.es_dueno_complejo(c.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if c.anulada or c.pagada_at is not null then
    raise exception 'compra_ya_pagada';
  end if;
  update compras set medio = p_medio, pagada_at = coalesce(p_fecha, current_date) where id = c.id;
end;
$$;

revoke all on function public.pagar_compra(uuid, text, date) from public, anon;
grant execute on function public.pagar_compra(uuid, text, date) to authenticated;

-- Anular una compra cargada por error: el stock vuelve (el costo queda como estaba)
create or replace function public.anular_compra(p_compra uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c compras%rowtype;
begin
  select * into c from compras where id = p_compra for update;
  if not found or not public.es_dueno_complejo(c.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if c.anulada then
    return;
  end if;
  update productos p set stock = p.stock - i.cantidad
    from compra_items i
   where i.compra_id = c.id and i.producto_id = p.id and p.stock is not null;
  update compras set anulada = true where id = c.id;
end;
$$;

revoke all on function public.anular_compra(uuid) from public, anon;
grant execute on function public.anular_compra(uuid) to authenticated;

-- ============================================================
-- Gastos fijos
-- ============================================================

create table if not exists public.gastos_fijos (
  id uuid primary key default gen_random_uuid(),
  organizador_id uuid not null default auth.uid(),
  concepto text not null check (char_length(btrim(concepto)) between 1 and 80),
  monto numeric(12, 2) not null check (monto > 0 and monto < 1000000000),
  dia smallint not null default 1 check (dia between 1 and 28),
  medio text not null default 'transferencia' check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.caja_movimientos add column if not exists gasto_fijo_id uuid references public.gastos_fijos(id) on delete set null;
alter table public.caja_movimientos add column if not exists periodo text check (periodo is null or periodo ~ '^[0-9]{4}-[0-9]{2}$');
create unique index if not exists caja_un_pago_por_mes on public.caja_movimientos (gasto_fijo_id, periodo) where gasto_fijo_id is not null;

-- ============================================================
-- Permisos: todo del dueño (las compras se escriben solo por las funciones)
-- ============================================================

alter table public.proveedores enable row level security;
alter table public.compras enable row level security;
alter table public.compra_items enable row level security;
alter table public.gastos_fijos enable row level security;
revoke all on public.proveedores, public.compras, public.compra_items, public.gastos_fijos from public, anon, authenticated;
grant select, insert, update, delete on public.proveedores, public.gastos_fijos to authenticated;
grant select on public.compras, public.compra_items to authenticated;

drop policy if exists "El dueño maneja proveedores" on public.proveedores;
create policy "El dueño maneja proveedores" on public.proveedores for all to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño ve compras" on public.compras;
create policy "El dueño ve compras" on public.compras for select to authenticated using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño ve renglones de compras" on public.compra_items;
create policy "El dueño ve renglones de compras" on public.compra_items for select to authenticated using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El organizador maneja sus gastos fijos" on public.gastos_fijos;
create policy "El organizador maneja sus gastos fijos" on public.gastos_fijos for all to authenticated
  using (organizador_id = auth.uid() and public.es_organizador()) with check (organizador_id = auth.uid() and public.es_organizador());

-- Vuelta atrás (si hiciera falta):
--   drop index if exists public.caja_un_pago_por_mes;
--   alter table public.caja_movimientos drop column if exists periodo, drop column if exists gasto_fijo_id;
--   drop function if exists public.anular_compra(uuid);
--   drop function if exists public.pagar_compra(uuid, text, date);
--   drop function if exists public.registrar_compra(text, uuid, date, jsonb, text, text, boolean);
--   drop table if exists public.gastos_fijos, public.compra_items, public.compras, public.proveedores;
