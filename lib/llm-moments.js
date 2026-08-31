// LLM-based detección de momentos clave para insertar imágenes IA generadas.
// Analiza transcript word-level de Whisper y devuelve hasta N momentos con
// prompts en inglés para nano-banana-2.
//
// Cost por job: ~$0.01 (Haiku 4.5, input ~1000 tokens, output ~500 tokens).

// Respaldo OpenAI: Anthropic sin saldo dejaba este modulo mudo (2026-08-31).
// LLMClient es drop-in de Anthropic — misma interfaz .messages.create().
import { LLMClient } from './llm-fallback.js'
import { STYLES, DEFAULT_STYLE, normalizeStyle } from './styles.js'

// El estilo visual (doodle/whiteboard/flat/isometric/claymation/watercolor) lo
// elige el cliente y se aplica AUTOMÁTICAMENTE en kie-image (prepend del prompt_base).
// Por eso acá el LLM devuelve SOLO el sujeto/escena, sin palabras de estilo artístico.
function buildSystemPrompt(styleLabel, themeLine) {
  const theme = themeLine && themeLine.trim()
    ? themeLine.trim()
    : 'el contenido/negocio del cliente (mirá lo que dice la voz para inferirlo)'
  return `Sos director de arte de un video comercial. EL VIDEO TRATA SOBRE: ${theme}.
Recibís transcripción Whisper word-level del audio del cliente.
Devolvés hasta N momentos donde una imagen de apoyo se vería ÉPICA insertada en el video.

Las imágenes se generarán en el estilo visual "${styleLabel}" — ese estilo se aplica AUTOMÁTICAMENTE después. Vos NO lo describís ni mencionás técnica/render/cámara.

⛔ REGLA #1 (la más importante): CADA imagen DEBE estar DIRECTAMENTE relacionada con el TEMA REAL del video (lo de arriba) y con lo que dice la voz EN ESE momento. PROHIBIDO inventar sujetos genéricos que no tengan que ver con el negocio/producto/tema del cliente. Si el video es de un food truck, las imágenes son de ESE food truck / su comida / su rotulación — NUNCA autos al azar u objetos sin relación.

⛔ NO son obligatorias: si un momento no permite una imagen claramente relacionada con el tema, NO lo incluyas. MEJOR MENOS (o NINGUNA) imagen que una irrelevante. Devolver [] es una respuesta válida y preferible a forzar algo fuera de tema.

Criterios para elegir momentos:
1. Cuando el speaker MENCIONA visualmente algo concreto del tema (el producto/vehículo/lugar específico, color, material, proceso, resultado, marca del cliente, primer plano)
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

OUTPUT: ARRAY JSON puro. Sin markdown. Si el transcript es muy corto o nada destaca visualmente CON RELACIÓN AL TEMA, devolvé [].
Por cada momento:
- startSec (number): segundo donde aparece la imagen
- endSec (number): startSec + 3 (siempre 3 segundos)
- prompt (string EN INGLÉS): describí UNA escena SIMPLE con UN solo sujeto principal, SIEMPRE relacionado con el tema real (lo de arriba). MANTENELO MINIMALISTA — NO es una infografía: NADA de múltiples elementos, NADA de listas de beneficios, NADA de varios carteles/labels de texto. Una sola idea clara por imagen. NO incluyas palabras de estilo artístico, render, fotografía, cámara ni iluminación — el estilo se aplica aparte. Frase corta. MAX 120 chars.

Ejemplo (si el tema fuera un food truck de tacos):
[
  {"startSec": 8.5, "endSec": 11.5, "prompt": "a red food truck with taco graphics parked on a busy street"},
  {"startSec": 28.0, "endSec": 31.0, "prompt": "a close-up of fresh tacos being served from the food truck window"}
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

  // Contexto del TEMA real para ANCLAR las ilustraciones (no genéricas):
  //  - themeContext: lo que la IA vio en los recursos del cliente (llm-theme-context.js)
  //  - description: la descripción del proyecto (manifest.description)
  //  - script: el guión narrado (manifest.script)
  const themeLine = [opts.themeContext, opts.description].filter((x) => x && String(x).trim()).join('. ').slice(0, 600)
  const extraCtx = []
  if (opts.themeContext) extraCtx.push(`Lo que se VE en los recursos del cliente: ${String(opts.themeContext).slice(0, 400)}`)
  if (opts.description) extraCtx.push(`Descripción del proyecto: ${String(opts.description).slice(0, 400)}`)
  if (opts.script) extraCtx.push(`Guión narrado: ${String(opts.script).slice(0, 700)}`)
  const ctxBlock = extraCtx.length ? `CONTEXTO DEL TEMA (anclá TODAS las imágenes a esto):\n${extraCtx.join('\n')}\n\n` : ''

  const userMsg = `${ctxBlock}Duración total: ${totalDur.toFixed(1)}s. Máximo ${maxMoments} momentos.\n\nTranscript word-level:\n${transcript}`

  try {
    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: buildSystemPrompt(styleLabel, themeLine),
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
function buildScenesSystemPrompt(styleLabel, targetCount, themeLine) {
  const theme = themeLine && themeLine.trim()
    ? themeLine.trim()
    : 'el contenido/negocio del cliente (inferilo de la narración)'
  return `Sos director de arte de un video comercial 100% generado por IA (sin footage real).
EL VIDEO TRATA SOBRE: ${theme}.
Recibís la transcripción word-level (con timestamps) de la narración en off.
Tu trabajo: dividir la narración en EXACTAMENTE ${targetCount} ESCENAS visuales consecutivas que ILUSTREN lo que se dice, una tras otra, cubriendo el video de principio a fin SIN huecos.

Las imágenes se generarán en el estilo visual "${styleLabel}" — ese estilo se aplica AUTOMÁTICAMENTE después. Vos NO lo describís ni mencionás técnica/render/cámara/iluminación.

⛔ REGLA #1: cada escena DEBE estar DIRECTAMENTE relacionada con el TEMA REAL del video (lo de arriba) y con lo que la voz dice en ese tramo. PROHIBIDO inventar sujetos genéricos sin relación con el negocio/producto del cliente.

Reglas de cada escena:
1. UNA sola idea/sujeto claro por escena (un objeto, una persona, una acción, un concepto), SIEMPRE acorde al tema. MINIMALISTA — NO es una infografía: NADA de listas, múltiples elementos ni varios carteles de texto.
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
  // WS3 (2026-06-01): 'auto' ahora ES un estilo REAL en STYLES (look narrativo "respondele"),
  // ya no se intercepta a 'doodle'. normalizeStyle lo respeta como cualquier otro estilo.
  const visualStyle = normalizeStyle(opts.visualStyle)
  const styleLabel = (STYLES[visualStyle] || STYLES[DEFAULT_STYLE]).label
  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')

  // Contexto del tema para anclar las escenas (full-AI no tiene footage → usa
  // themeContext si vino + la descripción + el guión).
  const themeLine = [opts.themeContext, opts.description].filter((x) => x && String(x).trim()).join('. ').slice(0, 600)
  const extraCtx = []
  if (opts.themeContext) extraCtx.push(`Lo que se VE en los recursos: ${String(opts.themeContext).slice(0, 400)}`)
  if (opts.description) extraCtx.push(`Descripción del proyecto: ${String(opts.description).slice(0, 400)}`)
  if (opts.script) extraCtx.push(`Guión narrado: ${String(opts.script).slice(0, 700)}`)
  const ctxBlock = extraCtx.length ? `CONTEXTO DEL TEMA (anclá TODAS las escenas a esto):\n${extraCtx.join('\n')}\n\n` : ''

  const userMsg = `${ctxBlock}Duración total: ${totalDur.toFixed(1)}s. Generá EXACTAMENTE ${targetCount} escenas que cubran TODO el video en orden.\n\nTranscript word-level:\n${transcript}`

  try {
    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: buildScenesSystemPrompt(styleLabel, targetCount, themeLine),
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
