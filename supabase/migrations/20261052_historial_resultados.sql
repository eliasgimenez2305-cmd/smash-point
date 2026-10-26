-- Historial de cambios de resultados: qué partido, quién, cuándo y de qué a qué.
--
-- Los resultados se guardan en torneos.datos (guardar_partidos o guardar_torneo). Un disparador compara
-- los resultados de antes y después de cada guardado (sets, W.O. y retiro de cada partido de grupos,
-- Super 8 y llave) y anota los que cambiaron. Mientras alguien escribe un resultado se guarda varias
-- veces (6, 6-2, 6-2 1…): los cambios de la misma persona en el mismo partido dentro de 1 minuto
-- quedan en un solo renglón, "de cómo estaba" → "a cómo quedó".
-- Lo ven el organizador del torneo, sus empleados con permiso de resultados y el creador.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261051.

create table if not exists public.resultados_historial (
  id bigint generated always as identity primary key,
  torneo_id text not null,
  organizador_id uuid,
  categoria text,
  lugar text,          -- nombre del grupo, o "llave:<ronda>:<rondas>" (ronda desde 0)
  partido text not null,
  pareja_a text,
  pareja_b text,
  antes jsonb not null default '{}'::jsonb,
  despues jsonb not null default '{}'::jsonb,
  por uuid,
  por_quien text,
  creado_at timestamptz not null default now(),
  cambiado_at timestamptz not null default now()
);
create index if not exists resultados_historial_por_torneo on public.resultados_historial (torneo_id, cambiado_at desc);

alter table public.resultados_historial enable row level security;
revoke all on public.resultados_historial from public, anon, authenticated;
grant select on public.resultados_historial to authenticated;
drop policy if exists "Ven el historial de sus torneos" on public.resultados_historial;
create policy "Ven el historial de sus torneos" on public.resultados_historial for select to authenticated
  using (public.es_creador() or organizador_id = auth.uid() or public.colaborador_de(organizador_id::text, 'resultados'));

-- El resultado de cada partido de un torneo: {} si no tiene; si no, sets / walkover / retired
create or replace function public._resultados_torneo(p_datos jsonb)
returns table (partido text, categoria text, lugar text, pareja_a text, pareja_b text, resultado jsonb)
language sql immutable set search_path = public as $$
  with cats as (
    select c.val as c from jsonb_array_elements(coalesce(p_datos->'categories', '[]'::jsonb)) c(val)
  ),
  nombres as (
    select x.c->>'id' as cid, e->>'id' as id, e->>'name' as nombre
    from cats x, jsonb_array_elements(coalesce(x.c->'pairs', '[]'::jsonb) || coalesce(x.c->'teams', '[]'::jsonb)) e
  ), partidos as (
    select x.c->>'id' as cid, x.c->>'name' as cnombre, m, g->>'name' as lugar
    from cats x, jsonb_array_elements(coalesce(x.c->'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g->'matches', '[]'::jsonb)) m
    union all
    select x.c->>'id', x.c->>'name', m, 'llave:' || (r.ord - 1) || ':' || jsonb_array_length(x.c->'bracket')
    from cats x, jsonb_array_elements(case when jsonb_typeof(x.c->'bracket') = 'array' then x.c->'bracket' else '[]'::jsonb end) with ordinality r(val, ord),
         jsonb_array_elements(case when jsonb_typeof(r.val) = 'array' then r.val else '[]'::jsonb end) m
  )
  select p.m->>'id', p.cnombre, p.lugar,
         (select n.nombre from nombres n where n.cid = p.cid and n.id = p.m->>'pairA' limit 1),
         (select n.nombre from nombres n where n.cid = p.cid and n.id = p.m->>'pairB' limit 1),
         jsonb_strip_nulls(jsonb_build_object(
           'sets', case when jsonb_typeof(p.m->'sets') = 'array' and jsonb_array_length(p.m->'sets') > 0 then p.m->'sets' end,
           'walkover', nullif(p.m->'walkover', 'null'::jsonb),
           'retired', nullif(p.m->'retired', 'null'::jsonb)))
  from partidos p
  where p.m->>'id' is not null;
$$;
revoke all on function public._resultados_torneo(jsonb) from public, anon, authenticated;

create or replace function public.anotar_cambios_resultados() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_quien text := coalesce(nullif(auth.jwt()->>'email', ''), nullif(auth.jwt()->>'phone', ''));
  v_ultimo resultados_historial%rowtype;
begin
  for r in
    select coalesce(n.partido, o.partido) as partido, coalesce(n.categoria, o.categoria) as categoria, coalesce(n.lugar, o.lugar) as lugar,
           coalesce(n.pareja_a, o.pareja_a) as pareja_a, coalesce(n.pareja_b, o.pareja_b) as pareja_b,
           coalesce(o.resultado, '{}'::jsonb) as antes, coalesce(n.resultado, '{}'::jsonb) as despues
    from _resultados_torneo(old.datos) o full join _resultados_torneo(new.datos) n on n.partido = o.partido
    where coalesce(o.resultado, '{}'::jsonb) is distinct from coalesce(n.resultado, '{}'::jsonb)
  loop
    select * into v_ultimo from resultados_historial
    where torneo_id = new.id and partido = r.partido and por is not distinct from auth.uid() and cambiado_at > now() - interval '1 minute'
    order by cambiado_at desc limit 1;
    if found then
      if v_ultimo.antes = r.despues then
        delete from resultados_historial where id = v_ultimo.id;   -- volvió a como estaba: no hubo cambio
      else
        update resultados_historial set despues = r.despues, pareja_a = r.pareja_a, pareja_b = r.pareja_b, cambiado_at = now() where id = v_ultimo.id;
      end if;
    else
      insert into resultados_historial (torneo_id, organizador_id, categoria, lugar, partido, pareja_a, pareja_b, antes, despues, por, por_quien)
      values (new.id, new.organizador_id, r.categoria, r.lugar, r.partido, r.pareja_a, r.pareja_b, r.antes, r.despues, auth.uid(), v_quien);
    end if;
  end loop;
  return new;
exception when others then
  return new; -- el historial nunca impide guardar un resultado
end; $$;
revoke all on function public.anotar_cambios_resultados() from public, anon, authenticated;

drop trigger if exists anotar_cambios_resultados on public.torneos;
create trigger anotar_cambios_resultados after update of datos on public.torneos
  for each row when (old.datos is distinct from new.datos) execute function public.anotar_cambios_resultados();

-- Vuelta atrás (si hiciera falta):
--   drop trigger if exists anotar_cambios_resultados on public.torneos;
--   drop function if exists public.anotar_cambios_resultados(), public._resultados_torneo(jsonb);
--   drop table if exists public.resultados_historial;
