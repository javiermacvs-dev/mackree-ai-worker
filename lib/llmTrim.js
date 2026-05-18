// LLM-based detección de comienzos titubeantes y tomas falsas.
// Complementa la detección determinista de fillerWords.js. Corre Claude
// Sonnet 4.6 sobre la transcripción completa y le pide rangos a cortar.
//
// Cost por job: ~$0.005 (input ~500 tokens, output ~200 tokens) para clip
// de 2 min. Marginal pero medible.

import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `Eres editor de video pro especializado en cortar momentos que dañan el ritmo. Recibes una transcripción de Whisper con timestamps por palabra y devuelves rangos a cortar para mejorar el flow.

CORTA SOLO:
1. Comienzos titubeantes que rellenan antes de llegar al punto real. Ejemplo: "Y bueno entonces lo que les quería decir era que el wrap..." → cortar todo hasta "el wrap". El criterio: si las primeras palabras son rodeos antes de la idea concreta, cortar hasta la idea.
2. Tomas falsas: el speaker dice "espera, dejame empezar de nuevo", "déjame intentar otra vez", o repite una idea completa porque la primera quedó mal. Corta la primera versión.

NO CORTES:
- Pausas dramáticas intencionales antes de un CTA
- Énfasis pre-punchline ("y entonces... ¡llegó el wrap!")
- Conectores naturales del habla en speech argumentativo
- Contenido importante aunque sea redundante

OUTPUT: ARRAY JSON puro con objetos {start, end, reason}. Sin markdown. Sin explicaciones. Si nada amerita corte, devuelve [].
Ejemplo válido: [{"start":2.4,"end":5.1,"reason":"false_start"},{"start":18.3,"end":21.0,"reason":"retake"}]
Ejemplo inválido: \`\`\`json [...] \`\`\` (NO uses fences markdown)`

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

  const client = new Anthropic({ apiKey: anthropicKey, maxRetries: 2 })
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
    const validated = parsed
      .filter(
        (r) =>
          r &&
          typeof r.start === 'number' &&
          typeof r.end === 'number' &&
          r.end > r.start &&
          r.start >= 0,
      )
      .map((r) => ({
        start: r.start,
        end: r.end,
        reason: typeof r.reason === 'string' ? `llm:${r.reason}` : 'llm:unknown',
      }))
    console.log(`[llm] detected ${validated.length} ranges to cut`)
    return validated
  } catch (e) {
    console.warn(`[llm] API call failed: ${e?.message ?? e}`)
    return []
  }
}
