// LLM-based detección de momentos clave para insertar imágenes IA generadas.
// Analiza transcript word-level de Whisper y devuelve hasta N momentos con
// prompts en inglés para nano-banana-2.
//
// Cost por job: ~$0.01 (Haiku 4.5, input ~1000 tokens, output ~500 tokens).

import Anthropic from '@anthropic-ai/sdk'
import { STYLES, DEFAULT_STYLE, normalizeStyle } from './styles.js'

// El estilo visual (doodle/whiteboard/flat/isometric/claymation/watercolor) lo
// elige el cliente y se aplica AUTOMÁTICAMENTE en kie-image (prepend del prompt_base).
// Por eso acá el LLM devuelve SOLO el sujeto/escena, sin palabras de estilo artístico.
function buildSystemPrompt(styleLabel) {
  return `Sos director de arte de un video commercial wrap (vehicular wraps, color change, PPF, lettering).
Recibís transcripción Whisper word-level del audio del cliente.
Devolvés hasta N momentos donde una imagen de apoyo se vería ÉPICA insertada en el video.

Las imágenes se generarán en el estilo visual "${styleLabel}" — ese estilo se aplica AUTOMÁTICAMENTE después. Vos NO lo describís ni mencionás técnica/render/cámara.

Criterios para elegir momentos:
1. Cuando el speaker MENCIONA visualmente algo concreto (vehículo específico, color, material, instalación, transformación, marca de cliente, ambiente del taller, primer plano)
2. Pausas naturales o transiciones de tema (no en mitad de frase)
3. Distribuidos a lo largo del video — no todos juntos (~1 cada 15-20s ideal)
4. Distribución por duración (MENOS es mejor — no saturar el video):
   - Video <30s → máximo 2 momentos
   - 30-60s → 2-3 momentos
   - 60-90s → 3 momentos
   - ≥90s → 4 momentos

NUNCA elijas:
- Los primeros 3s (saludo/hook del Reel)
- Los últimos 3s (cierre/CTA)
- Mitad de palabra o frase
- Momentos pegados (<8s entre uno y otro)

OUTPUT: ARRAY JSON puro. Sin markdown. Si el transcript es muy corto o nada destaca visualmente, devolvé [].
Por cada momento:
- startSec (number): segundo donde aparece la imagen
- endSec (number): startSec + 3 (siempre 3 segundos)
- prompt (string EN INGLÉS): describí UNA escena SIMPLE con UN solo sujeto principal (un vehículo, una acción, un objeto). MANTENELO MINIMALISTA — NO es una infografía: NADA de múltiples elementos, NADA de listas de beneficios, NADA de varios carteles/labels de texto. Una sola idea clara por imagen. NO incluyas palabras de estilo artístico, render, fotografía, cámara ni iluminación — el estilo se aplica aparte. Frase corta. MAX 120 chars.

Ejemplo válido (solo el sujeto, SIN estilo):
[
  {"startSec": 8.5, "endSec": 11.5, "prompt": "a red vinyl wrap being applied to a pickup truck door inside a workshop"},
  {"startSec": 28.0, "endSec": 31.0, "prompt": "a fully wrapped commercial trailer with company branding parked outside a shop"}
]`
}

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
  const visualStyle = normalizeStyle(opts.visualStyle)
  const styleLabel = (STYLES[visualStyle] || STYLES[DEFAULT_STYLE]).label
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
      system: buildSystemPrompt(styleLabel),
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
