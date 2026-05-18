// Detección determinista de muletillas, repeticiones y trabazones a partir
// de Whisper word-level timestamps. Cero costo extra (reusa la transcripción
// que ya corremos para captions).
//
// Output: array de { start, end, reason } con rangos de tiempo (en segundos)
// que el caller debe cortar del video.

// Muletillas ES — palabras únicas certeras (~95% son ruido)
const FILLER_ES = new Set([
  'eh', 'uhm', 'um', 'ah', 'er', 'em', 'eee', 'ahh', 'uhh', 'mhm', 'hmm',
  'este', 'esto',
  'digamos', 'viste',
  'literalmente', 'basicamente', 'básicamente',
  'pues',
  'nada',
])

// Muletillas EN — Descript default
const FILLER_EN = new Set([
  'um', 'uh', 'ah', 'er', 'hmm', 'mhm',
  'actually', 'basically', 'literally',
])

// Frases multi-palabra (lookahead)
const FILLER_PHRASES = [
  'o sea', 'osea',
  'digamos que', 'viste que',
  'y nada',
  'you know', 'you know what i mean',
  'i mean',
  'como que',
]

// Whitelist — palabras ambiguas que suelen ser conectores intencionales,
// NUNCA se cortan aunque matcheen el diccionario.
const WHITELIST = new Set([
  'bueno', 'entonces', 'ya', 'como', 'claro', 'mira', 'mirá',
])

function normalize(text) {
  return (text ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,!?¿¡:;]/g, '')
}

// 'tipo' es muletilla solo si NO precede a 'de' (ej. "tipo es buenísimo" sí;
// "tipo de wrap" no — palabra natural).
function shouldCutTipo(words, i) {
  if (i + 1 >= words.length) return true
  return normalize(words[i + 1].word) !== 'de'
}

// 'so' al inicio de frase (después de silencio o final de frase previa) es
// filler EN. Si está mid-sentence, es conjunción legítima.
function shouldCutSo(words, i) {
  if (i === 0) return true
  const prev = words[i - 1]
  // Gap mayor a 0.4s indica nueva frase
  const gap = words[i].start - prev.end
  if (gap > 0.4) return true
  const prevText = normalize(prev.word)
  return /[.!?]$/.test(prev.word) || prevText === ''
}

// Frase larga: detecta repetición consecutiva exacta de la misma palabra.
// Mantiene la 2da ocurrencia (tiende a estar más completa en pronunciación).
function isRepetition(prev, curr) {
  if (!prev) return false
  const a = normalize(prev.word)
  const b = normalize(curr.word)
  return a === b && a.length >= 2
}

// Trabazón: palabra muy corta (1-3 chars) cuya siguiente palabra empieza con
// esos chars. Ej. "m-" "muy", "es-" "estamos". Marca la primera para corte.
function isStutter(curr, next) {
  if (!next) return false
  const a = normalize(curr.word).replace(/-+$/, '')
  const b = normalize(next.word)
  if (a.length < 1 || a.length > 3 || b.length <= a.length) return false
  return b.startsWith(a)
}

/**
 * detectFillerRanges(words, opts?) → Array<{start, end, reason}>
 *
 * words: array de { word, start, end } de Whisper
 * opts.lang: 'es' | 'en' (default 'es') — afecta solo el diccionario simple
 */
export function detectFillerRanges(words, opts = {}) {
  const lang = opts.lang ?? 'es'
  const simpleDict = lang === 'en' ? FILLER_EN : FILLER_ES
  const ranges = []
  const counts = {} // reason → count, for logging

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const wText = normalize(w.word)
    if (!wText) continue

    // Whitelist tiene prioridad sobre todo
    if (WHITELIST.has(wText)) continue

    // 1. Frases multi-palabra (lookahead) — match más específico, primero
    let matched = false
    for (const phrase of FILLER_PHRASES) {
      const parts = phrase.split(' ')
      if (parts.length < 2 || i + parts.length > words.length) continue
      const slice = words.slice(i, i + parts.length).map((x) => normalize(x.word)).join(' ')
      if (slice === phrase) {
        ranges.push({
          start: words[i].start,
          end: words[i + parts.length - 1].end,
          reason: `phrase:${phrase}`,
        })
        counts[`phrase:${phrase}`] = (counts[`phrase:${phrase}`] ?? 0) + 1
        i += parts.length - 1
        matched = true
        break
      }
    }
    if (matched) continue

    // 2. 'tipo' contextual
    if (wText === 'tipo' && shouldCutTipo(words, i)) {
      ranges.push({ start: w.start, end: w.end, reason: 'filler:tipo' })
      counts['filler:tipo'] = (counts['filler:tipo'] ?? 0) + 1
      continue
    }

    // 3. 'so' contextual (EN)
    if (wText === 'so' && lang === 'en' && shouldCutSo(words, i)) {
      ranges.push({ start: w.start, end: w.end, reason: 'filler:so' })
      counts['filler:so'] = (counts['filler:so'] ?? 0) + 1
      continue
    }

    // 4. Filler simple del diccionario
    if (simpleDict.has(wText)) {
      ranges.push({ start: w.start, end: w.end, reason: `filler:${wText}` })
      counts[`filler:${wText}`] = (counts[`filler:${wText}`] ?? 0) + 1
      continue
    }

    // 5. Repetición consecutiva: marcar la palabra ANTERIOR (i-1), no esta.
    //    Solo si la previa NO está en whitelist.
    if (i > 0 && isRepetition(words[i - 1], w)) {
      const prevText = normalize(words[i - 1].word)
      if (!WHITELIST.has(prevText)) {
        const prev = words[i - 1]
        ranges.push({ start: prev.start, end: prev.end, reason: 'repetition' })
        counts['repetition'] = (counts['repetition'] ?? 0) + 1
        continue
      }
    }

    // 6. Trabazón: marcar ESTA palabra si la siguiente empieza con sus chars
    if (i + 1 < words.length && isStutter(w, words[i + 1])) {
      ranges.push({ start: w.start, end: w.end, reason: 'stutter' })
      counts['stutter'] = (counts['stutter'] ?? 0) + 1
      continue
    }
  }

  return { ranges, counts }
}

/**
 * Merge solapamientos y orden por start ascendente. Idempotente.
 */
export function mergeRanges(ranges, gapTolerance = 0.05) {
  if (ranges.length <= 1) return [...ranges].sort((a, b) => a.start - b.start)
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const curr = sorted[i]
    if (curr.start <= last.end + gapTolerance) {
      last.end = Math.max(last.end, curr.end)
      last.reason = `${last.reason}+${curr.reason}`
    } else {
      merged.push({ ...curr })
    }
  }
  return merged
}

/**
 * Construye el `select=` filter inverso: rangos a MANTENER (complemento de los
 * rangos a cortar). Devuelve string para usar dentro de un -vf/-af.
 * Si cutRanges está vacío, devuelve null (caller debe skipear el filter).
 */
export function buildKeepFilter(cutRanges, totalDur) {
  if (cutRanges.length === 0) return null
  const merged = mergeRanges(cutRanges)
  const keep = []
  let cursor = 0
  for (const r of merged) {
    if (r.start > cursor + 0.05) keep.push([cursor, r.start])
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < totalDur - 0.05) keep.push([cursor, totalDur])
  if (keep.length === 0) return null
  return keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+')
}
