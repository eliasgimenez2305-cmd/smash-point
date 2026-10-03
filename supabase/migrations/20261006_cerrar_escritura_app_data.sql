-- Cierra la escritura directa de app_data: desde acá solo el creador (administración) puede crear
-- o reemplazar filas enteras.
--
-- Hasta acá cualquier usuario logueado podía crear o reemplazar cualquier fila de app_data: la
-- lista entera de torneos de todos los organizadores, los eventos, circuitos, portadas,
-- publicidades, complejos y profes. Ahora los organizadores guardan solo a través de funciones que
-- controlan de quién es cada cosa:
--   - torneos: guardar_torneo() y borrar_torneo() (20261003_guardar_torneo.sql)
--   - eventos y circuitos: guardar_en_lista() y borrar_de_lista(); portadas: guardar_portada()
--     (20261005_guardar_eventos_circuitos_portadas.sql)
-- Publicidades, complejos y profes los carga solo el creador, que además necesita escribir filas
-- enteras para restaurar un respaldo.
--
-- IMPORTANTE: correrla DESPUÉS de correr 20261003 y 20261005 y de publicar la versión de la app que
-- usa esas funciones. Si se corre antes, la versión publicada no va a poder guardar.

drop policy if exists "Solo usuarios logueados pueden crear datos" on public.app_data;
drop policy if exists "Solo usuarios logueados pueden actualizar datos" on public.app_data;
drop policy if exists "Logueados crean datos; la lista de torneos solo el creador" on public.app_data;
drop policy if exists "Logueados actualizan datos; la lista de torneos solo el creador" on public.app_data;

create policy "Solo el creador crea datos directamente" on public.app_data
  for insert to authenticated
  with check (public.es_creador());

create policy "Solo el creador actualiza datos directamente" on public.app_data
  for update to authenticated
  using (public.es_creador())
  with check (public.es_creador());
