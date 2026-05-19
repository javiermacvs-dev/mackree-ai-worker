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
  // v27: threshold bajado de 0.4 → 0.30s. Captures gaps "cortos pero notorios".
  const minGapSec = opts.minGapSec ?? 0.30
  const padding = opts.padding ?? 0.10
  // v27: el intro guard ya NO protege gaps internos del speech. Solo el gap
  // INICIAL (de t=0 a primer word) se maneja aparte abajo con guardia chica.
  const introGuard = opts.introGuardSec ?? 0.30
  const outroGuard = opts.outroGuardSec ?? 0.30
  // v27: cortar silencio ANTES de la primera palabra (donde vive el ruido
  // terrible del inicio). Si la primera palabra empieza > 0.4s, ese pre-roll
  // es silencio puro / ruido del micro.
  const minInitGap = opts.minInitGapSec ?? 0.40
  const minEndGap = opts.minEndGapSec ?? 0.40

  if (!Array.isArray(words) || words.length === 0) {
    return { ranges: [], counts: {} }
  }

  const totalDur = opts.totalDur ?? (words[words.length - 1]?.end ?? 0)
  const ranges = []
  let totalGapSec = 0
  let initCut = 0
  let endCut = 0
  let midCut = 0

  // === CORTE INICIAL: silencio ANTES de la primera palabra ===
  // El ruido del micro/cámara al principio del clip se acumula acá.
  const firstWordStart = words[0]?.start ?? 0
  if (firstWordStart > minInitGap) {
    const cutStart = 0.0
    const cutEnd = Math.max(0.0, firstWordStart - padding)
    if (cutEnd - cutStart >= 0.10) {
      ranges.push({
        start: cutStart,
        end: cutEnd,
        reason: `gap_init:${firstWordStart.toFixed(2)}s`,
      })
      initCut = cutEnd - cutStart
    }
  }

  // === CORTES MEDIOS: gaps entre palabras consecutivas ===
  for (let i = 0; i < words.length - 1; i++) {
    const wEnd = words[i].end ?? 0
    const wNext = words[i + 1].start ?? 0
    const gap = wNext - wEnd
    if (gap < minGapSec) continue

    const cutStart = wEnd + padding
    const cutEnd = wNext - padding
    const effectiveGap = cutEnd - cutStart
    if (effectiveGap < 0.10) continue

    // Mini intro guard: si el gap termina dentro de los primeros 0.30s del speech
    // post-init-cut, lo respetamos (probablemente arranque del speaker).
    // outroGuard: NO cortar gaps mid-speech que toquen el último 0.30s.
    if (cutStart > totalDur - outroGuard) continue

    ranges.push({
      start: cutStart,
      end: cutEnd,
      reason: `gap:${gap.toFixed(2)}s`,
    })
    midCut += effectiveGap
  }

  // === CORTE FINAL: silencio DESPUÉS de la última palabra ===
  const lastWordEnd = words[words.length - 1]?.end ?? totalDur
  if (totalDur - lastWordEnd > minEndGap) {
    const cutStart = lastWordEnd + padding
    const cutEnd = totalDur
    if (cutEnd - cutStart >= 0.10) {
      ranges.push({
        start: cutStart,
        end: cutEnd,
        reason: `gap_end:${(totalDur - lastWordEnd).toFixed(2)}s`,
      })
      endCut = cutEnd - cutStart
    }
  }

  totalGapSec = initCut + midCut + endCut

  console.log(
    `[word-gaps] v27: ${ranges.length} cortes = ${totalGapSec.toFixed(2)}s ` +
      `(init=${initCut.toFixed(2)}s, mid=${midCut.toFixed(2)}s, end=${endCut.toFixed(2)}s, ` +
      `threshold=${minGapSec}s, padding=${padding}s)`,
  )

  return { ranges, counts: { gap: ranges.length } }
}
