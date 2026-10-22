-- Cobrar un turno o una inscripción desde el Mostrador, con el pago dividido si hace falta.
--
-- - cobrar_turno_mostrador(): cobra la cancha (si no estaba cobrada) y los consumos cargados al turno,
--   todo junto. La cancha se paga con UN medio (el turno guarda un solo medio de pago): se usa uno que
--   alcance; el resto de los pagos va a los consumos (cada venta puede tener varios medios).
-- - cobrar_jugador_mostrador(): cobra la inscripción de un jugador y, si se elige, lo que debe en su
--   cuenta de consumos. Corre con los permisos de quien cobra (los mismos que para cobrar desde el
--   torneo o desde Cuentas).
-- Todo queda donde siempre (el turno, el pago de la inscripción, el pago de la cuenta), así que la
-- Caja y la caja del día lo ven igual que si se hubiera cobrado desde cada pantalla.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261048.

-- [{"medio": "efectivo", "monto": 1000}, ...] → medios y montos válidos, sumando los repetidos
create or replace function public._pagos_validos(p_pagos jsonb, out medios text[], out montos numeric[])
language plpgsql immutable as $$
declare x record;
begin
  medios := '{}'; montos := '{}';
  if p_pagos is null or jsonb_typeof(p_pagos) <> 'array' or jsonb_array_length(p_pagos) = 0 then raise exception 'datos_invalidos'; end if;
  for x in select e->>'medio' as medio, sum((e->>'monto')::numeric) as monto from jsonb_array_elements(p_pagos) e group by 1 order by 2 desc loop
    if x.medio is null or x.medio not in ('efectivo', 'transferencia', 'mercado_pago', 'debito', 'credito') or x.monto is null or x.monto <= 0 then
      raise exception 'datos_invalidos';
    end if;
    medios := medios || x.medio; montos := montos || round(x.monto, 2);
  end loop;
end; $$;

create or replace function public.cobrar_turno_mostrador(p_reserva uuid, p_pagos jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservas%rowtype;
  v ventas%rowtype;
  v_medios text[];
  v_montos numeric[];
  v_cancha numeric := 0;
  v_pendiente numeric;
  v_medio_cancha text;
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

  -- La cancha: con un solo medio que alcance (el de más plata)
  if v_cancha > 0 then
    for i in 1 .. cardinality(v_medios) loop
      if v_montos[i] >= v_cancha then
        v_medio_cancha := v_medios[i];
        v_montos[i] := v_montos[i] - v_cancha;
        exit;
      end if;
    end loop;
    if v_medio_cancha is null then raise exception 'dividir_cancha'; end if;
    update reservas set medio_pago = v_medio_cancha where id = r.id;
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
  return jsonb_build_object('cancha', v_cancha, 'consumos', v_pendiente, 'medio_cancha', v_medio_cancha);
end; $$;
revoke all on function public.cobrar_turno_mostrador(uuid, jsonb) from public, anon;
grant execute on function public.cobrar_turno_mostrador(uuid, jsonb) to authenticated;

create or replace function public.cobrar_jugador_mostrador(
  p_torneo text, p_categoria text, p_pareja text, p_jugador int, p_inscripcion numeric,
  p_cuenta uuid, p_cuenta_monto numeric, p_pagos jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_medios text[];
  v_montos numeric[];
  v_org uuid;
  v_complejo text;
  i int;
  v_resto numeric;
  v_parte numeric;
  v_ins numeric := coalesce(p_inscripcion, 0);
  v_cta numeric := case when p_cuenta is null then 0 else coalesce(p_cuenta_monto, 0) end;
begin
  if v_ins < 0 or v_cta < 0 or v_ins + v_cta = 0 then raise exception 'nada_para_cobrar'; end if;
  select medios, montos into v_medios, v_montos from _pagos_validos(p_pagos);
  if (select sum(m) from unnest(v_montos) m) <> v_ins + v_cta then raise exception 'monto_no_coincide'; end if;
  if v_ins > 0 then
    select organizador_id into v_org from torneos where id = p_torneo;
    if v_org is null then raise exception 'torneo_invalido'; end if;
  end if;
  if v_cta > 0 then
    select complejo_id into v_complejo from cuentas where id = p_cuenta;
    if v_complejo is null then raise exception 'cuenta_invalida'; end if;
  end if;

  -- Primero la inscripción, después la cuenta; cada parte con los medios que le toquen
  v_resto := v_ins;
  for i in 1 .. cardinality(v_medios) loop
    exit when v_resto = 0;
    continue when v_montos[i] = 0;
    v_parte := least(v_resto, v_montos[i]);
    insert into pagos_inscripcion (torneo_id, organizador_id, categoria_id, pareja_id, jugador, monto, medio)
    values (p_torneo, v_org, p_categoria, p_pareja, p_jugador, v_parte, v_medios[i]);
    v_montos[i] := v_montos[i] - v_parte;
    v_resto := v_resto - v_parte;
  end loop;
  v_resto := v_cta;
  for i in 1 .. cardinality(v_medios) loop
    exit when v_resto = 0;
    continue when v_montos[i] = 0;
    v_parte := least(v_resto, v_montos[i]);
    insert into cuenta_pagos (complejo_id, cuenta_id, monto, medio) values (v_complejo, p_cuenta, v_parte, v_medios[i]);
    v_montos[i] := v_montos[i] - v_parte;
    v_resto := v_resto - v_parte;
  end loop;
  return jsonb_build_object('inscripcion', v_ins, 'cuenta', v_cta);
end; $$;
revoke all on function public.cobrar_jugador_mostrador(text, text, text, int, numeric, uuid, numeric, jsonb) from public, anon;
grant execute on function public.cobrar_jugador_mostrador(text, text, text, int, numeric, uuid, numeric, jsonb) to authenticated;

-- Vuelta atrás (si hiciera falta):
--   drop function if exists public.cobrar_jugador_mostrador(text, text, text, int, numeric, uuid, numeric, jsonb),
--     public.cobrar_turno_mostrador(uuid, jsonb), public._pagos_validos(jsonb);
