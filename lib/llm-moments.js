// LLM-based detección de momentos clave para insertar imágenes IA generadas.
// Analiza transcript word-level de Whisper y devuelve hasta N momentos con
// prompts en inglés para nano-banana-2.
//
// Cost por job: ~$0.01 (Haiku 4.5, input ~1000 tokens, output ~500 tokens).

import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `Sos director de arte de un video commercial wrap (vehicular wraps, color change, PPF, lettering).
Recibís transcripción Whisper word-level del audio del cliente.
Devolvés hasta N momentos donde una imagen IA generada se vería ÉPICA insertada como visual de apoyo.

Criterios para elegir momentos:
1. Cuando el speaker MENCIONA visualmente algo concreto (vehículo específico, color, material, instalación, transformación, marca de cliente, ambiente del taller, primer plano)
2. Pausas naturales o transiciones de tema (no en mitad de frase)
3. Distribuidos a lo largo del video — no todos juntos (~1 cada 15-20s ideal)
4. Distribución por duración:
   - Video <30s → máximo 2 momentos
   - 30-60s → 3 momentos
   - 60-90s → 4 momentos
   - ≥90s → 5 momentos

NUNCA elijas:
- Los primeros 3s (saludo/hook del Reel)
- Los últimos 3s (cierre/CTA)
- Mitad de palabra o frase
- Momentos pegados (<8s entre uno y otro)

OUTPUT: ARRAY JSON puro. Sin markdown. Si el transcript es muy corto o nada destaca visualmente, devolvé [].
Por cada momento:
- startSec (number): segundo donde aparece la imagen
- endSec (number): startSec + 3 (siempre 3 segundos)
- prompt (string EN INGLÉS): descripción visual para nano-banana-2.
  Estilo obligado: "cinematic, photorealistic, automotive, professional photography".
  Mencionar elementos concretos del audio (color, vehículo, ángulo, ambiente).
  MAX 200 chars.

Ejemplo válido:
[
  {"startSec": 8.5, "endSec": 11.5, "prompt": "Cinematic close-up of a satin red vinyl wrap being applied to a Ford Maverick truck door, professional automotive photography, golden hour lighting"},
  {"startSec": 28.0, "endSec": 31.0, "prompt": "Wide shot of a fully wrapped commercial trailer in matte black with subtle company branding, parked in modern industrial setting, cinematic lighting"}
]`

/**
 * detectKeyMoments(words, anthropicKey, opts?) → Array<{startSec, endSec, prompt}>
 *  - words: Array de { word, start, end } de Whisper
 *  - anthropicKey: ANTHROPIC_API_KEY del worker
 *  - opts.maxMoments: max momentos a devolver (default 5)
 * Devuelve [] si la key no está, no hay transcripción, el modelo falla o no hay nada visual.
 */
export async function detectKeyMoments(words, anthropicKey, opts = {}) {
  if (!anthropicKey) {
    console.warn('[llm-moments] ANTHROPIC_API_KEY missing — skipped')
    return []
  }
  if (!Array.isArray(words) || words.length === 0) {
    console.warn('[llm-moments] no words from Whisper — skipped')
    return []
  }

  const maxMoments = opts.maxMoments || 5
  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')
  const totalDur = words[words.length - 1]?.end ?? 0
  if (totalDur < 10) {
    console.log(`[llm-moments] video too short (${totalDur}s) — skipped`)
    return []
  }

  const userMsg = `Duración total: ${totalDur.toFixed(1)}s. Máximo ${maxMoments} momentos.\n\nTranscript word-level:\n${transcript}`

  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    })
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : ''
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []

    // Validate + filter
    const valid = parsed
      .filter(
        (m) =>
          typeof m.startSec === 'number' &&
          typeof m.endSec === 'number' &&
          typeof m.prompt === 'string' &&
          m.prompt.length > 10,
      )
      .filter((m) => m.startSec >= 3 && m.endSec <= totalDur - 3) // respetar intro/outro
      .slice(0, maxMoments)

    console.log(`[llm-moments] detected ${valid.length} moments for AI images (of ${parsed.length} returned)`)
    return valid
  } catch (e) {
    console.warn(`[llm-moments] failed: ${e?.message ?? e}`)
    return []
  }
}
