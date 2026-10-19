-- Cobro de inscripciones: pagos por jugador. Necesita 20261017_colaboradores_permisos.sql.
--
-- Las inscripciones son por pareja pero se paga por jugador: cada pago dice torneo, categoría,
-- pareja y jugador (1 o 2; en el Súper 8 individual, siempre 1), monto y medio. El precio por
-- jugador vive en el torneo (precioJugador del torneo y, si la categoría lo cambia, el suyo).
--
-- Quién: el organizador dueño del torneo y sus colaboradores con acceso a torneos (cargar
-- resultados o gestionar torneos) ven los pagos y registran nuevos. Anular un pago (borrarlo) es solo
-- del dueño. Queda guardado quién cobró (su cuenta y su mail). Los pagos no están adentro del torneo
-- (así un colaborador que solo carga resultados puede cobrar sin tocar el armado, y si se borra el
-- torneo los pagos quedan para la caja).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA).

create table if not exists public.pagos_inscripcion (
  id uuid primary key default gen_random_uuid(),
  torneo_id text not null,
  organizador_id uuid not null,
  categoria_id text not null,
  pareja_id text not null,
  jugador smallint not null check (jugador in (1, 2)),
  monto numeric(10, 2) not null check (monto > 0 and monto < 10000000),
  medio text not null check (medio in ('efectivo', 'transferencia', 'mercado_pago')),
  cobrado_por uuid not null default auth.uid(),
  cobrado_por_email text,
  created_at timestamptz not null default now()
);

create index if not exists pagos_por_torneo on public.pagos_inscripcion (torneo_id);
create index if not exists pagos_por_organizador on public.pagos_inscripcion (organizador_id, created_at);

-- Quién cobró: siempre la cuenta que está logueada (no lo que mande el navegador)
create or replace function public.pagos_inscripcion_quien()
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

drop trigger if exists pagos_inscripcion_quien on public.pagos_inscripcion;
create trigger pagos_inscripcion_quien before insert on public.pagos_inscripcion
  for each row execute function public.pagos_inscripcion_quien();

alter table public.pagos_inscripcion enable row level security;
revoke all on public.pagos_inscripcion from public, anon, authenticated;
grant select, insert, delete on public.pagos_inscripcion to authenticated;

drop policy if exists "Ven los pagos el dueño y sus colaboradores" on public.pagos_inscripcion;
create policy "Ven los pagos el dueño y sus colaboradores" on public.pagos_inscripcion for select to authenticated
  using (organizador_id = auth.uid() or public.colaborador_de(organizador_id::text, 'resultados'));

-- Registrar: el pago tiene que ser de un torneo de ese organizador
drop policy if exists "Registran pagos el dueño y sus colaboradores" on public.pagos_inscripcion;
create policy "Registran pagos el dueño y sus colaboradores" on public.pagos_inscripcion for insert to authenticated
  with check (
    (organizador_id = auth.uid() or public.colaborador_de(organizador_id::text, 'resultados'))
    and exists (select 1 from public.torneos t where t.id = torneo_id and t.organizador_id = pagos_inscripcion.organizador_id)
  );

drop policy if exists "Anula pagos solo el dueño" on public.pagos_inscripcion;
create policy "Anula pagos solo el dueño" on public.pagos_inscripcion for delete to authenticated
  using (organizador_id = auth.uid());
