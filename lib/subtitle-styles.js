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
