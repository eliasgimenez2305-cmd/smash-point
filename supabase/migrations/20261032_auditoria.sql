-- Arreglos de la auditoría general (16/10/2026):
-- 1. cobrar_todo acepta débito (la pantalla lo ofrecía y la base lo rechazaba) y bloquea la cuenta
--    mientras cobra, para que dos cobros a la vez no paguen dos veces la misma inscripción.
-- 2. Turnos cobrados protegidos: un empleado no puede sacarle el cobro, cambiarle el precio o el
--    tipo, cancelarlo ni borrarlo (así la plata no desaparece del arqueo de su caja). El dueño sí.
--    El jugador puede seguir cancelando su propia reserva (cancelar_mi_reserva).
-- 3. Corregir el medio de un turno ya cobrado no cambia quién lo cobró ni cuándo.
-- 4. pedir_turno: máximo 2 pedidos pendientes por jugador en cada complejo, y solo en complejos con
--    el módulo Reservas prendido.
-- 5. Reponer stock: el empleado solo suma; restar queda para el dueño.
-- 6. pagar_compra: exige un medio válido y la fecha por defecto es la de Argentina (no la de UTC).
-- 7. Índices que faltaban en columnas que se filtran siempre.
--
-- Se corre una vez en Supabase > SQL Editor, después de 20261031_fichas_complejos.sql.
-- Prueba: supabase/pruebas/auditoria.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

-- ============================================================
-- 1. cobrar_todo con débito y con la cuenta bloqueada
-- ============================================================

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
  select * into v_c from cuentas where id = p_cuenta for update;
  if not found or not public.puede_consumos(v_c.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if p_monto is null or p_monto <= 0 or p_monto >= 100000000 or p_medio not in ('efectivo', 'transferencia', 'mercado_pago', 'debito') then
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

-- ============================================================
-- 2 y 3. Turnos cobrados
-- ============================================================

-- Quién cobró: se anota al cobrar; corregir el medio no lo cambia
create or replace function public.reserva_cobro_quien()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.medio_pago is null then
    new.cobrado_por := null;
    new.cobrado_at := null;
  elsif tg_op = 'INSERT' or old.medio_pago is null then
    new.cobrado_por := auth.uid();
    new.cobrado_at := now();
  else
    new.cobrado_por := old.cobrado_por;
    new.cobrado_at := old.cobrado_at;
  end if;
  return new;
end;
$$;

-- Un turno cobrado solo lo des-cobra, le cambia el precio o el tipo, lo cancela o lo borra el dueño
-- (o el propio jugador cancelando su reserva)
create or replace function public.reserva_cobrada_protegida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.medio_pago is null or public.es_dueno_complejo(old.complejo_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'turno_cobrado';
  end if;
  if old.jugador_id is not null and old.jugador_id = auth.uid() and new.estado = 'cancelada'
     and new.medio_pago is not distinct from old.medio_pago and new.precio is not distinct from old.precio and new.tipo = old.tipo then
    return new;
  end if;
  if new.medio_pago is null or new.precio is distinct from old.precio or new.tipo <> old.tipo or new.estado <> old.estado then
    raise exception 'turno_cobrado';
  end if;
  return new;
end;
$$;

drop trigger if exists reserva_cobrada_protegida on public.reservas;
create trigger reserva_cobrada_protegida before update or delete on public.reservas
  for each row execute function public.reserva_cobrada_protegida();

-- ============================================================
-- 4. pedir_turno: tope de pedidos pendientes y módulo Reservas
-- ============================================================

create or replace function public.pedir_turno(p_cancha uuid, p_fecha date, p_minuto int, p_duracion int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador jugadores%rowtype;
  v_cancha canchas%rowtype;
  v_precio numeric;
  v_abre int;
  v_cierra int;
  v_inicio timestamptz;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sin_sesion';
  end if;
  select * into v_jugador from jugadores where id = auth.uid();
  if not found then
    raise exception 'sin_perfil';
  end if;

  select c.* into v_cancha
  from canchas c join complejos x on x.id = c.complejo_id
  where c.id = p_cancha and c.activa and c.reserva_online and x.reservas_habilitadas and x.modulo_reservas;
  if not found then
    raise exception 'cancha_invalida';
  end if;

  v_precio := case p_duracion when 60 then v_cancha.precio_60 when 90 then v_cancha.precio_90 when 120 then v_cancha.precio_120 end;
  if v_precio is null then
    raise exception 'duracion_invalida';
  end if;

  v_abre := extract(hour from v_cancha.apertura)::int * 60 + extract(minute from v_cancha.apertura)::int;
  v_cierra := extract(hour from v_cancha.cierre)::int * 60 + extract(minute from v_cancha.cierre)::int;
  if v_cierra <= v_abre then
    v_cierra := v_cierra + 1440;
  end if;
  if p_minuto is null or p_minuto % 30 <> 0 or p_minuto < v_abre or p_minuto + p_duracion > v_cierra then
    raise exception 'fuera_de_horario';
  end if;

  v_inicio := (p_fecha::timestamp + make_interval(mins => p_minuto)) at time zone 'America/Argentina/Buenos_Aires';
  if v_inicio <= now() then
    raise exception 'horario_pasado';
  end if;
  if p_fecha > v_hoy + 30 then
    raise exception 'muy_adelante';
  end if;

  if exists (select 1 from jugadores_bloqueados where complejo_id = v_cancha.complejo_id and jugador_id = auth.uid()) then
    raise exception 'bloqueado';
  end if;

  perform public.vencer_pedidos();

  -- Un jugador no puede tener tomadas muchas canchas sin confirmar
  if (select count(*) from reservas where complejo_id = v_cancha.complejo_id and jugador_id = auth.uid() and estado = 'pendiente') >= 2 then
    raise exception 'demasiados_pedidos';
  end if;

  begin
    insert into reservas (complejo_id, cancha_id, tipo, fecha, inicio, fin, estado, origen, nombre, telefono, jugador_id, precio, vence_at, creada_por)
    values (v_cancha.complejo_id, v_cancha.id, 'turno', p_fecha, v_inicio, v_inicio + make_interval(mins => p_duracion), 'pendiente', 'online',
            left(btrim(v_jugador.nombre) || ' ' || btrim(v_jugador.apellido), 80), v_jugador.telefono, auth.uid(), v_precio,
            least(now() + interval '24 hours', v_inicio), auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'ocupado';
  end;

  return v_id;
end;
$$;

revoke all on function public.pedir_turno(uuid, date, int, int) from public, anon;
grant execute on function public.pedir_turno(uuid, date, int, int) to authenticated;

-- ============================================================
-- 5. Reponer stock: restar solo el dueño
-- ============================================================

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
  if p_cantidad < 0 and not public.es_dueno_complejo(v_p.complejo_id) then
    raise exception 'no_autorizado';
  end if;
  if public.tiene_talles(p_producto) then
    raise exception 'elegir_talle';
  end if;
  update productos set stock = coalesce(stock, 0) + p_cantidad where id = p_producto returning stock into v_p.stock;
  return v_p.stock;
end;
$$;

revoke all on function public.sumar_stock(uuid, int) from public, anon;
grant execute on function public.sumar_stock(uuid, int) to authenticated;

create or replace function public.sumar_stock_talle(p_producto uuid, p_talle text, p_cantidad int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complejo text;
  v_stock int;
begin
  -- Se bloquea el producto: el trigger de talles recalcula su stock total
  select complejo_id into v_complejo from productos where id = p_producto for update;
  if v_complejo is null or not public.puede_consumos(v_complejo) then
    raise exception 'no_autorizado';
  end if;
  if p_cantidad is null or p_cantidad = 0 or abs(p_cantidad) > 100000 then
    raise exception 'datos_invalidos';
  end if;
  if p_cantidad < 0 and not public.es_dueno_complejo(v_complejo) then
    raise exception 'no_autorizado';
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

-- ============================================================
-- 6. pagar_compra
-- ============================================================

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
  if p_medio is null or p_medio not in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito') then
    raise exception 'datos_invalidos';
  end if;
  update compras set medio = p_medio, pagada_at = coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date) where id = c.id;
end;
$$;

revoke all on function public.pagar_compra(uuid, text, date) from public, anon;
grant execute on function public.pagar_compra(uuid, text, date) to authenticated;

-- ============================================================
-- 7. Índices
-- ============================================================

create index if not exists productos_por_complejo on public.productos (complejo_id);
create index if not exists cuentas_por_complejo on public.cuentas (complejo_id);
create index if not exists cuenta_pagos_por_cuenta on public.cuenta_pagos (cuenta_id);
create index if not exists venta_items_por_complejo on public.venta_items (complejo_id);
create index if not exists alumnos_por_complejo on public.alumnos (complejo_id);
create index if not exists profes_por_complejo on public.profes_complejo (complejo_id);
create index if not exists reservas_pendientes_jugador on public.reservas (jugador_id) where estado = 'pendiente';

-- ============================================================
-- Vuelta atrás (las funciones vuelven a su versión de 20261015, 20261022, 20261025, 20261026 y 20261030:
-- volver a correr esos bloques)
-- ============================================================
--   drop trigger if exists reserva_cobrada_protegida on public.reservas;
--   drop function if exists public.reserva_cobrada_protegida();
--   drop index if exists public.productos_por_complejo, public.cuentas_por_complejo, public.cuenta_pagos_por_cuenta,
--     public.venta_items_por_complejo, public.alumnos_por_complejo, public.profes_por_complejo, public.reservas_pendientes_jugador;
