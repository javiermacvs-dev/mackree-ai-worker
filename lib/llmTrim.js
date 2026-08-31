// LLM-based detección de comienzos titubeantes y tomas falsas.
// Complementa la detección determinista de fillerWords.js. Corre Claude
// Sonnet 4.6 sobre la transcripción completa y le pide rangos a cortar.
//
// Cost por job: ~$0.005 (input ~500 tokens, output ~200 tokens) para clip
// de 2 min. Marginal pero medible.

// Respaldo OpenAI: Anthropic sin saldo dejaba este modulo mudo (2026-08-31).
// LLMClient es drop-in de Anthropic — misma interfaz .messages.create().
import { LLMClient } from './llm-fallback.js'

const SYSTEM_PROMPT = `Eres editor de video pro. Recibes transcripción Whisper con timestamps y devuelves rangos a cortar. SÉ CONSERVADOR pero ATENTO a los 3 casos puntuales abajo.

⛔ REGLA INAMOVIBLE: NUNCA toques los primeros 3 segundos. El saludo del speaker es SAGRADO ("Bueno mi gente", "Hola amigos", "Qué tal a todos", "Hoy les quiero contar", "Y bueno hablando de...") — NO es titubeo, es el hook del Reel.

CORTA en estos 3 casos:
1. **Tomas falsas explícitas**: el speaker LITERALMENTE dice "espera, dejame empezar de nuevo", "déjame intentar otra vez", "perdón, lo digo otra vez", "ay no, espera". Corta desde el inicio de la frase fallida hasta donde retoma.

2. **Repeticiones de idea completa**: el speaker dice una frase entera, hace pausa larga (>1s), y la repite REFORMULADA mejor. Corta la primera versión completa.

3. **PUENTE entre clips (NUEVO)**: cuando un video se compone de varios clips concatenados, a veces el speaker termina un clip con una palabra y empieza el siguiente clip con la MISMA palabra (técnica de continuidad). Eso genera redundancia al concatenar. Detección: misma palabra significativa (5+ chars como "normalmente", "entonces", "porque", "obviamente", "literalmente") repetida 2 veces con pausa BREVE entre medias (<2s), en cualquier punto MEDIO del audio (no inicio). Cortá la segunda ocurrencia (la del inicio del clip siguiente). Si la palabra es corta (<5 chars como "y", "es", "lo") NO cortes — pueden ser repeticiones naturales del habla.

NUNCA cortes:
- Apertura/saludo del video (primeros 3 segundos intactos)
- Pausas dramáticas pre-CTA
- Conectores naturales ("bueno", "entonces", "y nada", "mira") cuando aparecen sueltos
- Frases que arrancan con muletilla pero llegan al punto (un sistema deterministic separado maneja muletillas individuales — vos NO las toques)
- Cualquier cosa de la que NO estés 90% seguro

OUTPUT: ARRAY JSON puro. Sin markdown. Si dudás, []
Ejemplo válido: [{"start":12.4,"end":15.1,"reason":"false_start"},{"start":45.3,"end":46.1,"reason":"clip_bridge_normalmente"}]
Ejemplo INVÁLIDO: cortar "Bueno mi gente aquí..." pensando que es titubeo. ESO es saludo, NUNCA.`

/**
 * llmDetectFalseStartsAndRetakes(words, anthropicKey) → Array<{start, end, reason}>
 * - words: Array de { word, start, end } de Whisper
 * - anthropicKey: process.env.ANTHROPIC_API_KEY del worker
 * Devuelve [] si la key no está, si el modelo falla, o si no hay nada que cortar.
 */
export async function llmDetectFalseStartsAndRetakes(words, anthropicKey) {
  if (!anthropicKey) {
    console.warn('[llm] ANTHROPIC_API_KEY missing — false-starts detection skipped')
    return []
  }
  if (!Array.isArray(words) || words.length < 8) {
    console.log(`[llm] too few words (${words?.length ?? 0}), skipping`)
    return []
  }

  const transcript = words
    .map((w) => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.word}`)
    .join(' ')

  const client = new LLMClient({ apiKey: anthropicKey, maxRetries: 2 })
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Transcripción del clip:\n\n${transcript}\n\nDevuelve ARRAY JSON puro de rangos a cortar.`,
        },
      ],
    })
    const block = msg.content[0]
    if (!block || block.type !== 'text') {
      console.warn('[llm] unexpected response shape')
      return []
    }
    const raw = block.text.trim()
    // Strip markdown fences just in case
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()
    let parsed
    try {
      parsed = JSON.parse(stripped)
    } catch (e) {
      console.warn(`[llm] JSON parse failed. Raw response (200 chars): ${raw.slice(0, 200)}`)
      return []
    }
    if (!Array.isArray(parsed)) {
      console.warn('[llm] response is not an array')
      return []
    }
    const INTRO_GUARD_SEC = 3.0 // hard guard: nunca cortar los primeros 3s
    const allValid = parsed
      .filter(
        (r) =>
          r &&
          typeof r.start === 'number' &&
          typeof r.end === 'number' &&
          r.end > r.start &&
          r.start >= 0,
      )
    const validated = allValid
      .filter((r) => {
        if (r.start < INTRO_GUARD_SEC) {
          console.warn(
            `[llm] guard rail: discarded range start=${r.start.toFixed(2)}s end=${r.end.toFixed(2)}s (touches intro <${INTRO_GUARD_SEC}s)`,
          )
          return false
        }
        return true
      })
      .map((r) => ({
        start: r.start,
        end: r.end,
        reason: typeof r.reason === 'string' ? `llm:${r.reason}` : 'llm:unknown',
      }))
    console.log(
      `[llm] detected ${validated.length} valid ranges (${allValid.length - validated.length} discarded by intro guard)`,
    )
    return validated
  } catch (e) {
    console.warn(`[llm] API call failed: ${e?.message ?? e}`)
    return []
  }
}
