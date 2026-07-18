// Regla inamovible (Javier 2026-07-18): timing de pausas consistente + supresión
// de respiración/suspiro residual en la voz clonada TTS. Validado contra el
// render aprobado "camión Lakeland" (job mrqqujpicmkwegr63, 2026-07-18): sus
// pausas naturales medían 0.2-1.0s, producto de la puntuación/estructura del
// guión (oraciones cortas, saltos de párrafo entre beats) — NO de ningún
// post-proceso especial (no había ninguno).
//
// A diferencia del word-gap de footage (wordGaps.js, que APLASTA todo gap por
// encima del umbral a un valor parejo ~0.20s — correcto ahí porque esos gaps
// suelen ser titubeo/duda real del cliente hablando en cámara), la voz TTS ya
// trae un ritmo bueno y VARIADO por la puntuación del guión. Aplastarlo todo
// a un valor uniforme sonaría más robótico, no más natural. Por eso acá SOLO
// se atrapan los outliers (pausas anormalmente largas que a veces genera
// ElevenLabs) y se atenúa (nunca corta del todo) el remanente respiratorio
// dentro de CADA pausa que sobrevive, incluidas la de apertura y cierre del
// clip (que es justo donde vive el "tomar aire" antes de hablar / el suspiro
// final).
//
// Aplica a TODO render con voz TTS: "editar video con voz", "generar con IA"
// y la 4ª opción (avatar/talking-head) — las 3 pasan por renderCreate. NUNCA
// a renderEdit (ahí la voz es del footage del cliente, no TTS).

// Calibrado contra el render aprobado "camión Lakeland" (mrqqujpicmkwegr63,
// 2026-07-18): su pausa mid-speech más larga midió 1.01s — el umbral queda
// por ENCIMA de eso a propósito para que esta regla NUNCA toque ese ritmo,
// solo atrape outliers genuinamente más largos que lo ya aprobado.
const MAX_GAP_SEC = 1.15       // pausa mid-speech más larga que esto -> se recorta
const MAX_INIT_GAP_SEC = 0.6   // aire antes de la 1ra palabra (ahí vive la inhalación previa)
const MAX_END_GAP_SEC = 0.6    // aire después de la última palabra (suspiro final)
const TARGET_GAP_SEC = 0.75    // a qué se recorta una pausa mid-speech excesiva
const TARGET_INIT_GAP_SEC = 0.35
const TARGET_END_GAP_SEC = 0.35
const MIN_CUT_SEC = 0.15       // por debajo de esto no vale la pena cortar (ruido de redondeo)
const DUCK_GUARD_SEC = 0.035   // margen pegado a cada palabra que NO se atenúa (protege ataque/cola de la voz)
const DUCK_DB = -16            // cuánto se atenúa el remanente de cada pausa (no silencio total: evita sonar a corte)

function dbToLinear(db) {
  return Math.pow(10, db / 20)
}

/**
 * detectExcessivePauses(words, totalDur) → { cutRanges }
 *  - words: Array de { word, start, end } de Whisper word-level (voz TTS)
 *  - totalDur: duración total del audio de voz en segundos
 *  - cutRanges: rangos {start,end,reason} a recortar del audio (formato
 *    compatible con buildKeepFilter de fillerWords.js: aselect+asetpts)
 *
 * Solo marca para corte las pausas que EXCEDEN el máximo natural — las
 * pausas normales (incluidas las largas-pero-razonables tipo 0.6-0.9s que
 * separan beats del guión) se dejan intactas.
 */
export function detectExcessivePauses(words, totalDur) {
  if (!Array.isArray(words) || words.length === 0) return { cutRanges: [] }
  const cutRanges = []

  const firstStart = words[0]?.start ?? 0
  if (firstStart > MAX_INIT_GAP_SEC) {
    const cutEnd = Math.max(0, firstStart - TARGET_INIT_GAP_SEC)
    if (cutEnd >= MIN_CUT_SEC) {
      cutRanges.push({ start: 0, end: cutEnd, reason: `pace_init:${firstStart.toFixed(2)}s` })
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    const gapStart = words[i].end ?? 0
    const gapEnd = words[i + 1].start ?? gapStart
    const gap = gapEnd - gapStart
    if (gap <= MAX_GAP_SEC) continue
    const cutStart = gapStart + TARGET_GAP_SEC / 2
    const cutEnd = gapEnd - TARGET_GAP_SEC / 2
    if (cutEnd - cutStart < MIN_CUT_SEC) continue
    cutRanges.push({ start: cutStart, end: cutEnd, reason: `pace_gap:${gap.toFixed(2)}s` })
  }

  const lastEnd = words[words.length - 1]?.end ?? totalDur
  const trailGap = totalDur - lastEnd
  if (trailGap > MAX_END_GAP_SEC) {
    const cutStart = lastEnd + TARGET_END_GAP_SEC
    if (totalDur - cutStart >= MIN_CUT_SEC) {
      cutRanges.push({ start: cutStart, end: totalDur, reason: `pace_end:${trailGap.toFixed(2)}s` })
    }
  }

  return { cutRanges }
}

/**
 * buildBreathDuckFilter(words, totalDur) → string | null
 *
 * A partir de las words YA reubicadas (timestamps post-corte, si hubo) y la
 * duración final, arma la cadena de filtros `volume=enable=...` que atenúa
 * (NO silencia del todo — evita sonar a corte brusco) el remanente de CADA
 * pausa restante, incluidas apertura y cierre del clip. Ahí es donde vive la
 * respiración/suspiro residual entre frases.
 */
export function buildBreathDuckFilter(words, totalDur) {
  if (!Array.isArray(words) || words.length === 0) return null

  const gaps = []
  const firstStart = words[0]?.start ?? 0
  if (firstStart > 0) gaps.push([0, firstStart])
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].end ?? 0
    const b = words[i + 1]?.start ?? a
    if (b > a) gaps.push([a, b])
  }
  const lastEnd = words[words.length - 1]?.end ?? totalDur
  if (totalDur > lastEnd) gaps.push([lastEnd, totalDur])

  const linear = dbToLinear(DUCK_DB).toFixed(4)
  const parts = []
  for (const [a, b] of gaps) {
    const start = a + DUCK_GUARD_SEC
    const end = b - DUCK_GUARD_SEC
    if (end - start < 0.05) continue
    parts.push(`volume=enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':volume=${linear}`)
  }
  return parts.length ? parts.join(',') : null
}

export const VOICE_PACING_PARAMS = {
  MAX_GAP_SEC, MAX_INIT_GAP_SEC, MAX_END_GAP_SEC,
  TARGET_GAP_SEC, TARGET_INIT_GAP_SEC, TARGET_END_GAP_SEC,
  DUCK_DB, DUCK_GUARD_SEC,
}
