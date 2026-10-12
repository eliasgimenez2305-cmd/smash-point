-- Mostrador: ventas al contado en la cantina (bebidas, comida, paletas, pelotas, accesorios…).
--
-- - productos: rubro (Bebidas, Paletas…) y nombre de hasta 60 letras ("Paleta Bullpadel Vertex 04").
-- - producto_costos: lo que le cuesta cada producto al complejo. Aparte, porque lo ve SOLO el
--   dueño (los empleados venden, pero no ven el costo ni la ganancia).
-- - ventas, venta_items y venta_pagos: cada venta con lo que se llevó y cómo pagó. Se puede pagar
--   con varios medios (parte efectivo, parte transferencia) y dejar un saldo "a cuenta" de una
--   persona (seña o cuotas de una paleta): ese saldo se anota en su cuenta de consumos y se cobra
--   como cualquier fiado.
-- - venta_items_costo: el costo de cada renglón al momento de vender, para la ganancia (solo el dueño).
-- - vender(): hace todo en una sola operación (precios y stock salen de la base, no del navegador).
-- - anular_venta(): solo el dueño; devuelve el stock y saca el saldo a cuenta si lo hubo.
--
-- Venden el dueño y los empleados con el permiso de consumos (puede_consumos).
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261023.

-- ============================================================
-- Productos: rubro, nombre más largo y costo (aparte)
-- ============================================================

alter table public.productos add column if not exists rubro text check (rubro is null or char_length(btrim(rubro)) between 1 and 30);
alter table public.productos drop constraint if exists productos_nombre_check;
alter table public.productos add constraint productos_nombre_check check (char_length(btrim(nombre)) between 1 and 60);

create table if not exists public.producto_costos (
  producto_id uuid primary key,
  complejo_id text not null,
  costo numeric(10, 2) not null check (costo >= 0),
  updated_at timestamptz not null default now(),
  foreign key (producto_id, complejo_id) references public.productos (id, complejo_id) on delete cascade
);

-- ============================================================
-- Ventas
-- ============================================================

create table if not exists public.ventas (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  complejo_id text not null references public.complejos(id) on delete cascade,
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  ajuste numeric(12, 2) not null default 0, -- negativo = descuento, positivo = recargo
  total numeric(12, 2) not null check (total >= 0),
  cuenta_id uuid, -- si quedó saldo a cuenta de alguien
  consumo_id uuid, -- el renglón que se anotó en esa cuenta
  a_cuenta numeric(12, 2) not null default 0 check (a_cuenta >= 0),
  vendido_por uuid not null default auth.uid(),
  vendido_por_email text,
  anulada boolean not null default false,
  anulada_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, complejo_id),
  foreign key (cuenta_id, complejo_id) references public.cuentas (id, complejo_id) on delete set null (cuenta_id)
);
create index if not exists ventas_por_complejo on public.ventas (complejo_id, created_at);

create table if not exists public.venta_items (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null,
  complejo_id text not null,
  producto_id uuid,
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 60),
  rubro text,
  cantidad int not null check (cantidad between 1 and 999),
  precio_unitario numeric(10, 2) not null check (precio_unitario >= 0),
  foreign key (venta_id, complejo_id) references public.ventas (id, complejo_id) on delete cascade,
  foreign key (producto_id, complejo_id) references public.productos (id, complejo_id) on delete set null (producto_id)
);
create index if not exists venta_items_por_venta on public.venta_items (venta_id);

create table if not exists public.venta_items_costo (
  item_id uuid primary key references public.venta_items(id) on delete cascade,
  complejo_id text not null,
  costo_unitario numeric(10, 2) not null check (costo_unitario >= 0)
);

create table if not exists public.venta_pagos (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null,
  complejo_id text not null,
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito')),
  monto numeric(12, 2) not null check (monto > 0 and monto < 100000000),
  created_at timestamptz not null default now(),
  foreign key (venta_id, complejo_id) references public.ventas (id, complejo_id) on delete cascade
);
create index if not exists venta_pagos_por_complejo on public.venta_pagos (complejo_id, created_at);
create index if not exists venta_pagos_por_venta on public.venta_pagos (venta_id);

-- ============================================================
-- vender(complejo, items, pagos, ajuste, cuenta)
--   items: [{ "producto_id": "…", "cantidad": 2 }] o algo suelto [{ "descripcion": "Encordado", "precio": 8000, "cantidad": 1 }]
--   pagos: [{ "medio": "efectivo", "monto": 5000 }, …] (pueden no cubrir todo si hay cuenta)
--   ajuste: descuento (negativo) o recargo (positivo) sobre el total
--   cuenta: a quién se le anota lo que falta pagar (seña, cuotas)
-- ============================================================

create or replace function public.vender(p_complejo text, p_items jsonb, p_pagos jsonb, p_ajuste numeric default 0, p_cuenta uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venta uuid := gen_random_uuid();
  v_numero bigint;
  v_item jsonb;
  v_pago jsonb;
  v_p productos%rowtype;
  v_cant int;
  v_precio numeric;
  v_desc text;
  v_item_id uuid;
  v_subtotal numeric := 0;
  v_total numeric;
  v_pagado numeric := 0;
  v_resto numeric;
  v_consumo uuid;
  v_email text := (select email from auth.users where id = auth.uid());
  v_nombres text := '';
begin
  if not public.puede_consumos(p_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'datos_invalidos';
  end if;
  if p_pagos is null or jsonb_typeof(p_pagos) <> 'array' or jsonb_array_length(p_pagos) > 10 then
    raise exception 'datos_invalidos';
  end if;
  if p_cuenta is not null and not exists (select 1 from cuentas where id = p_cuenta and complejo_id = p_complejo) then
    raise exception 'cuenta_invalida';
  end if;

  insert into ventas (id, complejo_id, subtotal, ajuste, total, vendido_por, vendido_por_email)
  values (v_venta, p_complejo, 0, 0, 0, auth.uid(), v_email)
  returning numero into v_numero;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item ->> 'cantidad')::int;
    if v_cant is null or v_cant < 1 or v_cant > 999 then
      raise exception 'datos_invalidos';
    end if;
    v_item_id := gen_random_uuid();
    if v_item ? 'producto_id' then
      select * into v_p from productos where id = (v_item ->> 'producto_id')::uuid and complejo_id = p_complejo for update;
      if not found then
        raise exception 'producto_invalido';
      end if;
      insert into venta_items (id, venta_id, complejo_id, producto_id, descripcion, rubro, cantidad, precio_unitario)
      values (v_item_id, v_venta, p_complejo, v_p.id, v_p.nombre, v_p.rubro, v_cant, v_p.precio);
      insert into venta_items_costo (item_id, complejo_id, costo_unitario)
      select v_item_id, p_complejo, c.costo from producto_costos c where c.producto_id = v_p.id;
      if v_p.stock is not null then
        update productos set stock = stock - v_cant where id = v_p.id;
      end if;
      v_subtotal := v_subtotal + v_cant * v_p.precio;
      v_nombres := v_nombres || case when v_nombres = '' then '' else ', ' end || v_p.nombre;
    else
      v_desc := btrim(coalesce(v_item ->> 'descripcion', ''));
      v_precio := (v_item ->> 'precio')::numeric;
      if v_desc = '' or char_length(v_desc) > 60 or v_precio is null or v_precio < 0 or v_precio >= 100000000 then
        raise exception 'datos_invalidos';
      end if;
      insert into venta_items (id, venta_id, complejo_id, descripcion, cantidad, precio_unitario)
      values (v_item_id, v_venta, p_complejo, v_desc, v_cant, v_precio);
      v_subtotal := v_subtotal + v_cant * v_precio;
      v_nombres := v_nombres || case when v_nombres = '' then '' else ', ' end || v_desc;
    end if;
  end loop;

  v_total := v_subtotal + coalesce(p_ajuste, 0);
  if v_total < 0 or coalesce(p_ajuste, 0) < -v_subtotal or coalesce(p_ajuste, 0) > v_subtotal then
    raise exception 'ajuste_invalido';
  end if;

  for v_pago in select * from jsonb_array_elements(p_pagos) loop
    if (v_pago ->> 'monto')::numeric is null or (v_pago ->> 'monto')::numeric <= 0 then
      raise exception 'datos_invalidos';
    end if;
    insert into venta_pagos (venta_id, complejo_id, medio, monto)
    values (v_venta, p_complejo, v_pago ->> 'medio', (v_pago ->> 'monto')::numeric);
    v_pagado := v_pagado + (v_pago ->> 'monto')::numeric;
  end loop;

  if v_pagado > v_total then
    raise exception 'pago_de_mas';
  end if;
  v_resto := v_total - v_pagado;
  if v_resto > 0 then
    if p_cuenta is null then
      raise exception 'falta_pagar';
    end if;
    insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
    values (p_complejo, p_cuenta, left('Venta #' || v_numero || ': ' || v_nombres, 60), 1, v_resto)
    returning id into v_consumo;
  end if;

  update ventas set subtotal = v_subtotal, ajuste = coalesce(p_ajuste, 0), total = v_total,
         cuenta_id = case when v_resto > 0 then p_cuenta end, consumo_id = v_consumo, a_cuenta = v_resto
   where id = v_venta;

  return jsonb_build_object('venta_id', v_venta, 'numero', v_numero, 'total', v_total, 'a_cuenta', v_resto);
end;
$$;

revoke all on function public.vender(text, jsonb, jsonb, numeric, uuid) from public, anon;
grant execute on function public.vender(text, jsonb, jsonb, numeric, uuid) to authenticated;

-- Anular una venta (solo el dueño): vuelve el stock y se saca el saldo a cuenta
create or replace function public.anular_venta(p_venta uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v ventas%rowtype;
begin
  select * into v from ventas where id = p_venta for update;
  if not found or not public.es_dueno_complejo(v.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if v.anulada then
    return;
  end if;
  update productos p set stock = p.stock + i.cantidad
    from venta_items i
   where i.venta_id = v.id and i.producto_id = p.id and p.stock is not null;
  if v.consumo_id is not null then
    delete from cuenta_consumos where id = v.consumo_id;
  end if;
  update ventas set anulada = true, anulada_at = now() where id = v.id;
end;
$$;

revoke all on function public.anular_venta(uuid) from public, anon;
grant execute on function public.anular_venta(uuid) to authenticated;

-- ============================================================
-- Permisos: ver ventas (dueño y empleados con consumos); escribir solo por vender()/anular_venta()
-- Costos: solo el dueño
-- ============================================================

alter table public.producto_costos enable row level security;
alter table public.ventas enable row level security;
alter table public.venta_items enable row level security;
alter table public.venta_items_costo enable row level security;
alter table public.venta_pagos enable row level security;
revoke all on public.producto_costos, public.ventas, public.venta_items, public.venta_items_costo, public.venta_pagos from public, anon, authenticated;
grant select on public.ventas, public.venta_items, public.venta_pagos, public.venta_items_costo to authenticated;
grant select, insert, update, delete on public.producto_costos to authenticated;

drop policy if exists "Ven ventas" on public.ventas;
create policy "Ven ventas" on public.ventas for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Ven renglones de ventas" on public.venta_items;
create policy "Ven renglones de ventas" on public.venta_items for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Ven pagos de ventas" on public.venta_pagos;
create policy "Ven pagos de ventas" on public.venta_pagos for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "El dueño ve costos de ventas" on public.venta_items_costo;
create policy "El dueño ve costos de ventas" on public.venta_items_costo for select to authenticated using (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño maneja costos" on public.producto_costos;
create policy "El dueño maneja costos" on public.producto_costos for all to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));

-- Vuelta atrás (si hiciera falta):
--   drop function if exists public.anular_venta(uuid);
--   drop function if exists public.vender(text, jsonb, jsonb, numeric, uuid);
--   drop table if exists public.venta_pagos, public.venta_items_costo, public.venta_items, public.ventas, public.producto_costos;
--   alter table public.productos drop column if exists rubro;
