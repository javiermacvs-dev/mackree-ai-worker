// Detección de pausas reales en speech via Whisper word-gaps.
// Reemplaza el silence-trim dB-based (que falla con clips de cámara/celular
// con ambient noise alto donde NINGÚN umbral dB clasifica pausas como silencio).
//
// Idea: Whisper ya nos da timestamps word-level. Entre dos palabras consecutivas
// hay un gap = word[i+1].start - word[i].end. Si ese gap es > threshold, es
// una PAUSA REAL (no depende del nivel de ruido). Cortarla.
//
// Esto SÍ funciona donde silencedetect dB falla porque:
//   - Whisper sabe DONDE hay palabras (semántica), no le importa el ruido
//   - Pausa entre palabras = el speaker se quedó callado, sin importar si la
//     cámara/AC/viento producen rumble de fondo
//
// Calibrado contra fuentes expertas (Rendi.dev + Descript blog):
//   - Reels/high-energy: cortar gaps > 0.3s
//   - Educational: > 0.5-0.8s
//   - Podcast: > 0.8-1.0s
// Default v26: 0.4s (un poco más permisivo que Reels puro porque a veces
// hay pausa intencional pre-énfasis que vale conservar).

/**
 * detectWordGaps(words, opts?) → { ranges: Array<{start, end, reason}>, counts: {gap: N} }
 *  - words: Array de { word, start, end } de Whisper word-level
 *  - opts.minGapSec: gap mínimo en segundos para cortar (default 0.4)
 *  - opts.padding: aire a mantener a cada lado del corte (default 0.10s)
 *  - opts.introGuardSec: NO cortar gaps que terminen antes de este timestamp (default 2.5s — preserva apertura)
 *  - opts.outroGuardSec: NO cortar gaps que empiecen después de totalDur-este (default 1.5s — preserva cierre)
 */
export function detectWordGaps(words, opts = {}) {
  const minGapSec = opts.minGapSec ?? 0.4
  const padding = opts.padding ?? 0.10
  const introGuard = opts.introGuardSec ?? 2.5
  const outroGuard = opts.outroGuardSec ?? 1.5

  if (!Array.isArray(words) || words.length < 2) {
    return { ranges: [], counts: {} }
  }

  const totalDur = words[words.length - 1]?.end ?? 0
  const ranges = []
  let totalGapSec = 0

  for (let i = 0; i < words.length - 1; i++) {
    const wEnd = words[i].end ?? 0
    const wNext = words[i + 1].start ?? 0
    const gap = wNext - wEnd
    if (gap < minGapSec) continue

    // Aplicar padding (achicar el rango cortado a cada lado para no comer respiración)
    const cutStart = wEnd + padding
    const cutEnd = wNext - padding
    const effectiveGap = cutEnd - cutStart
    if (effectiveGap < 0.10) continue // gap muy chico tras padding, skip

    // Intro guard: no cortar si el gap termina antes del intro guard
    if (cutEnd < introGuard) continue
    // Outro guard: no cortar si el gap empieza después de totalDur - outroGuard
    if (cutStart > totalDur - outroGuard) continue

    ranges.push({
      start: cutStart,
      end: cutEnd,
      reason: `gap:${gap.toFixed(2)}s`,
    })
    totalGapSec += effectiveGap
  }

  console.log(
    `[word-gaps] detected ${ranges.length} pauses > ${minGapSec}s ` +
      `(total ${totalGapSec.toFixed(2)}s to cut, padding ${padding}s)`,
  )

  return { ranges, counts: { gap: ranges.length } }
}
