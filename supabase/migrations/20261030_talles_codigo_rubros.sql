-- Mostrador, etapa 3: talles con stock propio, código de barras y categorías editables.
--
-- - producto_talles: los talles de un producto (S, M, L, XL o los que se carguen), cada uno con su
--   stock y su código. El stock del producto pasa a ser la suma de sus talles (lo mantiene la base),
--   así las tarjetas, los avisos de stock bajo y los reportes siguen igual.
-- - venta_items.talle y compra_items.talle: vender y comprar mueven el stock de ese talle.
-- - productos.codigo: el código de barras (opcional, único en el complejo).
-- - rubros: las categorías del mostrador de cada complejo, con su orden y su ícono.
-- - sumar_stock_talle(): reponer un talle. Los productos con talles no se anotan desde Cuentas
--   (se venden desde el Mostrador, eligiendo el talle).
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261029_cargar_a_turno.sql. Vuelta atrás: al final.

-- ============================================================
-- Tablas y columnas
-- ============================================================

alter table public.productos add column if not exists codigo text check (codigo is null or char_length(btrim(codigo)) between 1 and 40);
create unique index if not exists productos_un_codigo on public.productos (complejo_id, codigo) where codigo is not null;

create table if not exists public.producto_talles (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null,
  complejo_id text not null,
  talle text not null check (char_length(btrim(talle)) between 1 and 10),
  stock int not null default 0,
  codigo text check (codigo is null or char_length(btrim(codigo)) between 1 and 40),
  orden int not null default 0,
  foreign key (producto_id, complejo_id) references public.productos (id, complejo_id) on delete cascade,
  unique (producto_id, talle)
);
create index if not exists talles_por_complejo on public.producto_talles (complejo_id);
create unique index if not exists talles_un_codigo on public.producto_talles (complejo_id, codigo) where codigo is not null;

alter table public.venta_items add column if not exists talle text;
alter table public.compra_items add column if not exists talle text;

create table if not exists public.rubros (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 30),
  icono text not null default 'otros' check (icono in ('bebidas', 'comida', 'indumentaria', 'paletas', 'pelotas', 'accesorios', 'otros')),
  orden int not null default 0,
  unique (complejo_id, nombre)
);

-- El stock del producto es la suma de sus talles
create or replace function public.talles_al_cambiar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_producto uuid := coalesce(new.producto_id, old.producto_id);
begin
  update productos set stock = (select coalesce(sum(stock), 0) from producto_talles where producto_id = v_producto)
   where id = v_producto;
  return null;
end;
$$;
drop trigger if exists talles_al_cambiar on public.producto_talles;
create trigger talles_al_cambiar after insert or update of stock or delete on public.producto_talles
  for each row execute function public.talles_al_cambiar();

-- Si alguien cambia a mano el stock de un producto con talles, vuelve a ser la suma de sus talles
create or replace function public.producto_stock_de_talles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from producto_talles where producto_id = new.id) then
    new.stock := (select coalesce(sum(stock), 0) from producto_talles where producto_id = new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists producto_stock_de_talles on public.productos;
create trigger producto_stock_de_talles before update of stock on public.productos
  for each row execute function public.producto_stock_de_talles();

-- ¿Tiene talles este producto?
create or replace function public.tiene_talles(p_producto uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from producto_talles where producto_id = p_producto);
$$;
revoke all on function public.tiene_talles(uuid) from public, anon;

-- Mueve el stock de un producto (o de uno de sus talles). Con talles hay que decir cuál.
create or replace function public._mover_stock(p_producto uuid, p_talle text, p_delta int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.tiene_talles(p_producto) then
    if p_talle is null then
      raise exception 'elegir_talle';
    end if;
    update producto_talles set stock = stock + p_delta where producto_id = p_producto and talle = p_talle;
    if not found then
      raise exception 'talle_invalido';
    end if;
  else
    if p_talle is not null then
      raise exception 'talle_invalido';
    end if;
    update productos set stock = stock + p_delta where id = p_producto and stock is not null;
  end if;
end;
$$;
revoke all on function public._mover_stock(uuid, text, int) from public, anon, authenticated;

-- ============================================================
-- Vender, anular, comprar y anular compra: con talle
-- ============================================================

create or replace function public.vender(p_complejo text, p_items jsonb, p_pagos jsonb, p_ajuste numeric default 0, p_cuenta uuid default null, p_reserva uuid default null)
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
  v_talle text;
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
  if p_cuenta is not null and p_reserva is not null then
    raise exception 'datos_invalidos';
  end if;
  if p_cuenta is not null and not exists (select 1 from cuentas where id = p_cuenta and complejo_id = p_complejo) then
    raise exception 'cuenta_invalida';
  end if;
  if p_reserva is not null and not exists (
    select 1 from reservas where id = p_reserva and complejo_id = p_complejo and tipo in ('turno', 'clase') and estado = 'confirmada'
  ) then
    raise exception 'turno_invalido';
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
      v_talle := nullif(btrim(coalesce(v_item ->> 'talle', '')), '');
      v_desc := left(v_p.nombre || coalesce(' ' || v_talle, ''), 60);
      insert into venta_items (id, venta_id, complejo_id, producto_id, descripcion, rubro, cantidad, precio_unitario, talle)
      values (v_item_id, v_venta, p_complejo, v_p.id, v_desc, v_p.rubro, v_cant, v_p.precio, v_talle);
      insert into venta_items_costo (item_id, complejo_id, costo_unitario)
      select v_item_id, p_complejo, c.costo from producto_costos c where c.producto_id = v_p.id;
      perform public._mover_stock(v_p.id, v_talle, -v_cant);
      v_subtotal := v_subtotal + v_cant * v_p.precio;
      v_nombres := v_nombres || case when v_nombres = '' then '' else ', ' end || v_desc;
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
  if v_resto > 0 and p_reserva is null then
    if p_cuenta is null then
      raise exception 'falta_pagar';
    end if;
    insert into cuenta_consumos (complejo_id, cuenta_id, descripcion, cantidad, precio_unitario)
    values (p_complejo, p_cuenta, left('Venta #' || v_numero || ': ' || v_nombres, 60), 1, v_resto)
    returning id into v_consumo;
  end if;

  update ventas set subtotal = v_subtotal, ajuste = coalesce(p_ajuste, 0), total = v_total,
         cuenta_id = case when v_resto > 0 and p_reserva is null then p_cuenta end, consumo_id = v_consumo,
         a_cuenta = case when p_reserva is null then v_resto else 0 end,
         reserva_id = p_reserva, pendiente = case when p_reserva is not null then v_resto else 0 end
   where id = v_venta;

  return jsonb_build_object('venta_id', v_venta, 'numero', v_numero, 'total', v_total,
    'a_cuenta', case when p_reserva is null then v_resto else 0 end,
    'pendiente', case when p_reserva is not null then v_resto else 0 end);
end;
$$;

revoke all on function public.vender(text, jsonb, jsonb, numeric, uuid, uuid) from public, anon;
grant execute on function public.vender(text, jsonb, jsonb, numeric, uuid, uuid) to authenticated;

create or replace function public.anular_venta(p_venta uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v ventas%rowtype;
  i record;
begin
  select * into v from ventas where id = p_venta for update;
  if not found or not public.es_dueno_complejo(v.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if v.anulada then
    return;
  end if;
  for i in select vi.producto_id, vi.talle, vi.cantidad from venta_items vi
            join productos p on p.id = vi.producto_id
           where vi.venta_id = v.id loop
    -- Si el talle ya no existe (o el producto dejó de tener talles), el stock vuelve al producto
    if i.talle is not null and exists (select 1 from producto_talles where producto_id = i.producto_id and talle = i.talle) then
      update producto_talles set stock = stock + i.cantidad where producto_id = i.producto_id and talle = i.talle;
    elsif not public.tiene_talles(i.producto_id) then
      update productos set stock = stock + i.cantidad where id = i.producto_id and stock is not null;
    end if;
  end loop;
  if v.consumo_id is not null then
    delete from cuenta_consumos where id = v.consumo_id;
  end if;
  update ventas set anulada = true, anulada_at = now(), pendiente = 0 where id = v.id;
end;
$$;

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
  v_talle text;
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
      v_talle := nullif(btrim(coalesce(v_item ->> 'talle', '')), '');
      insert into compra_items (compra_id, complejo_id, producto_id, descripcion, cantidad, costo_unitario, talle)
      values (v_compra, p_complejo, v_p.id, left(v_p.nombre || coalesce(' ' || v_talle, ''), 60), v_cant, v_costo, v_talle);
      perform public._mover_stock(v_p.id, v_talle, v_cant);
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

create or replace function public.anular_compra(p_compra uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c compras%rowtype;
  i record;
begin
  select * into c from compras where id = p_compra for update;
  if not found or not public.es_dueno_complejo(c.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if c.anulada then
    return;
  end if;
  for i in select ci.producto_id, ci.talle, ci.cantidad from compra_items ci
            join productos p on p.id = ci.producto_id
           where ci.compra_id = c.id loop
    if i.talle is not null and exists (select 1 from producto_talles where producto_id = i.producto_id and talle = i.talle) then
      update producto_talles set stock = stock - i.cantidad where producto_id = i.producto_id and talle = i.talle;
    elsif not public.tiene_talles(i.producto_id) then
      update productos set stock = stock - i.cantidad where id = i.producto_id and stock is not null;
    end if;
  end loop;
  update compras set anulada = true where id = c.id;
end;
$$;

-- Reponer: los productos con talles se reponen por talle
create or replace function public.sumar_stock(p_producto uuid, p_cantidad int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p productos%rowtype;
begin
  select * into v_p from productos where id = p_producto for update;
  if not found or not public.puede_consumos(v_p.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if p_cantidad is null or p_cantidad = 0 or abs(p_cantidad) > 100000 then
    raise exception 'datos_invalidos';
  end if;
  if public.tiene_talles(p_producto) then
    raise exception 'elegir_talle';
  end if;
  update productos set stock = coalesce(stock, 0) + p_cantidad where id = p_producto returning stock into v_p.stock;
  return v_p.stock;
end;
$$;

create or replace function public.sumar_stock_talle(p_producto uuid, p_talle text, p_cantidad int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complejo text := (select complejo_id from productos where id = p_producto);
  v_stock int;
begin
  if v_complejo is null or not public.puede_consumos(v_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_cantidad is null or p_cantidad = 0 or abs(p_cantidad) > 100000 then
    raise exception 'datos_invalidos';
  end if;
  update producto_talles set stock = stock + p_cantidad where producto_id = p_producto and talle = p_talle returning stock into v_stock;
  if not found then
    raise exception 'talle_invalido';
  end if;
  return v_stock;
end;
$$;
revoke all on function public.sumar_stock_talle(uuid, text, int) from public, anon;
grant execute on function public.sumar_stock_talle(uuid, text, int) to authenticated;

-- Cuentas: los productos con talles no se anotan desde ahí (no hay dónde elegir el talle)
create or replace function public.consumo_al_anotar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p productos%rowtype;
begin
  new.cargado_por := auth.uid();
  new.cargado_por_email := (select email from auth.users where id = auth.uid());
  new.created_at := now();
  if new.producto_id is not null then
    select * into v_p from productos where id = new.producto_id and complejo_id = new.complejo_id for update;
    if not found then
      raise exception 'producto_invalido';
    end if;
    if public.tiene_talles(v_p.id) then
      raise exception 'elegir_talle';
    end if;
    new.descripcion := v_p.nombre;
    new.precio_unitario := v_p.precio;
    if v_p.stock is not null then
      update productos set stock = stock - new.cantidad where id = v_p.id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.consumo_al_anular()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.producto_id is not null and not public.tiene_talles(old.producto_id) then
    update productos set stock = stock + old.cantidad where id = old.producto_id and stock is not null;
  end if;
  return old;
end;
$$;

-- ============================================================
-- Permisos
-- ============================================================

alter table public.producto_talles enable row level security;
alter table public.rubros enable row level security;
revoke all on public.producto_talles, public.rubros from public, anon, authenticated;
grant select, insert, update, delete on public.producto_talles, public.rubros to authenticated;

drop policy if exists "Ven talles" on public.producto_talles;
create policy "Ven talles" on public.producto_talles for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "El dueño carga talles" on public.producto_talles;
create policy "El dueño carga talles" on public.producto_talles for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia talles" on public.producto_talles;
create policy "El dueño cambia talles" on public.producto_talles for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra talles" on public.producto_talles;
create policy "El dueño borra talles" on public.producto_talles for delete to authenticated using (public.es_dueno_complejo(complejo_id));

drop policy if exists "Ven rubros" on public.rubros;
create policy "Ven rubros" on public.rubros for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "El dueño carga rubros" on public.rubros;
create policy "El dueño carga rubros" on public.rubros for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia rubros" on public.rubros;
create policy "El dueño cambia rubros" on public.rubros for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra rubros" on public.rubros;
create policy "El dueño borra rubros" on public.rubros for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- ============================================================
-- Vuelta atrás (correr a mano si hiciera falta):
--   drop table if exists public.producto_talles, public.rubros;
--   drop function if exists public.sumar_stock_talle(uuid, text, int), public._mover_stock(uuid, text, int),
--     public.tiene_talles(uuid), public.talles_al_cambiar();
--   alter table public.productos drop column if exists codigo;
--   alter table public.venta_items drop column if exists talle;
--   alter table public.compra_items drop column if exists talle;
--   y volver a correr vender(), anular_venta(), registrar_compra(), anular_compra(), sumar_stock(),
--   consumo_al_anotar() y consumo_al_anular() de sus migraciones anteriores (20261029, 20261026, 20261021).
-- ============================================================
