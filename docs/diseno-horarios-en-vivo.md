# Diseño: página del torneo con canchas en vivo

Aprobado el 23/10/2026. Lienzo: https://claude.ai/artifact/2mThq1rHXifPdAvtsMFaMq
(pantalla "6 · DISEÑO FINAL (4 + 5)"; copia en `diseno-horarios-en-vivo.dc.html`).
Se construye después del torneo, en la tanda de publicación.

## Arriba de los horarios

- Sin la etiqueta verde "● EN VIVO" debajo del nombre del torneo.
- Recuadro naranja **"● TRANSMISION EN VIVO"** con "N de N canchas" y una cajita por cancha:
  número (C1…C5), categoría del partido en curso y "▶ ver" si la cancha tiene transmisión.
  Tocar una cancha baja a su partido; "▶ ver" abre la transmisión.
  Reemplaza a los botones sueltos "▶ Cancha 1…5".
- Botón naranja **"● EN CURSO"** en la misma fila que la fecha ("VIE 23/10"), a la derecha:
  baja al bloque de horario que se está jugando (lo que hoy hace "● Ahora").
- Todo sale de lo que el organizador ya marca en "En cancha": no suma trabajo durante el torneo.

## Cada partido (3 renglones, jugado o no)

1. Hora + "C1 · #N · CATEGORÍA · Grupo". Si está en curso: etiqueta naranja "EN CURSO" y "▶ Ver" a la derecha.
2. y 3. Cada pareja en un solo renglón, desde el borde izquierdo, nombres en tamaño 11.

- Jugados: sets en columnas fijas a la derecha (el 10 o 12 del súper tie-break no corre los demás);
  pareja ganadora en verde, la otra en gris; las parejas en el orden del partido.
- Sin jugar: "vs" a la izquierda, centrado entre las dos parejas.

## Barra de abajo

- "Inscripciones cerradas" (o el botón de inscribirse) sigue igual antes de que empiece el torneo.
- Con el torneo en curso ya no aparece (hecho en el código, commit 3fa300d).

## Para decidir al construirlo

- Probar el tamaño 11 en un celular real (sugerencia: 12, y que un nombre que no entre se achique solo en vez de cortarse).
