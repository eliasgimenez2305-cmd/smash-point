-- Un organizador solo puede cambiar el nombre y el logo de su perfil, no su rol.
--
-- Hasta acá la política "Cada organizador edita su propio perfil" dejaba que cada usuario
-- modificara CUALQUIER columna de su fila en organizers, incluida "role". Un organizador podía
-- ponerse role = 'creador' desde el navegador y con eso es_creador() le daba permiso para
-- reemplazar los datos de todos (torneos de otros organizadores, publicidades, complejos...).
--
-- La app solo cambia name y logo_url (updateOrganizerProfileRemote). Las cuentas y los roles los
-- maneja la función admin-organizers con la service_role, que no pasa por estos permisos.
--
-- Se corre una vez en Supabase > SQL Editor. Se puede correr en cualquier momento: no cambia nada
-- de lo que hace la app.

-- Solo nombre y logo, y solo usuarios logueados (la política sigue limitando a la fila propia)
revoke update on public.organizers from anon, authenticated;
grant update (name, logo_url) on public.organizers to authenticated;

-- Altas y bajas de organizadores: solo la función admin-organizers (service_role). Las políticas
-- ya no lo permitían; esto saca además los permisos de tabla que venían por defecto.
revoke insert, delete, truncate on public.organizers from anon, authenticated;

-- Vuelta atrás (si hiciera falta):
--   grant update on public.organizers to anon, authenticated;
--   grant insert, delete, truncate on public.organizers to anon, authenticated;
