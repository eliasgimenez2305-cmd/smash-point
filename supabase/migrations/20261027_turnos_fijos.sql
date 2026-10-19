-- Turnos fijos: los turnos que se repiten todas las semanas quedan agrupados en una serie
-- (serie_id), para verlos juntos, extenderlos o darlos de baja desde una fecha. Cada turno se
-- sigue cobrando por separado, como un turno común.
--
-- Solo agrega la columna: los permisos de reservas no cambian (cargan y cancelan el dueño y los
-- empleados con permiso de agenda).
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA), después de 20261026.

alter table public.reservas add column if not exists serie_id uuid;
create index if not exists reservas_por_serie on public.reservas (serie_id, fecha) where serie_id is not null;

-- Vuelta atrás (si hiciera falta):
--   drop index if exists public.reservas_por_serie;
--   alter table public.reservas drop column if exists serie_id;
