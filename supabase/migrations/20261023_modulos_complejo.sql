-- Módulos por complejo: qué usa cada cliente (Torneos, Reservas de canchas, Cantina).
--
-- Los marca el creador en la ficha del complejo (pestaña Complejos), junto al dueño. El panel del
-- dueño y de sus empleados muestra solo lo que esté marcado: una cancha que no hace torneos usa
-- solo Reservas y Cantina, y no ve Torneos ni Cobros.
--
-- Los complejos que ya existen quedan con los tres módulos (no cambia nada de lo que ven hoy).
-- Un organizador sin complejo sigue viendo Torneos como siempre.
--
-- Por ahora es una elección de pantallas: los permisos de la base (dueño, colaboradores) no
-- cambian. Los complejos sin Reservas no aparecen en el buscador público de turnos.
--
-- Se corre una vez en Supabase > SQL Editor (primero en el proyecto de PRUEBA). El creador ya
-- puede modificar la tabla complejos (20261014), así que no hacen falta permisos nuevos.

alter table public.complejos add column if not exists modulo_torneos boolean not null default true;
alter table public.complejos add column if not exists modulo_reservas boolean not null default true;
alter table public.complejos add column if not exists modulo_cantina boolean not null default true;

-- Vuelta atrás (si hiciera falta):
--   alter table public.complejos drop column if exists modulo_torneos;
--   alter table public.complejos drop column if exists modulo_reservas;
--   alter table public.complejos drop column if exists modulo_cantina;
