-- Planes en la página pública (04/11/2026)
--
-- Las páginas "Para organizadores" y "Para complejos" muestran los planes que el creador elige:
-- - plataforma_planes.en_la_web: si el plan se muestra en la página (por defecto sí).
-- - plataforma_planes.destacado: la tarjeta "Más elegido".
-- - planes_publicos(): lo que ve cualquiera (sin iniciar sesión) de los planes activos, en la web, para
--   organizadores o complejos: nombre, precio, forma de cobro y qué incluye. Nada de clientes ni cobros.
--
-- Prueba: supabase/pruebas/planes_publicos.sql (solo en el proyecto de PRUEBA). Vuelta atrás: al final.

alter table public.plataforma_planes add column if not exists en_la_web boolean not null default true;
alter table public.plataforma_planes add column if not exists destacado boolean not null default false;

create or replace function public.planes_publicos()
returns table (id uuid, nombre text, para text, precio numeric, tipo_cobro text, modulo_torneos boolean, modulo_reservas boolean,
               modulo_cantina boolean, reportes boolean, empleados int, destacado boolean, orden int)
language sql stable security definer set search_path = public as $$
  select p.id, p.nombre, p.para, p.precio, p.tipo_cobro, p.modulo_torneos, p.modulo_reservas, p.modulo_cantina, p.reportes,
         p.empleados, p.destacado, p.orden
  from plataforma_planes p
  where p.activo and p.en_la_web and p.para in ('organizador', 'complejo')
  order by p.orden, p.created_at;
$$;
revoke all on function public.planes_publicos() from public;
grant execute on function public.planes_publicos() to anon, authenticated;

select 'PLANES_PUBLICOS_OK' as fin;

-- Vuelta atrás:
--   drop function if exists public.planes_publicos();
--   alter table public.plataforma_planes drop column if exists destacado;
--   alter table public.plataforma_planes drop column if exists en_la_web;
