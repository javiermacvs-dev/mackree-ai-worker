// Contexto de TEMA del video a partir de los RECURSOS reales del cliente.
//
// Problema (reportado por Javier 2026-06-03): las ilustraciones IA del cuerpo del
// video salían GENÉRICAS, sin relación con lo que se está editando (ej. un video de
// un FOOD TRUCK y las imágenes eran dibujos genéricos). Causa: el detector de
// momentos (llm-moments.js) NO recibía nada sobre el tema/recursos y su prompt
// asumía siempre "vehicular wraps".
//
// Solución: la IA MIRA los recursos del cliente (un frame de cada video, o la imagen
// tal cual) + la descripción y devuelve una frase corta con el TEMA REAL ("a red food
// truck with taco graphics"). Ese contexto se inyecta en el detector de momentos para
// que cada ilustración esté ANCLADA al tema, nunca inventada.
//
// Reusa el patrón de visión de llm-resource-sync.js (representativeJpeg + Haiku Vision).
// Filosofía del producto: calidad/edición → inamovible backend, sin toggle.
// Fallback TOTAL: si falta key, no hay recursos, o falla → null (el caller cae al
// comportamiento anterior, basado solo en la descripción/guión). Costo: ~$0.01/render.

// Respaldo OpenAI: Anthropic sin saldo dejaba este modulo mudo (2026-08-31).
// LLMClient es drop-in de Anthropic — misma interfaz .messages.create().
import { LLMClient } from './llm-fallback.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)
const fwd = (p) => p.replace(/\\/g, '/')
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v']

// Imagen representativa de un recurso, SIEMPRE reescalada a 512px de ancho.
// ⚠️ CRÍTICO (fix 2026-06-03): las imágenes del cliente pueden ser de varios MB; mandarlas
// a tamaño completo satura la API de visión (HTTP 413 request_too_large) → el tema sale
// null → las ilustraciones caen a genérico. Por eso TAMBIÉN las imágenes se reescalan con
// ffmpeg (antes solo los videos). 512px JPEG q5 ≈ 50-80KB → la request nunca excede el límite.
async function representativeJpeg(item, workDir, i) {
  const ext = (item.name || item.filePath || '').split('.').pop()?.toLowerCase() ?? ''
  const isVideo = item.type === 'video' || VIDEO_EXTS.includes(ext)
  const out = path.join(workDir, `theme_${i}.jpg`)
  const src = isVideo ? `-ss 1 -i "${fwd(item.filePath)}" -frames:v 1` : `-i "${fwd(item.filePath)}"`
  try {
    await execAsync(`ffmpeg -y ${src} -vf "scale=512:-1" -q:v 5 "${fwd(out)}"`, { timeout: 20000 })
    return await readFile(out)
  } catch {
    return null
  }
}

/**
 * describeTheme(mediaItems, description, anthropicKey, workDir) → string | null
 *  - mediaItems: [{ filePath, type, name }] (footage/fotos del cliente)
 *  - description: manifest.description (texto del proyecto)
 *  - anthropicKey: ANTHROPIC_API_KEY del worker
 *  - workDir: dir de trabajo (frames temporales)
 * Devuelve una frase corta (EN INGLÉS) con el tema/sujeto real visible en los recursos
 * (ej. "a red food truck with taco graphics, close-ups of the vinyl wrap"), o null si
 * no se puede (→ el caller usa solo la descripción/guión). Cap 6 recursos.
 */
export async function describeTheme(mediaItems, description, anthropicKey, workDir) {
  try {
    if (!anthropicKey) { console.warn('[theme-context] no ANTHROPIC_API_KEY — skip'); return null }
    const items = Array.isArray(mediaItems) ? mediaItems.slice(0, 6) : []
    if (items.length === 0) return null

    const imageBlocks = []
    for (let i = 0; i < items.length; i++) {
      const buf = await representativeJpeg(items[i], workDir, i)
      if (buf) {
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
        })
      }
    }
    if (imageBlocks.length === 0) return null

    const system = `You analyze the visual content of a business/product video. You get frames from the user's actual footage/photos plus the project description. Describe the REAL subject of the video in 1-2 short factual sentences (English). Name the concrete thing(s) you actually see — e.g. "a red food truck with taco graphics and a serving window", "a wrapped white cargo van", "a coffee shop interior with a barista". This is used to keep supporting illustrations strictly ON-TOPIC. Be specific and factual; do NOT invent anything not visible. Output ONLY the description, no preamble.`

    const userContent = [
      { type: 'text', text: `Project description: """${(description || '').slice(0, 600)}"""\n\nFrames from the actual resources:` },
      ...imageBlocks,
    ]

    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system,
      messages: [{ role: 'user', content: userContent }],
    })
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    if (text.length < 4) return null
    console.log(`[theme-context] tema detectado: ${text.slice(0, 180)}`)
    return text
  } catch (e) {
    console.warn(`[theme-context] failed: ${e?.message ?? e}`)
    return null
  }
}
