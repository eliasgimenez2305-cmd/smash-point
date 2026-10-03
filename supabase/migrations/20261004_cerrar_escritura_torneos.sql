-- Cierra la escritura directa de la lista de torneos (app_data 'sp:tournaments').
--
-- Hasta acá cualquier usuario logueado podía crear o reemplazar cualquier fila de app_data,
-- incluida la lista entera de torneos de todos los organizadores. Desde la migración
-- 20261003_guardar_torneo.sql la app guarda los torneos de a uno con guardar_torneo() y
-- borrar_torneo(), que controlan de quién es cada torneo. Esta migración deja la escritura directa
-- de 'sp:tournaments' solo para el creador (la necesita para restaurar un respaldo).
--
-- IMPORTANTE: correrla DESPUÉS de publicar la versión de la app que usa guardar_torneo(). Si se
-- corre antes, la versión vieja publicada no va a poder guardar torneos.
--
-- El resto de app_data (eventos, circuitos, publicidades, complejos, profes, portadas) sigue
-- abierto a cualquier usuario logueado, como antes: queda pendiente revisarlo.

drop policy if exists "Solo usuarios logueados pueden crear datos" on public.app_data;
drop policy if exists "Solo usuarios logueados pueden actualizar datos" on public.app_data;

create policy "Logueados crean datos; la lista de torneos solo el creador" on public.app_data
  for insert to authenticated
  with check (key <> 'sp:tournaments' or public.es_creador());

create policy "Logueados actualizan datos; la lista de torneos solo el creador" on public.app_data
  for update to authenticated
  using (key <> 'sp:tournaments' or public.es_creador())
  with check (key <> 'sp:tournaments' or public.es_creador());
