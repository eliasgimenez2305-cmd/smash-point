-- Prueba de 20261023_modulos_complejo.sql (solo en el proyecto de PRUEBA).
-- Tiene que dar todo true.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'complejos'
      and column_name in ('modulo_torneos', 'modulo_reservas', 'modulo_cantina')) = 3 as columnas,
  (select bool_and(column_default = 'true') from information_schema.columns
    where table_schema = 'public' and table_name = 'complejos' and column_name like 'modulo_%') as por_defecto_todo,
  not exists (select 1 from public.complejos
    where not (modulo_torneos and modulo_reservas and modulo_cantina)) as los_de_antes_con_todo;
