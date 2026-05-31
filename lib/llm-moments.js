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

// System prompt para el modo "video 100% generado por IA" (Opción 3 / generate_full_ai).
// A diferencia de detectKeyMoments (que elige POCOS momentos para OVERLAY sobre footage),
// acá las imágenes SON el lienzo: hay que partir la narración en N escenas CONSECUTIVAS
// que cubren el video entero, una ilustración por tramo de lo que se dice.
function buildScenesSystemPrompt(styleLabel, targetCount) {
  return `Sos director de arte de un video comercial 100% generado por IA (sin footage real).
Recibís la transcripción word-level (con timestamps) de la narración en off.
Tu trabajo: dividir la narración en EXACTAMENTE ${targetCount} ESCENAS visuales consecutivas que ILUSTREN lo que se dice, una tras otra, cubriendo el video de principio a fin SIN huecos.

Las imágenes se generarán en el estilo visual "${styleLabel}" — ese estilo se aplica AUTOMÁTICAMENTE después. Vos NO lo describís ni mencionás técnica/render/cámara/iluminación.

Reglas de cada escena:
1. UNA sola idea/sujeto claro por escena (un objeto, una persona, una acción, un concepto). MINIMALISTA — NO es una infografía: NADA de listas, múltiples elementos ni varios carteles de texto.
2. La escena ILUSTRA lo que la voz dice en ESE tramo (mirá los timestamps): el problema/hook al inicio, el proceso/beneficios en el medio, el resultado/llamado a la acción al final.
3. Las escenas van EN ORDEN narrativo y son CONSECUTIVAS (la escena 2 empieza donde termina la 1, etc.). La primera empieza en 0.

OUTPUT: ARRAY JSON puro de EXACTAMENTE ${targetCount} objetos, sin markdown. Por cada escena:
- startSec (number): segundo aproximado donde EMPIEZA esa escena (basado en los timestamps del transcript; la primera = 0)
- prompt (string EN INGLÉS): la escena/sujeto SIMPLE a ilustrar. Frase corta, MAX 120 chars. Sin palabras de estilo artístico.

Ejemplo (3 escenas):
[
  {"startSec": 0, "prompt": "a frustrated business owner staring at a phone full of unanswered messages at night"},
  {"startSec": 9.5, "prompt": "a friendly AI assistant chat bubble replying to a customer message"},
  {"startSec": 22.0, "prompt": "a happy customer giving a thumbs up next to a glowing five-star review"}
]`
}

/**
 * detectScriptScenes(words, anthropicKey, opts?) → Array<{startSec, endSec, prompt}>
 *  Para la Opción 3 (video 100% generado por IA, sin footage). Divide la narración en
 *  N escenas CONSECUTIVAS que cubren 0..totalDur SIN huecos — las imágenes son el LIENZO,
 *  no overlays. Los tiempos se normalizan en JS para garantizar cobertura continua aunque
 *  el LLM se desvíe. Devuelve [] si falta key/words o el modelo falla (caller cae a fondo negro).
 *  - opts.targetCount: nº de escenas deseado (default ~1 cada 7s, cap 12)
 *  - opts.totalDur: duración total del video (de la voz)
 *  - opts.visualStyle: estilo elegido por el cliente
 */
export async function detectScriptScenes(words, anthropicKey, opts = {}) {
  if (!anthropicKey) {
    console.warn('[llm-moments] ANTHROPIC_API_KEY missing — detectScriptScenes skipped')
    return []
  }
  if (!Array.isArray(words) || words.length === 0) {
    console.warn('[llm-moments] no words from Whisper — detectScriptScenes skipped')
    return []
  }

  const totalDur = opts.totalDur || words[words.length - 1]?.end || 0
  if (totalDur < 4) {
    console.log(`[llm-moments] video too short (${totalDur}s) — detectScriptScenes skipped`)
    return []
  }
  const targetCount = Math.max(2, Math.min(12, opts.targetCount || Math.round(totalDur / 7)))
  const visualStyle = normalizeStyle(opts.visualStyle)
  const styleLabel = (STYLES[visualStyle] || STYLES[DEFAULT_STYLE]).label
  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')

  const userMsg = `Duración total: ${totalDur.toFixed(1)}s. Generá EXACTAMENTE ${targetCount} escenas que cubran TODO el video en orden.\n\nTranscript word-level:\n${transcript}`

  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: buildScenesSystemPrompt(styleLabel, targetCount),
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
    if (!Array.isArray(parsed) || parsed.length === 0) return []

    const scenes = parsed
      .filter((s) => typeof s.prompt === 'string' && s.prompt.length > 5)
      .map((s) => ({ startSec: typeof s.startSec === 'number' ? s.startSec : null, prompt: s.prompt.trim() }))
    if (scenes.length === 0) return []

    // Construir tiempos CONTIGUOS que cubren 0..totalDur sin huecos. Si el LLM dio
    // startSec usables los respetamos (ordenados + forzados monótonos); si no, parejo.
    const N = scenes.length
    const haveStarts = scenes.every((s) => typeof s.startSec === 'number')
    if (haveStarts) scenes.sort((a, b) => a.startSec - b.startSec)
    const starts = new Array(N)
    for (let i = 0; i < N; i++) {
      starts[i] = i === 0 ? 0 : haveStarts ? scenes[i].startSec : (i * totalDur) / N
      // garantizar monotonía estricta (evita escenas de duración 0/negativa)
      if (i > 0 && starts[i] <= starts[i - 1]) {
        starts[i] = starts[i - 1] + (totalDur - starts[i - 1]) / (N - i + 1)
      }
    }
    const out = scenes.map((s, i) => ({
      startSec: starts[i],
      endSec: i < N - 1 ? starts[i + 1] : totalDur,
      prompt: s.prompt,
    }))

    console.log(`[llm-moments] detectScriptScenes: ${N} scenes covering ${totalDur.toFixed(1)}s`)
    return out
  } catch (e) {
    console.warn(`[llm-moments] detectScriptScenes failed: ${e?.message ?? e}`)
    return []
  }
}
