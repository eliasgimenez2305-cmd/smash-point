-- Consumos y cuentas ("fiado") del complejo, con stock. Necesita 20261017 a 20261019.
--
-- - productos: la lista del complejo (agua, protector, papas…) con precio y, si se controla, stock
--   (null = sin control) y desde cuánto avisar que queda poco.
-- - cuentas: una por persona (nombre y WhatsApp), del complejo: sirve en torneos, turnos o
--   cualquier día; la deuda queda hasta que paga.
-- - cuenta_consumos: lo que se le anota (producto, cantidad y precio del momento; o algo suelto
--   con descripción y precio). Anotar descuenta stock; anular (solo el dueño) lo devuelve.
-- - cuenta_pagos: lo que paga, cuando sea; entra en la caja del dueño como "Consumos".
-- Quién: el dueño del complejo y los colaboradores con el permiso nuevo p_consumos. Los productos
-- (precios) los maneja el dueño; el colaborador puede sumar stock (reponer). Anular consumos o
-- pagos y borrar cuentas es solo del dueño. Quién anotó y quién cobró lo pone la base.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

-- ============================================================
-- Permiso nuevo para colaboradores
-- ============================================================

alter table public.colaboradores add column if not exists p_consumos boolean not null default false;

create or replace function public.colaborador_permiso(p_complejo text, p_permiso text)
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

drop function if exists public.mis_complejos_colaborador();
create function public.mis_complejos_colaborador()
returns table (complejo_id text, dueno_id uuid, p_agenda boolean, p_resultados boolean, p_torneos boolean, p_canchas boolean, p_consumos boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.complejo_id, x.dueno_id, c.p_agenda, c.p_resultados, c.p_torneos, c.p_canchas, c.p_consumos
  from colaboradores c
  join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
  join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = c.email;
$$;

revoke all on function public.mis_complejos_colaborador() from public, anon;
grant execute on function public.mis_complejos_colaborador() to authenticated;

-- ¿Puede manejar consumos de este complejo? (dueño o colaborador con el permiso)
create or replace function public.puede_consumos(p_complejo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_dueno_complejo(p_complejo) or public.colaborador_permiso(p_complejo, 'consumos');
$$;

revoke all on function public.puede_consumos(text) from public, anon;
grant execute on function public.puede_consumos(text) to authenticated;

-- ============================================================
-- Tablas
-- ============================================================

create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 40),
  precio numeric(10, 2) not null check (precio >= 0),
  stock int, -- null = no se controla
  aviso_stock int check (aviso_stock is null or aviso_stock >= 0), -- avisar cuando queden esto o menos
  activo boolean not null default true,
  orden int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, complejo_id)
);

create table if not exists public.cuentas (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null references public.complejos(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 80),
  telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$'),
  nota text check (nota is null or char_length(nota) <= 200),
  created_at timestamptz not null default now(),
  unique (id, complejo_id)
);
create unique index if not exists cuentas_un_telefono on public.cuentas (complejo_id, telefono) where telefono is not null;

create table if not exists public.cuenta_consumos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  cuenta_id uuid not null,
  producto_id uuid,
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 60),
  cantidad int not null check (cantidad between 1 and 999),
  precio_unitario numeric(10, 2) not null check (precio_unitario >= 0),
  cargado_por uuid not null default auth.uid(),
  cargado_por_email text,
  created_at timestamptz not null default now(),
  foreign key (cuenta_id, complejo_id) references public.cuentas (id, complejo_id) on delete cascade,
  foreign key (producto_id, complejo_id) references public.productos (id, complejo_id) on delete set null (producto_id)
);
create index if not exists consumos_por_cuenta on public.cuenta_consumos (cuenta_id);

create table if not exists public.cuenta_pagos (
  id uuid primary key default gen_random_uuid(),
  complejo_id text not null,
  cuenta_id uuid not null,
  monto numeric(10, 2) not null check (monto > 0 and monto < 100000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  cobrado_por uuid not null default auth.uid(),
  cobrado_por_email text,
  created_at timestamptz not null default now(),
  foreign key (cuenta_id, complejo_id) references public.cuentas (id, complejo_id) on delete cascade
);
create index if not exists pagos_cuenta_por_complejo on public.cuenta_pagos (complejo_id, created_at);

-- ============================================================
-- Disparadores: quién, precio del producto y stock
-- ============================================================

-- Al anotar: quién fue (de la sesión), nombre y precio del producto (no los que mande el navegador)
-- y se descuenta el stock
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
    new.descripcion := v_p.nombre;
    new.precio_unitario := v_p.precio;
    if v_p.stock is not null then
      update productos set stock = stock - new.cantidad where id = v_p.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists consumo_al_anotar on public.cuenta_consumos;
create trigger consumo_al_anotar before insert on public.cuenta_consumos
  for each row execute function public.consumo_al_anotar();

-- Al anular un consumo, el stock vuelve
create or replace function public.consumo_al_anular()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.producto_id is not null then
    update productos set stock = stock + old.cantidad where id = old.producto_id and stock is not null;
  end if;
  return old;
end;
$$;

drop trigger if exists consumo_al_anular on public.cuenta_consumos;
create trigger consumo_al_anular after delete on public.cuenta_consumos
  for each row execute function public.consumo_al_anular();

create or replace function public.pago_cuenta_quien()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.cobrado_por := auth.uid();
  new.cobrado_por_email := (select email from auth.users where id = auth.uid());
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists pago_cuenta_quien on public.cuenta_pagos;
create trigger pago_cuenta_quien before insert on public.cuenta_pagos
  for each row execute function public.pago_cuenta_quien();

-- Reponer stock: el dueño o un colaborador con permiso de consumos
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
  update productos set stock = coalesce(stock, 0) + p_cantidad where id = p_producto returning stock into v_p.stock;
  return v_p.stock;
end;
$$;

revoke all on function public.sumar_stock(uuid, int) from public, anon;
grant execute on function public.sumar_stock(uuid, int) to authenticated;

-- Cuentas con lo consumido, lo pagado y la última actividad (para la lista y los deudores)
create or replace function public.cuentas_con_saldo(p_complejo text)
returns table (id uuid, nombre text, telefono text, nota text, consumido numeric, pagado numeric, ultimo timestamptz)
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
                    (select max(p.created_at) from cuenta_pagos p where p.cuenta_id = c.id))
    from cuentas c
    where c.complejo_id = p_complejo;
end;
$$;

revoke all on function public.cuentas_con_saldo(text) from public, anon;
grant execute on function public.cuentas_con_saldo(text) to authenticated;

-- ============================================================
-- Permisos
-- ============================================================

alter table public.productos enable row level security;
alter table public.cuentas enable row level security;
alter table public.cuenta_consumos enable row level security;
alter table public.cuenta_pagos enable row level security;
revoke all on public.productos, public.cuentas, public.cuenta_consumos, public.cuenta_pagos from public, anon, authenticated;
grant select, insert, update, delete on public.productos, public.cuentas to authenticated;
grant select, insert, delete on public.cuenta_consumos, public.cuenta_pagos to authenticated;

-- productos: los ven quienes manejan consumos; los cambia el dueño (el stock, también sumar_stock)
drop policy if exists "Ven productos" on public.productos;
create policy "Ven productos" on public.productos for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "El dueño carga productos" on public.productos;
create policy "El dueño carga productos" on public.productos for insert to authenticated with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño cambia productos" on public.productos;
create policy "El dueño cambia productos" on public.productos for update to authenticated
  using (public.es_dueno_complejo(complejo_id)) with check (public.es_dueno_complejo(complejo_id));
drop policy if exists "El dueño borra productos" on public.productos;
create policy "El dueño borra productos" on public.productos for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- cuentas: las ven, crean y corrigen quienes manejan consumos; borrarlas es del dueño
drop policy if exists "Ven cuentas" on public.cuentas;
create policy "Ven cuentas" on public.cuentas for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Crean cuentas" on public.cuentas;
create policy "Crean cuentas" on public.cuentas for insert to authenticated with check (public.puede_consumos(complejo_id));
drop policy if exists "Corrigen cuentas" on public.cuentas;
create policy "Corrigen cuentas" on public.cuentas for update to authenticated
  using (public.puede_consumos(complejo_id)) with check (public.puede_consumos(complejo_id));
drop policy if exists "El dueño borra cuentas" on public.cuentas;
create policy "El dueño borra cuentas" on public.cuentas for delete to authenticated using (public.es_dueno_complejo(complejo_id));

-- consumos y pagos: los ven y anotan quienes manejan consumos; anularlos es del dueño
drop policy if exists "Ven consumos" on public.cuenta_consumos;
create policy "Ven consumos" on public.cuenta_consumos for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Anotan consumos" on public.cuenta_consumos;
create policy "Anotan consumos" on public.cuenta_consumos for insert to authenticated with check (public.puede_consumos(complejo_id));
drop policy if exists "El dueño anula consumos" on public.cuenta_consumos;
create policy "El dueño anula consumos" on public.cuenta_consumos for delete to authenticated using (public.es_dueno_complejo(complejo_id));

drop policy if exists "Ven pagos de cuentas" on public.cuenta_pagos;
create policy "Ven pagos de cuentas" on public.cuenta_pagos for select to authenticated using (public.puede_consumos(complejo_id));
drop policy if exists "Cobran cuentas" on public.cuenta_pagos;
create policy "Cobran cuentas" on public.cuenta_pagos for insert to authenticated with check (public.puede_consumos(complejo_id));
drop policy if exists "El dueño anula pagos de cuentas" on public.cuenta_pagos;
create policy "El dueño anula pagos de cuentas" on public.cuenta_pagos for delete to authenticated using (public.es_dueno_complejo(complejo_id));
