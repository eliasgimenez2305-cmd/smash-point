-- Cobro de un turno en dos medios y "Bonificado" (03/11/2026)
--
-- - Un turno se puede cobrar con dos medios: reservas.medio_pago (lo que no va en el segundo) y
--   reservas.medio_pago2 + monto_pago2 (el segundo). Si se cambia el precio y el segundo ya no entra,
--   o se saca el cobro, el segundo se borra solo.
-- - "bonificado" es un medio más en turnos, inscripciones, cuentas de la cantina y cuotas de clases:
--   deja pagado pero no es plata, así que no va al libro de caja, ni a la caja del día, ni al arqueo.
--   La caja del día lo informa aparte (bonificado).
-- - El libro anota la segunda parte del turno con ref_tipo 'turno2'.
-- - El Mostrador ("Cobrar turno o inscripción") ya puede repartir la cancha en dos medios.
--
-- Prueba: supabase/pruebas/dos_medios_y_bonificado.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

-- ============================================================
-- 1. Medios: el segundo medio del turno y "bonificado"
-- ============================================================

alter table public.reservas add column if not exists medio_pago2 text;
alter table public.reservas add column if not exists monto_pago2 numeric;

alter table public.reservas drop constraint if exists reservas_medio_pago_check;
alter table public.reservas add constraint reservas_medio_pago_check
  check (medio_pago is null or medio_pago in ('efectivo', 'mercado_pago', 'transferencia', 'debito', 'bonificado'));
alter table public.reservas drop constraint if exists reservas_medio_pago2_check;
alter table public.reservas add constraint reservas_medio_pago2_check check (
  (medio_pago2 is null) = (monto_pago2 is null)
  and (medio_pago2 is null or (medio_pago is not null and medio_pago2 <> medio_pago
       and medio_pago2 in ('efectivo', 'mercado_pago', 'transferencia', 'debito', 'bonificado') and monto_pago2 > 0)));

alter table public.cuenta_pagos drop constraint if exists cuenta_pagos_medio_check;
alter table public.cuenta_pagos add constraint cuenta_pagos_medio_check
  check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'bonificado'));
alter table public.pagos_inscripcion drop constraint if exists pagos_inscripcion_medio_check;
alter table public.pagos_inscripcion add constraint pagos_inscripcion_medio_check
  check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'bonificado'));
alter table public.cuotas_alumnos drop constraint if exists cuotas_alumnos_medio_check;
alter table public.cuotas_alumnos add constraint cuotas_alumnos_medio_check
  check (medio in ('efectivo', 'transferencia', 'mercado_pago', 'bonificado'));

alter table public.movimientos drop constraint if exists movimientos_ref_tipo_check;
alter table public.movimientos add constraint movimientos_ref_tipo_check check (ref_tipo in ('inscripcion', 'turno', 'turno2', 'cuenta', 'venta', 'caja_dia',
  'cuota_clase', 'pago_profe', 'compra', 'caja_vieja', 'caja_apertura', 'caja_cierre', 'devolucion'));

-- Sin cobro no hay segundo medio; y si el segundo ya no entra en el precio (se cambió), se saca
create or replace function public.reserva_cobro_dividido() returns trigger
language plpgsql as $$
begin
  if new.medio_pago is null or new.medio_pago2 is null or new.precio is null or new.monto_pago2 >= new.precio then
    new.medio_pago2 := null;
    new.monto_pago2 := null;
  end if;
  return new;
end; $$;
drop trigger if exists reserva_cobro_dividido on public.reservas;
create trigger reserva_cobro_dividido before insert or update of medio_pago, medio_pago2, monto_pago2, precio
  on public.reservas for each row execute function public.reserva_cobro_dividido();

-- ============================================================
-- 2. Libro de caja: la segunda parte del turno, y lo bonificado afuera
-- ============================================================

create or replace function public._libro_turno(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r reservas%rowtype; v_dueno uuid; v_cobrado boolean; v_p2 numeric;
begin
  select * into r from reservas where id = p_id;
  select dueno_id into v_dueno from complejos where id = r.complejo_id;
  v_cobrado := r.id is not null and r.tipo in ('turno', 'clase') and r.estado = 'confirmada' and r.medio_pago is not null and r.precio is not null;
  v_p2 := case when r.medio_pago2 is not null then r.monto_pago2 else 0 end;
  perform _libro_poner('turno', p_id, v_cobrado and r.medio_pago <> 'bonificado',
    v_dueno, r.complejo_id, 'ingreso', case when r.tipo = 'clase' then 'clases' else 'turnos' end, r.precio - v_p2, r.medio_pago,
    case when r.tipo = 'clase' then 'Clase · ' else 'Turno · ' end || coalesce(r.nombre, 'sin nombre'),
    r.fecha, coalesce(r.cobrado_por, r.creada_por), r.id::text,
    _caja_del_dia(r.complejo_id, r.cobrado_por, r.medio_pago, coalesce(r.cobrado_at, r.created_at)),
    'El turno se canceló o se sacó el cobro');
  perform _libro_poner('turno2', p_id, v_cobrado and r.medio_pago2 is not null and r.medio_pago2 <> 'bonificado',
    v_dueno, r.complejo_id, 'ingreso', case when r.tipo = 'clase' then 'clases' else 'turnos' end, v_p2, r.medio_pago2,
    case when r.tipo = 'clase' then 'Clase · ' else 'Turno · ' end || coalesce(r.nombre, 'sin nombre') || ' (2.º medio)',
    r.fecha, coalesce(r.cobrado_por, r.creada_por), r.id::text,
    _caja_del_dia(r.complejo_id, r.cobrado_por, r.medio_pago2, coalesce(r.cobrado_at, r.created_at)),
    'El turno se canceló o se sacó el cobro');
end; $$;

create or replace function public._libro_inscripcion(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p pagos_inscripcion%rowtype;
begin
  select * into p from pagos_inscripcion where id = p_id;
  perform _libro_poner('inscripcion', p_id, p.id is not null and p.medio <> 'bonificado', p.organizador_id, null, 'ingreso', 'torneos', p.monto, p.medio,
    'Inscripción · ' || coalesce((select datos->>'name' from torneos where id = p.torneo_id), 'torneo'),
    _fecha_ar(p.created_at), p.cobrado_por, p.torneo_id, null);
end; $$;

create or replace function public._libro_cuenta(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p cuenta_pagos%rowtype; v_dueno uuid;
begin
  select * into p from cuenta_pagos where id = p_id;
  select dueno_id into v_dueno from complejos where id = p.complejo_id;
  perform _libro_poner('cuenta', p_id, p.id is not null and p.medio <> 'bonificado', v_dueno, p.complejo_id, 'ingreso', 'cuentas', p.monto, p.medio,
    'Cuenta · ' || coalesce((select nombre from cuentas where id = p.cuenta_id), 'cuenta'),
    _fecha_ar(p.created_at), p.cobrado_por, p.cuenta_id::text, _caja_del_dia(p.complejo_id, p.cobrado_por, p.medio, p.created_at));
end; $$;

create or replace function public._libro_cuota(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare q cuotas_alumnos%rowtype; v_dueno uuid;
begin
  select * into q from cuotas_alumnos where id = p_id;
  select dueno_id into v_dueno from complejos where id = q.complejo_id;
  perform _libro_poner('cuota_clase', p_id, q.id is not null and q.medio <> 'bonificado', v_dueno, q.complejo_id, 'ingreso', 'clases', q.monto, q.medio,
    'Cuota ' || coalesce(q.periodo, '') || ' · ' || coalesce((select nombre from alumnos where id = q.alumno_id), 'alumno'),
    _fecha_ar(q.created_at), q.cobrado_por, q.alumno_id::text, _caja_del_dia(q.complejo_id, q.cobrado_por, q.medio, q.created_at));
end; $$;

drop trigger if exists libro_caja on public.reservas;
create trigger libro_caja after insert or delete or update of estado, tipo, precio, medio_pago, medio_pago2, monto_pago2, fecha, nombre, complejo_id, cobrado_por, cobrado_at
  on public.reservas for each row execute function public.libro_desde_origen();

-- El control del libro compara contra los orígenes sin lo bonificado y con las dos partes del turno
create or replace function public.control_libro_caja()
returns table (dueno_id uuid, mes text, tipo text, caja_hoy bigint, libro bigint)
language sql stable security definer set search_path = public as $$
  with vieja as (
    select p.organizador_id d, _fecha_ar(p.created_at) f, 'ingreso' t, p.monto m from pagos_inscripcion p where p.medio <> 'bonificado'
    union all
    select c.dueno_id, r.fecha, 'ingreso',
           (case when r.medio_pago <> 'bonificado' then r.precio - coalesce(r.monto_pago2, 0) else 0 end)
           + (case when r.medio_pago2 is not null and r.medio_pago2 <> 'bonificado' then r.monto_pago2 else 0 end)
      from reservas r join complejos c on c.id = r.complejo_id
      where r.tipo in ('turno', 'clase') and r.estado = 'confirmada' and r.medio_pago is not null and r.precio is not null
    union all
    select c.dueno_id, _fecha_ar(p.created_at), 'ingreso', p.monto from cuenta_pagos p join complejos c on c.id = p.complejo_id where p.medio <> 'bonificado'
    union all
    select c.dueno_id, _fecha_ar(p.created_at), 'ingreso', p.monto from venta_pagos p join ventas v on v.id = p.venta_id join complejos c on c.id = p.complejo_id
      where not v.anulada or v.devuelta
    union all
    select c.dueno_id, _fecha_ar(m.created_at), m.tipo, m.monto from caja_movimientos_turno m join complejos c on c.id = m.complejo_id
      where m.tipo in ('ingreso', 'gasto')
    union all
    select c.dueno_id, _fecha_ar(q.created_at), 'ingreso', q.monto from cuotas_alumnos q join complejos c on c.id = q.complejo_id where q.medio <> 'bonificado'
    union all
    select c.dueno_id, _fecha_ar(x.created_at), 'gasto', x.monto from pagos_profes x join complejos c on c.id = x.complejo_id
    union all
    select c.dueno_id, k.pagada_at, 'gasto', k.total from compras k join complejos c on c.id = k.complejo_id
      where not k.anulada and k.pagada_at is not null
    union all
    select m.organizador_id, m.fecha, m.tipo, m.monto from caja_movimientos m
  ), v as (
    select d, to_char(f, 'YYYY-MM') mes, t, round(sum(m) * 100)::bigint total from vieja where d is not null and m > 0 group by 1, 2, 3
  ), l as (
    select dueno_id d, to_char(fecha, 'YYYY-MM') mes, tipo t, sum(monto)::bigint total from movimientos
    where anulado_at is null and tipo in ('ingreso', 'gasto') and ref_tipo is not null and ref_tipo <> 'devolucion' group by 1, 2, 3
  )
  select coalesce(v.d, l.d), coalesce(v.mes, l.mes), coalesce(v.t, l.t), coalesce(v.total, 0), coalesce(l.total, 0)
  from v full join l on l.d = v.d and l.mes = v.mes and l.t = v.t
  order by 1, 2, 3;
$$;

-- Los cobros no en efectivo de una caja (para tildar al cerrar), también la segunda parte del turno
create or replace function public.cobros_para_confirmar(p_turno uuid)
returns table (id uuid, concepto text, medio text, monto bigint, cargado_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare t caja_turnos%rowtype; v_dueno uuid;
begin
  select * into t from caja_turnos where caja_turnos.id = p_turno;
  if not found or not (t.usuario = auth.uid() or public.es_dueno_complejo(t.complejo_id)) then raise exception 'no_autorizado'; end if;
  select dueno_id into v_dueno from complejos where complejos.id = t.complejo_id;
  return query
    select m.id, m.concepto, m.medio, m.monto, m.cargado_at from movimientos m
    where m.dueno_id = v_dueno and m.anulado_at is null and m.medio <> 'efectivo'
      and m.ref_tipo in ('inscripcion', 'turno', 'turno2', 'cuenta', 'venta', 'cuota_clase')
      and m.cargado_por = t.usuario and (m.complejo_id = t.complejo_id or m.ref_tipo = 'inscripcion')
      and m.cargado_at >= t.abierta_at and m.cargado_at <= coalesce(t.cerrada_at, now())
    order by m.cargado_at;
end; $$;
revoke all on function public.cobros_para_confirmar(uuid) from public, anon;
grant execute on function public.cobros_para_confirmar(uuid) to authenticated;

-- ============================================================
-- 3. Caja del día: las dos partes del turno; lo bonificado aparte (no es plata de la caja)
-- ============================================================

create or replace function public._resumen_turno(p_turno uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t caja_turnos%rowtype;
  v_dueno uuid;
  v_hasta timestamptz;
  v_por_medio jsonb;
  v_por_origen jsonb;
  v_efectivo numeric;
  v_bonificado numeric;
  v_ing numeric;
  v_ret numeric;
  v_gas numeric;
  v_dev numeric;
begin
  select * into t from caja_turnos where id = p_turno;
  v_hasta := coalesce(t.cerrada_at, now());
  select dueno_id into v_dueno from complejos where id = t.complejo_id;

  with todos (origen, medio, monto) as (
    select 'mostrador', p.medio, p.monto
      from venta_pagos p join ventas v on v.id = p.venta_id
     where v.complejo_id = t.complejo_id and coalesce(p.cobrado_por, v.vendido_por) = t.usuario and (not v.anulada or v.devuelta)
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'cuentas', p.medio, p.monto
      from cuenta_pagos p
     where p.complejo_id = t.complejo_id and p.cobrado_por = t.usuario
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'inscripciones', p.medio, p.monto
      from pagos_inscripcion p
     where p.organizador_id = v_dueno and p.cobrado_por = t.usuario
       and p.created_at >= t.abierta_at and p.created_at <= v_hasta
    union all
    select 'turnos', r.medio_pago, r.precio - coalesce(r.monto_pago2, 0)
      from reservas r
     where r.complejo_id = t.complejo_id and r.cobrado_por = t.usuario and r.estado = 'confirmada'
       and r.precio is not null and r.precio > 0
       and r.cobrado_at >= t.abierta_at and r.cobrado_at <= v_hasta
    union all
    select 'turnos', r.medio_pago2, r.monto_pago2
      from reservas r
     where r.complejo_id = t.complejo_id and r.cobrado_por = t.usuario and r.estado = 'confirmada'
       and r.medio_pago2 is not null and r.precio is not null and r.precio > 0
       and r.cobrado_at >= t.abierta_at and r.cobrado_at <= v_hasta
    union all
    select 'clases', q.medio, q.monto
      from cuotas_alumnos q
     where q.complejo_id = t.complejo_id and q.cobrado_por = t.usuario
       and q.created_at >= t.abierta_at and q.created_at <= v_hasta
  ), cobros as (select * from todos where medio <> 'bonificado')
  select
    (select coalesce(jsonb_object_agg(medio, total), '{}'::jsonb) from (select medio, sum(monto) as total from cobros group by medio) a),
    (select coalesce(jsonb_object_agg(origen, total), '{}'::jsonb) from (select origen, sum(monto) as total from cobros group by origen) b),
    (select coalesce(sum(monto), 0) from cobros where medio = 'efectivo'),
    (select coalesce(sum(monto), 0) from todos where medio = 'bonificado')
  into v_por_medio, v_por_origen, v_efectivo, v_bonificado;

  select coalesce(sum(monto) filter (where tipo = 'ingreso'), 0),
         coalesce(sum(monto) filter (where tipo = 'retiro'), 0),
         coalesce(sum(monto) filter (where tipo = 'gasto'), 0)
    into v_ing, v_ret, v_gas
    from caja_movimientos_turno where turno_id = t.id;

  select coalesce(sum(monto), 0) / 100.0 into v_dev
    from movimientos where caja_turno_id = t.id and ref_tipo = 'devolucion' and anulado_at is null;

  return jsonb_build_object(
    'por_medio', v_por_medio, 'por_origen', v_por_origen,
    'fondo', t.fondo, 'efectivo_cobrado', v_efectivo, 'bonificado', v_bonificado,
    'ingresos', v_ing, 'retiros', v_ret, 'gastos', v_gas, 'devoluciones', v_dev,
    'efectivo_esperado', t.fondo + v_efectivo + v_ing - v_ret - v_gas - v_dev
  );
end;
$$;

-- Cobrar en efectivo exige la caja abierta: también si el efectivo es el segundo medio del turno
create or replace function public.exigir_caja_efectivo() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_complejo text;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'reservas' then
    if not ((new.medio_pago is not distinct from 'efectivo' and (tg_op = 'INSERT' or old.medio_pago is distinct from 'efectivo'))
            or (new.medio_pago2 is not distinct from 'efectivo' and (tg_op = 'INSERT' or old.medio_pago2 is distinct from 'efectivo'))) then
      return new;
    end if;
  else
    if new.medio is distinct from 'efectivo' then return new; end if;
  end if;
  v_complejo := new.complejo_id;
  if public.es_dueno_complejo(v_complejo)
     or not exists (select 1 from funciones where clave = 'cantina' and activa)
     or exists (select 1 from caja_turnos where complejo_id = v_complejo and usuario = auth.uid() and cerrada_at is null) then
    return new;
  end if;
  raise exception 'abrir_caja_primero';
end; $$;

-- ============================================================
-- 4. Cobros: "Cobrar todo" de una cuenta acepta bonificado; el Mostrador reparte la cancha en dos medios
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
  if p_monto is null or p_monto <= 0 or p_monto >= 100000000 or p_medio not in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'bonificado') then
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

create or replace function public.cobrar_turno_mostrador(p_reserva uuid, p_pagos jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservas%rowtype;
  v ventas%rowtype;
  v_medios text[];
  v_montos numeric[];
  v_cancha numeric := 0;
  v_falta numeric;
  v_pendiente numeric;
  v_medio_cancha text;
  v_medio2 text;
  v_monto2 numeric;
  i int;
  v_resto numeric;
  v_parte numeric;
begin
  select * into r from reservas where id = p_reserva for update;
  if not found or r.tipo <> 'turno' or r.estado <> 'confirmada' then raise exception 'turno_invalido'; end if;
  if not public.puede_turnos_consumos(r.complejo_id) then raise exception 'no_autorizado'; end if;
  select medios, montos into v_medios, v_montos from _pagos_validos(p_pagos);
  if r.medio_pago is null and coalesce(r.precio, 0) > 0 then v_cancha := r.precio; end if;
  select coalesce(sum(pendiente), 0) into v_pendiente from ventas where reserva_id = r.id and not anulada;
  if v_cancha + v_pendiente = 0 then raise exception 'nada_para_cobrar'; end if;
  if (select sum(m) from unnest(v_montos) m) <> v_cancha + v_pendiente then raise exception 'monto_no_coincide'; end if;

  -- La cancha: con el medio de más plata y, si no alcanza, el que sigue (hasta dos medios)
  if v_cancha > 0 then
    v_falta := v_cancha;
    for i in 1 .. cardinality(v_medios) loop
      exit when v_falta = 0;
      continue when v_montos[i] = 0;
      v_parte := least(v_falta, v_montos[i]);
      if v_medio_cancha is null then v_medio_cancha := v_medios[i];
      elsif v_medio2 is null then v_medio2 := v_medios[i]; v_monto2 := v_parte;
      else raise exception 'dividir_cancha'; end if;
      v_montos[i] := v_montos[i] - v_parte;
      v_falta := v_falta - v_parte;
    end loop;
    update reservas set medio_pago = v_medio_cancha, medio_pago2 = v_medio2, monto_pago2 = v_monto2 where id = r.id;
  end if;

  -- Los consumos: con lo que queda, repartido entre los medios
  for v in select * from ventas where reserva_id = r.id and pendiente > 0 and not anulada order by created_at for update loop
    v_resto := v.pendiente;
    for i in 1 .. cardinality(v_medios) loop
      exit when v_resto = 0;
      continue when v_montos[i] = 0;
      v_parte := least(v_resto, v_montos[i]);
      insert into venta_pagos (venta_id, complejo_id, medio, monto) values (v.id, v.complejo_id, v_medios[i], v_parte);
      v_montos[i] := v_montos[i] - v_parte;
      v_resto := v_resto - v_parte;
    end loop;
    update ventas set pendiente = 0 where id = v.id;
  end loop;
  return jsonb_build_object('cancha', v_cancha, 'consumos', v_pendiente, 'medio_cancha', v_medio_cancha, 'medio_cancha2', v_medio2);
end; $$;

-- ============================================================
-- Vuelta atrás (si hiciera falta):
--   drop trigger if exists reserva_cobro_dividido on public.reservas; drop function if exists public.reserva_cobro_dividido();
--   update reservas set medio_pago2 = null, monto_pago2 = null; (y volver a correr las funciones de 20261045,
--   20261046, 20261049, 20261051 y 20261032 que se redefinen acá)
--   Antes, pasar a otro medio lo que esté como 'bonificado' y después volver a poner los checks de 20261029.
-- ============================================================
