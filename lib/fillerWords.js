// Detección determinista de muletillas, repeticiones y trabazones a partir
// de Whisper word-level timestamps. Cero costo extra (reusa la transcripción
// que ya corremos para captions).
//
// Output: array de { start, end, reason } con rangos de tiempo (en segundos)
// que el caller debe cortar del video.

// Muletillas ES — palabras únicas certeras (~95% son ruido).
//
// INAMOVIBLE 2026-05-18 (Javier): la sección de SONIDOS VOCALES PROLONGADOS es
// la huella personal de cómo habla Javier ("Eeeeeh", "Iiiii", etc). Estos cortes
// se mantienen agresivos pase lo que pase con el resto del sistema.
// Lista validada con investigación web (RAE, Babbel, Wikipedia speech disfluency).
//
// 2026-05-18: quitadas 'pues', 'nada', 'literalmente', 'basicamente', 'básicamente'
// (palabras ambiguas, pueden ser legítimas). Esto sí es ajustable.
// Ver mackree-ai-worker/CLAUDE.md → Decisiones inamovibles.
const FILLER_ES = new Set([
  // --- Vocales prolongadas (INAMOVIBLES) ---
  // E:
  'eh', 'ehh', 'ehhh', 'ehhhh', 'eee', 'eeee', 'eeeh', 'eeeeh',
  // A:
  'ah', 'ahh', 'ahhh', 'ahhhh', 'aaa', 'aaaa', 'aaah', 'aaaah',
  // I:
  'ih', 'ihh', 'iii', 'iiii', 'iiiii', 'iiiiii',
  // O:
  'oh', 'ohh', 'ohhh', 'ooo', 'oooo', 'ooooh',
  // U:
  'uh', 'uhh', 'uhhh', 'uuu', 'uuuu',
  // M / Hmm (sostenidos):
  'mm', 'mmm', 'mmmm', 'mmmmm', 'hmm', 'hmmm', 'hmmmm', 'mhm',
  // Combos con M:
  'uhm', 'um', 'umm', 'ummm', 'em', 'emm',
  // Otros estándar:
  'er', 'err', 'errr',
  // --- Muletillas léxicas (ajustables si cambia el feedback) ---
  'este', 'esto',
  'digamos', 'viste',
])

// Muletillas EN — Descript default + variantes prolongadas (INAMOVIBLES).
// 2026-05-18: quitadas 'actually', 'basically', 'literally' (adverbios legítimos).
const FILLER_EN = new Set([
  // Vocales prolongadas (INAMOVIBLES):
  'um', 'umm', 'ummm', 'ummmm',
  'uh', 'uhh', 'uhhh',
  'ah', 'ahh', 'ahhh',
  'oh', 'ohh', 'ohhh',
  'er', 'err', 'erm', 'ermm',
  'hmm', 'hmmm', 'hmmmm', 'mhm', 'mhmm',
  'mmm', 'mmmm', 'mmmmm',
])

// Frases multi-palabra (lookahead).
// 2026-05-18: quitada 'como que' (puede ser "es como que estoy cansado" legítimo).
const FILLER_PHRASES = [
  'o sea', 'osea',
  'digamos que', 'viste que',
  'y nada',
  'you know', 'you know what i mean',
  'i mean',
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

/**
 * Detecta sonidos sostenidos por TEXTO repetido — cuando Whisper sí transcribe
 * los caracteres repetidos: "Eeeee", "Uhhh", "Mmm", "Ahhh", "Aaaah".
 *
 * NO captura "yyyyyy" colapsado a "y" (1 char) — eso lo maneja
 * isProlongedSingleChar() abajo por duración temporal.
 */
function isSustainedSound(text) {
  if (text.length < 2) return false
  // INAMOVIBLE 2026-05-18: cubre TODAS las vocales (incluida 'y' como vocal débil/sostenida)
  // + h. Captura "Eeeee", "Aaaaa", "Iiiii", "Oooo", "Uuuu", "Yyyy", "Hmmm", etc.
  // Justificación research: muletillas son personales pero comparten estructura
  // [vocal+]+repetición. Cubrir el rango completo evita perder muletillas que
  // dependen del hablante (Javier dice "Eeeeeh", "Iiiii"; otra persona "Aaaa", "Ooooh", "Yyyy").
  if (/^[aeiouhy]+$/.test(text) && /(.)\1/.test(text)) return true
  if (/^m{2,}$/.test(text)) return true
  return false
}

/**
 * Detecta muletilla alargada por DURACIÓN temporal. Cubre 2 casos:
 *   (a) Whisper colapsó "yyyyyyy" sostenido → "y" (1 char) por 1.3s
 *   (b) Whisper transcribió "Eee" o "Eeh" (2-3 chars) pero con duración
 *       inflada por la sostenida
 *
 * Threshold escalado por longitud (calibrado v12 → v13 más estricto):
 *   - 1 char vocal/y/h:  dur > 0.40s (antes 0.50s — más agresivo)
 *   - 2 chars vocal/y/h: dur > 0.50s
 *   - 3 chars vocal/y/h: dur > 0.60s
 *
 * Justificación del scaling: una palabra más larga necesita más duración
 * para ser muletilla (vs palabra real). "ya" 0.50s podría ser palabra
 * normal, "ya" 0.70s ya es alargado.
 *
 * Whitelist tiene prioridad — palabras como "ya", "como", "claro" NUNCA
 * caen acá (se filtran antes en el loop principal).
 */
function isProlongedShortWord(word) {
  const t = normalize(word.word)
  if (t.length < 1 || t.length > 3) return false
  if (!/^[aeiouyh]+$/.test(t)) return false
  const dur = (word.end ?? 0) - (word.start ?? 0)
  // INAMOVIBLE 2026-05-18: thresholds 0.4/0.5/0.6s capturan "Eeeeeh" y "Iiiii" de Javier
  // — son muletillas personales suyas. Confirmado funcionando en render f1203785.
  // NO suavizar acá aunque se baje agresividad en otros rubros. Ver mackree-ai-worker/CLAUDE.md.
  const threshold = 0.3 + t.length * 0.1  // 0.4 / 0.5 / 0.6
  return dur > threshold
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

    // 4.5. Sonido sostenido por TEXTO repetido ("Eeeee", "Uhhh", "Mmm").
    if (isSustainedSound(wText)) {
      ranges.push({ start: w.start, end: w.end, reason: `sustained:${wText}` })
      counts['sustained_sound'] = (counts['sustained_sound'] ?? 0) + 1
      continue
    }

    // 4.6. Muletilla alargada (1-3 chars vocal/y/h con duración alta).
    //      Whisper la transcribe corta pero la duración temporal lo revela.
    if (isProlongedShortWord(w)) {
      const dur = (w.end - w.start).toFixed(2)
      ranges.push({ start: w.start, end: w.end, reason: `prolonged:${wText}_${dur}s` })
      counts['prolonged'] = (counts['prolonged'] ?? 0) + 1
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
 * Detección determinista de "palabra-puente" entre clips: cuando un clip
 * termina con palabra X y el siguiente empieza con X (técnica de continuidad
 * que Javier usa al grabar). Genera redundancia al concatenar.
 *
 * Antes esto vivía SOLO en el system prompt del LLM. Pero el LLM puede
 * fallar / saltar el caso. Esta función garantiza la regla con código:
 *
 *   - Misma palabra significativa (length >= 4) repetida 2 veces
 *   - Gap entre ocurrencias < 2.5s (típico de transición entre clips)
 *   - Segunda ocurrencia fuera de los primeros 3s (intro guard)
 *   - Whitelist exclusión (NUNCA matchear bueno/entonces/ya/como/etc.)
 *
 * Marca la SEGUNDA ocurrencia para corte (mantiene la del final del clip
 * anterior).
 */
export function detectClipBridgeRepetitions(words) {
  const ranges = []
  const counts = {}
  const MIN_LEN = 4
  const MAX_GAP = 2.5
  const INTRO_GUARD = 3.0

  for (let i = 0; i < words.length - 1; i++) {
    const wA = words[i]
    const tA = normalize(wA.word)
    if (tA.length < MIN_LEN) continue
    if (WHITELIST.has(tA)) continue

    // Buscar la misma palabra en las próximas 8 (gap temporal pequeño)
    for (let j = i + 1; j < Math.min(i + 9, words.length); j++) {
      const wB = words[j]
      const tB = normalize(wB.word)
      if (tA !== tB) continue
      const gap = wB.start - wA.end
      if (gap < 0) continue
      if (gap > MAX_GAP) break  // siguientes solo están más lejos
      if (wB.start < INTRO_GUARD) continue
      ranges.push({ start: wB.start, end: wB.end, reason: `clip_bridge:${tA}` })
      counts['clip_bridge'] = (counts['clip_bridge'] ?? 0) + 1
      break  // mantengo solo el primer match cercano, no cadena
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
