-- Caja del organizador (solo el dueño). Necesita 20261018_cobros_inscripciones.sql.
--
-- La caja de un período suma, en la app:
--   - las inscripciones cobradas en sus torneos (pagos_inscripcion, por la fecha en que se cobraron),
--   - los turnos cobrados en las canchas de sus complejos (reservas confirmadas con medio de pago,
--     por el día del turno),
--   - y los movimientos que carga a mano: gastos (pelotas, premios, árbitro…) y otros ingresos
--     (sponsors, buffet…). Esos van en esta tabla.
-- Los colaboradores no ven la caja ni cargan movimientos.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create table if not exists public.caja_movimientos (
  id uuid primary key default gen_random_uuid(),
  organizador_id uuid not null default auth.uid(),
  fecha date not null,
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  concepto text not null check (char_length(btrim(concepto)) between 1 and 80),
  monto numeric(12, 2) not null check (monto > 0 and monto < 1000000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  torneo_id text, -- opcional: si el gasto o ingreso es de un torneo
  created_at timestamptz not null default now()
);

create index if not exists caja_por_organizador on public.caja_movimientos (organizador_id, fecha);

alter table public.caja_movimientos enable row level security;
revoke all on public.caja_movimientos from public, anon, authenticated;
grant select, insert, update, delete on public.caja_movimientos to authenticated;

-- Solo el organizador dueño de la caja (no sus colaboradores)
drop policy if exists "El organizador ve su caja" on public.caja_movimientos;
create policy "El organizador ve su caja" on public.caja_movimientos for select to authenticated
  using (organizador_id = auth.uid() and public.es_organizador());
drop policy if exists "El organizador carga en su caja" on public.caja_movimientos;
create policy "El organizador carga en su caja" on public.caja_movimientos for insert to authenticated
  with check (organizador_id = auth.uid() and public.es_organizador());
drop policy if exists "El organizador corrige su caja" on public.caja_movimientos;
create policy "El organizador corrige su caja" on public.caja_movimientos for update to authenticated
  using (organizador_id = auth.uid() and public.es_organizador()) with check (organizador_id = auth.uid() and public.es_organizador());
drop policy if exists "El organizador borra de su caja" on public.caja_movimientos;
create policy "El organizador borra de su caja" on public.caja_movimientos for delete to authenticated
  using (organizador_id = auth.uid() and public.es_organizador());
