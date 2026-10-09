-- Saca el espejo de la tabla de torneos en app_data 'sp:tournaments' (ver 20261009_tabla_torneos.sql).
--
-- Correr UNOS DÍAS DESPUÉS de publicar la app que usa la tabla torneos, cuando ya nadie tenga
-- abierta la versión anterior (que leía la lista de app_data). Desde acá:
--   - Cada guardado deja de reescribir la lista entera: solo cambia la fila de su torneo.
--   - app_data 'sp:tournaments' queda congelada como respaldo de cómo estaba ese día.
--
-- Se corre una vez en Supabase > SQL Editor.

create or replace function public.espejar_torneos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sin espejo: la lista vieja de app_data ya no se usa (queda como respaldo)
  return;
end;
$$;

revoke all on function public.espejar_torneos() from public, anon, authenticated;

-- Vuelta atrás: volver a correr la parte "Espejo" de 20261009_tabla_torneos.sql y, para ponerla al
-- día de una vez, select public.espejar_torneos();
