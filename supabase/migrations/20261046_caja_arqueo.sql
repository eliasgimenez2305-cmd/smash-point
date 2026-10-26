-- Caja nueva, etapa 3: abrir y cerrar la caja del día contando billetes, sobre el libro de 20261045.
--
-- - Abrir: se cuentan los billetes ($20.000 a $100). Ese fondo PASA de la cuenta de guardado
--   (por defecto "Caja fuerte") a Efectivo, con la caja del día marcada.
-- - Cerrar: se cuentan los billetes. Si no da igual que lo esperado, la diferencia queda como
--   "ajuste" en Efectivo con quién estaba a cargo. Después TODO lo contado sale de Efectivo: la
--   caja queda en $0. Va a la cuenta de guardado (lo que elige el organizador en Configurar) o, si
--   cierra el dueño, puede elegir otra cuenta o hacer un retiro de socio.
-- - Al cerrar se tildan los cobros con Mercado Pago, transferencia o tarjeta que se vieron entrar;
--   los que no, quedan marcados.
-- - Una caja cerrada solo la reabre el dueño (se anulan los movimientos del cierre, con motivo).
-- - Con la función Cantina/caja prendida, un EMPLEADO no puede cobrar en efectivo turnos,
--   ventas, cuentas ni cuotas sin tener su caja abierta en ese complejo. El dueño sí (la app avisa).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261045.

alter table public.caja_turnos add column if not exists conteo_apertura jsonb;
alter table public.caja_turnos add column if not exists conteo_cierre jsonb;
alter table public.caja_turnos add column if not exists confirmados jsonb;      -- ids de movimientos tildados al cerrar
alter table public.caja_turnos add column if not exists sin_confirmar int;      -- cobros no efectivo sin tildar
alter table public.caja_turnos add column if not exists destino_cierre text;    -- adónde fue el efectivo al cerrar
alter table public.caja_turnos add column if not exists reabierta_at timestamptz;
alter table public.caja_turnos add column if not exists reabierta_por uuid;
alter table public.caja_turnos add column if not exists reabierta_motivo text;

-- Movimientos que hace la caja del día (apertura y cierre)
alter table public.movimientos drop constraint if exists movimientos_ref_tipo_check;
alter table public.movimientos add constraint movimientos_ref_tipo_check check (ref_tipo in ('inscripcion', 'turno', 'cuenta', 'venta', 'caja_dia',
  'cuota_clase', 'pago_profe', 'compra', 'caja_vieja', 'caja_apertura', 'caja_cierre'));

-- Adónde va el efectivo al cerrar y de dónde sale el fondo al abrir
create table if not exists public.caja_config (
  dueno_id uuid primary key,
  cuenta_guardado uuid references public.cuentas_caja(id) on delete set null
);
alter table public.caja_config enable row level security;
revoke all on public.caja_config from public, anon, authenticated;
grant select on public.caja_config to authenticated;
drop policy if exists "Dueño ve su configuración" on public.caja_config;
create policy "Dueño ve su configuración" on public.caja_config for select to authenticated using (dueno_id = auth.uid());

create or replace function public._cuenta_guardado(p_dueno uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select g.cuenta_guardado from caja_config g join cuentas_caja c on c.id = g.cuenta_guardado and c.activa where g.dueno_id = p_dueno),
    (select id from cuentas_caja where dueno_id = p_dueno and nombre = 'Caja fuerte' and activa),
    _cuenta_de_medio(p_dueno, null, 'efectivo'));
$$;
revoke all on function public._cuenta_guardado(uuid) from public, anon, authenticated;

create or replace function public.elegir_cuenta_guardado(p_cuenta uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_dueno uuid := _soy_dueno_caja();
begin
  if not exists (select 1 from cuentas_caja where id = p_cuenta and dueno_id = v_dueno and activa) then raise exception 'cuenta_invalida'; end if;
  insert into caja_config (dueno_id, cuenta_guardado) values (v_dueno, p_cuenta)
  on conflict (dueno_id) do update set cuenta_guardado = excluded.cuenta_guardado;
end; $$;
revoke all on function public.elegir_cuenta_guardado(uuid) from public, anon;
grant execute on function public.elegir_cuenta_guardado(uuid) to authenticated;

-- Conteo de billetes {"20000": 3, "1000": 5, ...} → total en pesos (null si no es válido)
create or replace function public._total_conteo(p jsonb) returns numeric
language plpgsql immutable as $$
declare k text; v jsonb; total numeric := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  for k, v in select * from jsonb_each(p) loop
    if k not in ('20000', '10000', '2000', '1000', '500', '200', '100') or jsonb_typeof(v) <> 'number'
       or (v::text)::numeric <> trunc((v::text)::numeric) or (v::text)::numeric < 0 or (v::text)::numeric > 100000 then
      return null;
    end if;
    total := total + k::numeric * (v::text)::numeric;
  end loop;
  return total;
end; $$;

-- Abrir la caja contando el fondo
create or replace function public.abrir_caja_conteo(p_complejo text, p_conteo jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_fondo numeric := _total_conteo(p_conteo);
  v_dueno uuid;
  v_ef uuid; v_guardado uuid;
begin
  if not public.puede_caja(p_complejo) then raise exception 'no_autorizado'; end if;
  if v_fondo is null or v_fondo >= 100000000 then raise exception 'datos_invalidos'; end if;
  if exists (select 1 from caja_turnos where complejo_id = p_complejo and usuario = auth.uid() and cerrada_at is null) then
    raise exception 'caja_ya_abierta';
  end if;
  insert into caja_turnos (complejo_id, usuario, usuario_email, fondo, conteo_apertura)
  values (p_complejo, auth.uid(), (select coalesce(email, phone) from auth.users where id = auth.uid()), v_fondo, p_conteo)
  returning id into v_id;
  select dueno_id into v_dueno from complejos where id = p_complejo;
  if v_fondo > 0 and v_dueno is not null then
    perform _preparar_dueno(v_dueno);
    v_ef := _cuenta_de_medio(v_dueno, p_complejo, 'efectivo');
    v_guardado := _cuenta_guardado(v_dueno);
    if v_guardado is not null and v_guardado <> v_ef then
      insert into movimientos (dueno_id, complejo_id, tipo, cuenta_id, cuenta_destino_id, sentido, monto, medio, concepto, fecha,
                               cargado_por, caja_turno_id, ref_tipo, ref_id)
      values (v_dueno, p_complejo, 'transferencia_interna', v_guardado, v_ef, -1, round(v_fondo * 100)::bigint, 'efectivo',
              'Fondo para abrir la caja', _fecha_ar(now()), auth.uid(), v_id, 'caja_apertura', v_id::text);
    end if;
  end if;
  return v_id;
end; $$;
revoke all on function public.abrir_caja_conteo(text, jsonb) from public, anon;
grant execute on function public.abrir_caja_conteo(text, jsonb) to authenticated;

-- Cobros que no son en efectivo de esa caja (para tildar al cerrar)
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
      and m.ref_tipo in ('inscripcion', 'turno', 'cuenta', 'venta', 'cuota_clase')
      and m.cargado_por = t.usuario and (m.complejo_id = t.complejo_id or m.ref_tipo = 'inscripcion')
      and m.cargado_at >= t.abierta_at and m.cargado_at <= coalesce(t.cerrada_at, now())
    order by m.cargado_at;
end; $$;
revoke all on function public.cobros_para_confirmar(uuid) from public, anon;
grant execute on function public.cobros_para_confirmar(uuid) to authenticated;

-- Cerrar contando: diferencia como ajuste y todo el efectivo afuera (la caja queda en $0).
--   p_destino: 'guardado' (la cuenta de guardado), 'cuenta' (p_cuenta, solo el dueño) o 'socio' (retiro, solo el dueño)
create or replace function public.cerrar_caja_conteo(
  p_turno uuid, p_conteo jsonb, p_nota text default null, p_confirmados uuid[] default '{}',
  p_destino text default 'guardado', p_cuenta uuid default null, p_socio uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t caja_turnos%rowtype;
  v_contado numeric := _total_conteo(p_conteo);
  v_resumen jsonb; v_esperado numeric; v_dif numeric;
  v_dueno uuid; v_es_dueno boolean; v_ef uuid; v_dest uuid;
  v_quien text; v_hoy date := _fecha_ar(now());
  v_pendientes int;
begin
  select * into t from caja_turnos where id = p_turno for update;
  if not found or not (t.usuario = auth.uid() or public.es_dueno_complejo(t.complejo_id)) then raise exception 'no_autorizado'; end if;
  if t.cerrada_at is not null then raise exception 'caja_cerrada'; end if;
  if v_contado is null or v_contado >= 100000000 then raise exception 'datos_invalidos'; end if;
  v_es_dueno := public.es_dueno_complejo(t.complejo_id);
  if p_destino not in ('guardado', 'cuenta', 'socio') or (p_destino <> 'guardado' and not v_es_dueno) then raise exception 'no_autorizado'; end if;
  select dueno_id into v_dueno from complejos where id = t.complejo_id;

  update caja_turnos set cerrada_at = now() where id = t.id;
  v_resumen := public._resumen_turno(t.id);
  v_esperado := (v_resumen ->> 'efectivo_esperado')::numeric;
  v_dif := v_contado - v_esperado;
  select count(*) into v_pendientes from cobros_para_confirmar(t.id) c where not (c.id = any(coalesce(p_confirmados, '{}')));
  v_quien := coalesce(t.usuario_email, 'empleado');

  if v_dueno is not null then
    perform _preparar_dueno(v_dueno);
    v_ef := _cuenta_de_medio(v_dueno, t.complejo_id, 'efectivo');
    if v_dif <> 0 then
      insert into movimientos (dueno_id, complejo_id, tipo, cuenta_id, sentido, monto, medio, concepto, fecha, cargado_por, caja_turno_id, ref_tipo, ref_id)
      values (v_dueno, t.complejo_id, 'ajuste', v_ef, case when v_dif > 0 then 1 else -1 end, round(abs(v_dif) * 100)::bigint, 'efectivo',
              case when v_dif > 0 then 'Sobró' else 'Faltó' end || ' al cerrar la caja de ' || v_quien, v_hoy, auth.uid(), t.id, 'caja_cierre', t.id::text);
    end if;
    if v_contado > 0 then
      if p_destino = 'socio' then
        if p_socio is not null and not exists (select 1 from socios_caja where id = p_socio and dueno_id = v_dueno and activo) then raise exception 'socio_invalido'; end if;
        insert into movimientos (dueno_id, complejo_id, tipo, cuenta_id, socio_id, sentido, monto, medio, concepto, fecha, cargado_por, caja_turno_id, ref_tipo, ref_id)
        values (v_dueno, t.complejo_id, 'retiro_socio', v_ef, p_socio, -1, round(v_contado * 100)::bigint, 'efectivo',
                'Retiro al cerrar la caja de ' || v_quien, v_hoy, auth.uid(), t.id, 'caja_cierre', t.id::text);
      else
        v_dest := case when p_destino = 'cuenta' then p_cuenta else _cuenta_guardado(v_dueno) end;
        if not exists (select 1 from cuentas_caja where id = v_dest and dueno_id = v_dueno and activa) then raise exception 'cuenta_invalida'; end if;
        if v_dest <> v_ef then
          insert into movimientos (dueno_id, complejo_id, tipo, cuenta_id, cuenta_destino_id, sentido, monto, medio, concepto, fecha, cargado_por, caja_turno_id, ref_tipo, ref_id)
          values (v_dueno, t.complejo_id, 'transferencia_interna', v_ef, v_dest, -1, round(v_contado * 100)::bigint, 'efectivo',
                  'Cierre de la caja de ' || v_quien, v_hoy, auth.uid(), t.id, 'caja_cierre', t.id::text);
        end if;
      end if;
    end if;
  end if;

  update caja_turnos set
    resumen = v_resumen, esperado = v_esperado, contado = v_contado, conteo_cierre = p_conteo,
    nota = nullif(btrim(coalesce(p_nota, '')), ''),
    cerrada_por_email = (select coalesce(email, phone) from auth.users where id = auth.uid()),
    confirmados = to_jsonb(coalesce(p_confirmados, '{}')), sin_confirmar = v_pendientes,
    destino_cierre = case p_destino when 'socio' then 'Retiro de socio'
                     else (select nombre from cuentas_caja where id = coalesce(v_dest, v_ef)) end
  where id = t.id;
  return v_resumen || jsonb_build_object('contado', v_contado, 'diferencia', v_dif, 'sin_confirmar', v_pendientes);
end; $$;
revoke all on function public.cerrar_caja_conteo(uuid, jsonb, text, uuid[], text, uuid, uuid) from public, anon;
grant execute on function public.cerrar_caja_conteo(uuid, jsonb, text, uuid[], text, uuid, uuid) to authenticated;

-- Reabrir una caja cerrada (solo el dueño): se anulan los movimientos del cierre
create or replace function public.reabrir_caja(p_turno uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare t caja_turnos%rowtype;
begin
  select * into t from caja_turnos where id = p_turno for update;
  if not found or not public.es_dueno_complejo(t.complejo_id) then raise exception 'no_autorizado'; end if;
  if t.cerrada_at is null then raise exception 'caja_abierta'; end if;
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then raise exception 'falta_motivo'; end if;
  if exists (select 1 from caja_turnos where complejo_id = t.complejo_id and usuario = t.usuario and cerrada_at is null) then
    raise exception 'ya_tiene_otra_abierta';
  end if;
  -- Solo la última: el esperado sale de los cobros desde que se abrió, y volvería a contar los de una caja posterior
  if exists (select 1 from caja_turnos where complejo_id = t.complejo_id and usuario = t.usuario and abierta_at >= t.abierta_at and id <> t.id) then
    raise exception 'hay_una_caja_posterior';
  end if;
  update movimientos set anulado_at = now(), anulado_por = auth.uid(), anulado_motivo = 'Caja reabierta: ' || btrim(p_motivo)
  where ref_tipo = 'caja_cierre' and ref_id = t.id::text and anulado_at is null;
  update caja_turnos set cerrada_at = null, cerrada_por_email = null, contado = null, esperado = null, resumen = null,
    conteo_cierre = null, confirmados = null, sin_confirmar = null, destino_cierre = null,
    reabierta_at = now(), reabierta_por = auth.uid(), reabierta_motivo = btrim(p_motivo)
  where id = t.id;
end; $$;
revoke all on function public.reabrir_caja(uuid, text) from public, anon;
grant execute on function public.reabrir_caja(uuid, text) to authenticated;

-- Un empleado no cobra en efectivo sin su caja abierta (con Cantina/caja prendida; el dueño sí)
create or replace function public.exigir_caja_efectivo() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_medio text; v_complejo text;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'reservas' then
    v_medio := new.medio_pago;
    if v_medio is distinct from 'efectivo' or (tg_op = 'UPDATE' and old.medio_pago is not distinct from 'efectivo') then return new; end if;
  else
    v_medio := new.medio;
    if v_medio is distinct from 'efectivo' then return new; end if;
  end if;
  v_complejo := new.complejo_id;
  if public.es_dueno_complejo(v_complejo)
     or not exists (select 1 from funciones where clave = 'cantina' and activa)
     or exists (select 1 from caja_turnos where complejo_id = v_complejo and usuario = auth.uid() and cerrada_at is null) then
    return new;
  end if;
  raise exception 'abrir_caja_primero';
end; $$;
revoke all on function public.exigir_caja_efectivo() from public, anon, authenticated;

drop trigger if exists exigir_caja_efectivo on public.reservas;
create trigger exigir_caja_efectivo before insert or update of medio_pago on public.reservas
  for each row execute function public.exigir_caja_efectivo();
do $$
declare t text;
begin
  foreach t in array array['venta_pagos', 'cuenta_pagos', 'cuotas_alumnos'] loop
    execute format('drop trigger if exists exigir_caja_efectivo on public.%I', t);
    execute format('create trigger exigir_caja_efectivo before insert on public.%I for each row execute function public.exigir_caja_efectivo()', t);
  end loop;
end $$;

-- Vuelta atrás (si hiciera falta):
--   drop trigger if exists exigir_caja_efectivo on public.reservas; (y en venta_pagos, cuenta_pagos, cuotas_alumnos)
--   drop function if exists public.exigir_caja_efectivo(), public.reabrir_caja(uuid, text),
--     public.cerrar_caja_conteo(uuid, jsonb, text, uuid[], text, uuid, uuid), public.cobros_para_confirmar(uuid),
--     public.abrir_caja_conteo(text, jsonb), public._total_conteo(jsonb), public.elegir_cuenta_guardado(uuid), public._cuenta_guardado(uuid);
--   drop table if exists public.caja_config;
