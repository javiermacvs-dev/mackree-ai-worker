// Catálogo de estilos de subtítulos — APROBADO por Javier 2026-05-23.
// Es ELECCIÓN ESTÉTICA por-video (llega en manifest.subtitleStyle); los captions
// siguen SIEMPRE on (inamovible #7/#11) — solo cambia el LOOK.
//
// Colores ASS = &HAABBGGRR (alpha, blue, green, red). NO hex web.
// 'classic' = el look ACTUAL EXACTO del worker (cero regresión si no se elige nada).
// Fuentes: Impact + 'Liberation Sans' (instaladas en el Docker via fonts-liberation;
// Liberation Sans ≈ Arial, métrica compatible). NO usar fuentes que no estén en la imagen.
// active=null → la palabra activa se resalta con NEGRITA (\b1) en vez de color.

export const DEFAULT_SUBTITLE_STYLE = 'classic'

export const SUBTITLE_STYLES = {
  // Look actual del worker: Impact 76 bold, blanco + verde lima, sombra negra 50%.
  classic:    { font: 'Impact',          size: 76, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H80000000', bold: -1, borderStyle: 1, ol: 4,  sh: 2, align: 2, mL: 10, mR: 10, mv: 80,  chunk: 5, active: '&H0000FF80' },
  // Grande/grueso, blanco + amarillo, más arriba, pocas palabras (estilo Hormozi).
  hormozi:    { font: 'Impact',          size: 92, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 1, ol: 7,  sh: 0, align: 2, mL: 40, mR: 40, mv: 240, chunk: 3, active: '&H0000F2FF' },
  // Caja negra semitransparente (BorderStyle=3) + texto blanco, activa amarilla.
  tiktok_box: { font: 'Liberation Sans', size: 62, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H80000000', bold: -1, borderStyle: 3, ol: 12, sh: 0, align: 2, mL: 60, mR: 60, mv: 150, chunk: 4, active: '&H0000F2FF' },
  // Glow cian (back cian + shadow 6), contorno negro para legibilidad, activa cian.
  neon:       { font: 'Impact',          size: 80, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00FFFF00', bold: 0,  borderStyle: 1, ol: 3,  sh: 6, align: 2, mL: 40, mR: 40, mv: 100, chunk: 5, active: '&H00FFFF00' },
  // Limpio/profesional: Liberation Sans fino, contorno suave, activa en NEGRITA (sin color).
  minimal:    { font: 'Liberation Sans', size: 58, primary: '&H00FFFFFF', outline: '&H64000000', back: '&H00000000', bold: 0,  borderStyle: 1, ol: 2,  sh: 1, align: 2, mL: 60, mR: 60, mv: 95,  chunk: 5, active: null },
  // Impact grande, blanco + coral/rojo (pop), distinto del verde de classic.
  duo:        { font: 'Impact',          size: 84, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: 0,  borderStyle: 1, ol: 5,  sh: 2, align: 2, mL: 40, mR: 40, mv: 110, chunk: 4, active: '&H006644FF' },
  // ── 5 estilos nuevos (v53, 2026-06-01) ──────────────────────────────────────
  // Viral/MrBeast: Impact enorme, blanco, palabra activa ROSA fuerte, contorno grueso.
  viral_pink:     { font: 'Impact',          size: 90, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 1, ol: 8,  sh: 0, align: 2, mL: 40, mR: 40, mv: 230, chunk: 3, active: '&H00952DFF' },
  // Burbuja: caja VIOLETA de marca (BorderStyle=3 → la caja usa OutlineColour, #7C3AED), texto blanco, activa amarilla.
  bubble:         { font: 'Liberation Sans', size: 64, primary: '&H00FFFFFF', outline: '&H00ED3A7C', back: '&H80000000', bold: -1, borderStyle: 3, ol: 16, sh: 0, align: 2, mL: 60, mR: 60, mv: 160, chunk: 4, active: '&H0000F2FF' },
  // Contorno naranja: Impact, blanco, palabra activa NARANJA, contorno fuerte.
  outline_orange: { font: 'Impact',          size: 82, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 1, ol: 6,  sh: 2, align: 2, mL: 40, mR: 40, mv: 120, chunk: 4, active: '&H00008AFF' },
  // Retro karaoke: TODO el texto AMARILLO, palabra activa BLANCA, contorno negro fino.
  retro_karaoke:  { font: 'Liberation Sans', size: 66, primary: '&H0000E0FF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 1, ol: 4,  sh: 1, align: 2, mL: 50, mR: 50, mv: 90,  chunk: 5, active: '&H00FFFFFF' },
  // Elegante: SERIF, blanco, palabra activa DORADA, contorno sutil — premium/editorial.
  elegant:        { font: 'Liberation Serif',size: 62, primary: '&H00FFFFFF', outline: '&H64000000', back: '&H00000000', bold: 0,  borderStyle: 1, ol: 2,  sh: 2, align: 2, mL: 70, mR: 70, mv: 100, chunk: 5, active: '&H0000C4FF' },
}

/** Resuelve la key del manifest a un preset; fallback a classic ante key inválida/ausente. */
export function resolveSubtitleStyle(key) {
  return SUBTITLE_STYLES[String(key || '').toLowerCase()] || SUBTITLE_STYLES[DEFAULT_SUBTITLE_STYLE]
}

// ─────────────────────────────────────────────────────────────────────────────
// POSICIÓN VERTICAL de los subtítulos (v79) — elección estética del cliente.
//
// Hasta v78 la posición venía ACOPLADA al estilo: cada preset traía su `mv`
// (MarginV en px absolutos, 80-240) y todos usaban `align: 2`. Eso significa
// que elegir "Hormozi" también subía el texto, quisieras o no.
//
// Ahora la posición es un eje aparte que llega en `manifest.subtitlePosition`:
//
//   bottom      → NO toca nada: usa el `mv`/`align` del preset (comportamiento
//                 idéntico a todo lo renderizado hasta hoy). Es el default y el
//                 fallback ante cualquier valor desconocido.
//   lower_third → base del texto ≈ 0.75·H. La recomendada para redes: Instagram
//                 tapa los últimos ~400-500 px del alto con la barra de audio y
//                 comentarios, TikTok ~484 px.
//   center      → centro exacto del lienzo (alignment 5 + \pos, ver más abajo).
//   top         → arriba, pero SIEMPRE por debajo de los títulos de impacto.
//
// `frac` = distancia desde ABAJO como fracción de H (equivalente a MarginV/H),
// que es como libass interpreta MarginV con alignment 2. `align` null = respeta
// el del preset.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SUBTITLE_POSITION = 'bottom'

export const SUBTITLE_POSITIONS = {
  bottom:      { align: 2, frac: null },  // null = usar el mv del preset
  lower_third: { align: 2, frac: 0.25 },  // base del texto ≈ 75% del alto
  center:      { align: 5, frac: 0.50 },  // centro geométrico
  top:         { align: 8, frac: null, fromTop: 0.34 }, // 34% desde arriba
}

/**
 * Resuelve la key del manifest a una posición.
 * Devuelve `null` ante clave ausente, inválida o 'bottom' → el llamador usa el
 * `mv`/`align` del preset tal cual (cero regresión para manifiestos viejos).
 */
export function resolveSubtitlePosition(key) {
  const k = String(key || '').toLowerCase()
  if (!k || k === DEFAULT_SUBTITLE_POSITION) return null
  return SUBTITLE_POSITIONS[k] || null
}

/**
 * Zona vertical que NO pueden invadir los subtítulos, expresada como fracción
 * de H medida desde arriba.
 *
 * Qué vive ahí (inamovibles #31 y #27):
 *  · Títulos de impacto: `\an8` a `MarginV = H*0.14`, fuente `min(W,H)*0.092`.
 *    Dos líneas llegan a ~0.26·H en 9:16 (más borde y sombra).
 *  · Dato de contacto sobreimpreso: `y = H*0.16`.
 *  · Logo top-right: ocupa ~y 30-270 px en la esquina.
 *
 * En formatos anchos (1:1 y 16:9) H es menor, así que la misma altura de fuente
 * absoluta ocupa una fracción mayor del lienzo → la zona prohibida crece.
 */
export function titleSafeFloor(W, H, hasTitles = true) {
  if (!hasTitles) return 0.10
  const isTall = H >= W
  return isTall ? 0.30 : 0.40
}
