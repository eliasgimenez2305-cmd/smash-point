-- Aceptar una inscripción también suma la pareja en el resumen del torneo.
--
-- La portada pública trabaja con el resumen de cada torneo (columna torneos.resumen, que arma la
-- app en cada guardado: ver tournamentSummary en src/SmashPointApp.jsx). Aceptar una inscripción
-- agrega la pareja desde el servidor, sin pasar por la app: sin esto, la portada seguía mostrando
-- los lugares de antes ("quedan 3") hasta el próximo guardado del organizador.
--
-- Igual que aceptar_inscripcion de 20261009_tabla_torneos.sql, más la cuenta del resumen.
-- Se corre una vez en Supabase > SQL Editor, en cualquier momento.

create or replace function public.aceptar_inscripcion(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ins inscripciones%rowtype;
  v_actual torneos%rowtype;
  v_ci int;
  v_ri int;
  v_categoria jsonb;
  v_formato text;
  v_pareja jsonb;
  v_resumen jsonb;
begin
  select * into v_ins from inscripciones where id = p_id for update;
  if not found or v_ins.organizador_id is distinct from auth.uid() then
    raise exception 'no_autorizado';
  end if;
  if v_ins.estado <> 'pendiente' then
    raise exception 'ya_resuelta';
  end if;

  -- Se bloquea el torneo para que nadie lo cambie mientras se agrega la pareja
  select * into v_actual from torneos where id = v_ins.torneo_id and datos->>'organizerId' = auth.uid()::text for update;
  if not found then
    raise exception 'torneo_no_encontrado';
  end if;

  select c.ord - 1, c.val into v_ci, v_categoria
  from jsonb_array_elements(coalesce(v_actual.datos->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
  where c.val->>'id' = v_ins.categoria_id;
  if v_ci is null then
    raise exception 'categoria_invalida';
  end if;

  v_formato := coalesce(v_categoria->>'format', 'zonas');
  if v_formato like 'super8%' then
    if jsonb_array_length(coalesce(v_categoria->'groups', '[]'::jsonb)) > 0 then
      raise exception 'partidos_generados';
    end if;
    if jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) >= 8 then
      raise exception 'cupo_completo';
    end if;
  end if;

  -- Misma forma que una pareja cargada a mano. El teléfono NO se copia: los torneos son públicos.
  v_pareja := jsonb_build_object(
    'id', substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    'name', case when v_ins.jugador2_nombre is null then v_ins.jugador1_nombre else v_ins.jugador1_nombre || ' / ' || v_ins.jugador2_nombre end,
    'availability', coalesce(v_ins.disponibilidad, '[]'::jsonb),
    'inscripcionId', v_ins.id
  );
  if v_ins.cruce_mismo_dia is not null then
    v_pareja := v_pareja || jsonb_build_object('sameDayBracket', v_ins.cruce_mismo_dia);
  end if;

  -- En el resumen, la categoría suma una pareja (si el torneo ya tiene resumen)
  v_resumen := v_actual.resumen;
  if v_resumen is not null then
    select c.ord - 1 into v_ri
    from jsonb_array_elements(coalesce(v_resumen->'categories', '[]'::jsonb)) with ordinality as c(val, ord)
    where c.val->>'id' = v_ins.categoria_id;
    if v_ri is not null then
      v_resumen := jsonb_set(v_resumen, array['categories', v_ri::text, '_pairsCount'],
        to_jsonb(jsonb_array_length(coalesce(v_categoria->'pairs', '[]'::jsonb)) + 1));
    end if;
  end if;

  update torneos
  set datos = jsonb_set(datos, array['categories', v_ci::text, 'pairs'], coalesce(v_categoria->'pairs', '[]'::jsonb) || jsonb_build_array(v_pareja)),
      resumen = v_resumen,
      rev = rev + 1, actualizado = now()
  where id = v_actual.id;
  perform public.espejar_torneos();

  update inscripciones set estado = 'aceptada', pareja_id = v_pareja->>'id', resuelta_at = now() where id = p_id;
  return v_pareja;
end;
$$;

revoke all on function public.aceptar_inscripcion(uuid) from public, anon, authenticated;
grant execute on function public.aceptar_inscripcion(uuid) to authenticated;
