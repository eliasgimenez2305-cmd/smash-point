-- Teléfonos, segunda parte:
-- 1. Empleados por teléfono: el dueño los carga con su teléfono (o con el mail, como antes). El
--    empleado entra con su cuenta de teléfono (confirmado con el código) y ve el panel del complejo.
-- 2. Cambio de teléfono del jugador: cuando confirma el número nuevo con el código, su ficha de
--    jugador y su perfil pasan al número nuevo (su ID no cambia: conserva torneos y puntos).
-- 3. El organizador ve y corrige el teléfono de un jugador SIN cuenta que está en uno de sus torneos
--    (si tiene cuenta, el teléfono lo cambia el jugador).
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261040.

-- ============================================================
-- 1. Empleados: mail o teléfono
-- ============================================================

alter table public.colaboradores add column if not exists id uuid default gen_random_uuid();
update public.colaboradores set id = gen_random_uuid() where id is null;
alter table public.colaboradores alter column id set not null;
alter table public.colaboradores add column if not exists telefono text check (telefono is null or telefono ~ '^549[0-9]{10}$');
alter table public.colaboradores alter column email drop not null;
do $$
begin
  -- La clave pasa de (complejo, mail) a id, para poder cargar empleados sin mail
  if exists (select 1 from pg_constraint where conname = 'colaboradores_pkey' and conrelid = 'public.colaboradores'::regclass
             and array_length(conkey, 1) = 2) then
    alter table public.colaboradores drop constraint colaboradores_pkey;
    alter table public.colaboradores add primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'colaboradores_mail_o_telefono') then
    alter table public.colaboradores add constraint colaboradores_mail_o_telefono check (email is not null or telefono is not null);
  end if;
end $$;
create unique index if not exists colaboradores_por_mail on public.colaboradores (complejo_id, email) where email is not null;
create unique index if not exists colaboradores_por_telefono on public.colaboradores (complejo_id, telefono) where telefono is not null;

-- Igual que en 20261037_funciones.sql, pero el empleado se reconoce por su mail o por su teléfono
-- confirmados
create or replace function public.colaborador_permiso(p_complejo text, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.funcion_activa('cuentas') and exists (
    select 1
    from colaboradores c
    join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
    join auth.users u on u.id = auth.uid()
      and ((u.email_confirmed_at is not null and lower(u.email) = c.email)
        or (u.phone_confirmed_at is not null and u.phone = c.telefono))
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

create or replace function public.mis_complejos_colaborador()
returns table (complejo_id text, dueno_id uuid, p_agenda boolean, p_resultados boolean, p_torneos boolean, p_canchas boolean, p_consumos boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.complejo_id, x.dueno_id, c.p_agenda, c.p_resultados, c.p_torneos, c.p_canchas, c.p_consumos
  from colaboradores c
  join complejos x on x.id = c.complejo_id and x.reservas_habilitadas
  join auth.users u on u.id = auth.uid()
    and ((u.email_confirmed_at is not null and lower(u.email) = c.email)
      or (u.phone_confirmed_at is not null and u.phone = c.telefono))
  where public.funcion_activa('cuentas');
$$;

-- ============================================================
-- 2. El jugador cambió su teléfono (ya confirmado con el código): ficha y perfil al número nuevo
-- ============================================================

create or replace function public.sincronizar_mi_telefono()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel text := public._mi_telefono();
begin
  if auth.uid() is null or v_tel is null or v_tel !~ '^549[0-9]{10}$' then
    raise exception 'sin_telefono';
  end if;
  update jugadores set telefono = v_tel where id = auth.uid();
  update perfiles_jugador set telefono = v_tel where cuenta_id = auth.uid();
  return v_tel;
end;
$$;
revoke all on function public.sincronizar_mi_telefono() from public, anon;
grant execute on function public.sincronizar_mi_telefono() to authenticated;

-- ============================================================
-- 3. El organizador ve y corrige el teléfono de los jugadores de sus torneos
-- ============================================================

-- ¿El perfil está en algún torneo de quien llama (dueño del torneo o empleado con torneos)? El creador
-- también puede.
create or replace function public._perfil_en_mis_torneos(p_perfil uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_creador() or exists (
    select 1 from torneos t
     where t.datos::text like '%"' || p_perfil::text || '"%'
       and (t.datos->>'organizerId' = auth.uid()::text or public.colaborador_de(t.datos->>'organizerId', 'torneos'))
  );
$$;
revoke all on function public._perfil_en_mis_torneos(uuid) from public, anon, authenticated;

create or replace function public.telefono_de_jugador(p_perfil uuid)
returns table (telefono text, con_cuenta boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public._perfil_en_mis_torneos(p_perfil) then
    raise exception 'no_autorizado';
  end if;
  return query select p.telefono, p.cuenta_id is not null from perfiles_jugador p where p.id = p_perfil;
end;
$$;
revoke all on function public.telefono_de_jugador(uuid) from public, anon;
grant execute on function public.telefono_de_jugador(uuid) to authenticated;

create or replace function public.corregir_telefono_jugador(p_perfil uuid, p_telefono text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perfil perfiles_jugador%rowtype;
begin
  if not public._perfil_en_mis_torneos(p_perfil) then
    raise exception 'no_autorizado';
  end if;
  if p_telefono is null or p_telefono !~ '^549[0-9]{10}$' then
    raise exception 'telefono_invalido';
  end if;
  select * into v_perfil from perfiles_jugador where id = p_perfil for update;
  if not found then
    raise exception 'no_encontrado';
  end if;
  if v_perfil.cuenta_id is not null then
    raise exception 'tiene_cuenta';
  end if;
  update perfiles_jugador set telefono = p_telefono where id = p_perfil;
end;
$$;
revoke all on function public.corregir_telefono_jugador(uuid, text) from public, anon;
grant execute on function public.corregir_telefono_jugador(uuid, text) to authenticated;

-- Vuelta atrás (si hiciera falta): volver a correr colaborador_permiso y mis_complejos_colaborador de
-- 20261037_funciones.sql, y
--   drop function if exists public.corregir_telefono_jugador(uuid, text), public.telefono_de_jugador(uuid),
--     public._perfil_en_mis_torneos(uuid), public.sincronizar_mi_telefono();
-- (la columna telefono y la clave nueva de colaboradores pueden quedar)
