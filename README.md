# Smash Point

App de gestión de torneos de pádel. Hecha en React + Vite, con Supabase como backend (login y datos).

## Desarrollo local
```
npm install
npm run dev
```

## Build de producción
```
npm run build
```
Esto genera la carpeta `dist/`, que es lo que se sube a Netlify.

## Variables
Las claves de Supabase están escritas directamente en `src/SmashPointApp.jsx` (SUPABASE_URL y SUPABASE_ANON_KEY). Son claves públicas (anon key), están pensadas para ir en el código del cliente — no son secretas.
