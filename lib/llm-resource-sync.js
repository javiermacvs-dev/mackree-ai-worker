// Sincronización de recursos con la narración (UNIVERSAL — todas las empresas).
//
// Problema: en create mode los recursos del cliente (fotos/clips) se colocaban en
// ORDEN DE SUBIDA, sin relación con lo que dice la voz en off. Queremos que cada
// recurso caiga donde la narración habla de algo relacionado ("que la imagen
// concuerde con lo que se está diciendo").
//
// Cómo: la IA MIRA cada recurso (imagen directa, o un frame del video) y, junto
// con el GUIÓN (que ya está en orden temporal), decide la mejor PERMUTACIÓN de
// los recursos. El video divide la narración en N tramos iguales; asignamos a
// cada tramo el recurso que mejor concuerde.
//
// Filosofía del producto: esto es CALIDAD/edición → inamovible backend, sin toggle
// para el cliente. Fallback TOTAL: si la IA no está disponible, falla, o no
// devuelve una permutación válida → null → el caller usa el orden original (cero
// regresión). Opt-out técnico: manifest.resourceSync === 'off'.
//
// Costo: ~$0.01 por render (Haiku 4.5, N imágenes pequeñas + guión).

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

// Imagen representativa de un recurso, SIEMPRE reescalada a 512px (imagen o frame de video).
// ⚠️ fix 2026-06-03: antes las imágenes se mandaban a tamaño completo (varios MB) → con
// varias, la API de visión devolvía HTTP 413 (request_too_large) y el reordenamiento caía
// al orden original. Ahora también las imágenes se reescalan con ffmpeg (≈50-80KB c/u).
async function representativeJpeg(item, workDir, i) {
  const ext = (item.name || item.filePath || '').split('.').pop()?.toLowerCase() ?? ''
  const isVideo = item.type === 'video' || VIDEO_EXTS.includes(ext)
  const out = path.join(workDir, `rsync_${i}.jpg`)
  const src = isVideo ? `-ss 1 -i "${fwd(item.filePath)}" -frames:v 1` : `-i "${fwd(item.filePath)}"`
  try {
    await execAsync(`ffmpeg -y ${src} -vf "scale=512:-1" -q:v 5 "${fwd(out)}"`, { timeout: 20000 })
    return await readFile(out)
  } catch {
    return null
  }
}

/**
 * orderResourcesByNarration(mediaItems, script, anthropicKey, workDir) → number[] | null
 *  - mediaItems: [{ filePath, type, name }] en orden de subida
 *  - script: guión de la narración (manifest.script), en orden temporal
 *  - anthropicKey: ANTHROPIC_API_KEY del worker
 *  - workDir: dir de trabajo (para frames temporales)
 * Devuelve una PERMUTACIÓN de índices [0..n-1] (qué recurso va en el tramo 1, 2, …)
 * o null si no se puede / no conviene reordenar (→ el caller usa el orden original).
 */
export async function orderResourcesByNarration(mediaItems, script, anthropicKey, workDir) {
  try {
    if (!anthropicKey) { console.warn('[resource-sync] no ANTHROPIC_API_KEY — skip'); return null }
    if (!Array.isArray(mediaItems) || mediaItems.length < 2) return null // nada que reordenar
    if (!script || typeof script !== 'string' || script.trim().length < 25) {
      console.warn('[resource-sync] guión muy corto o ausente — skip'); return null
    }

    const n = mediaItems.length

    // 1. Imagen representativa (base64) por recurso. Si alguno no se puede leer,
    //    abortamos y dejamos el orden original (no reordenar a ciegas).
    const imageBlocks = []
    for (let i = 0; i < n; i++) {
      const buf = await representativeJpeg(mediaItems[i], workDir, i)
      if (!buf) { console.warn(`[resource-sync] no pude leer recurso #${i} — skip`); return null }
      imageBlocks.push({ type: 'text', text: `Recurso #${i}:` })
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
      })
    }

    const system = `Sos editor de video profesional. Te paso ${n} recursos visuales numerados (#0 a #${n - 1}) y el GUIÓN de la narración en off (ya en orden temporal). El video reparte la narración en ${n} tramos iguales en el tiempo (tramo 1 = primer trozo de lo que se dice, …, tramo ${n} = el cierre).
Tu tarea: asignar a CADA tramo el recurso que MEJOR concuerde con lo que se dice en ese momento (que la imagen muestre lo que la voz menciona).
Reglas:
- Es una PERMUTACIÓN: usá cada recurso EXACTAMENTE una vez.
- El recurso que muestre el RESULTADO final/terminado va cerca del cierre (último tramo).
- El que muestre inicio/proceso/materiales va antes.
- Si la relación no es clara, mantené un orden natural y prolijo.
OUTPUT: SOLO un array JSON de ${n} enteros (la permutación), por ejemplo [2,0,1]. Sin texto extra, sin markdown. La posición del array = el tramo; el valor = el número de recurso que va ahí.`

    const userContent = [
      { type: 'text', text: `GUIÓN (narración en off, en orden):\n"""${script.trim().slice(0, 2500)}"""\n\nRecursos (en orden de subida, NO necesariamente el orden final):` },
      ...imageBlocks,
      { type: 'text', text: `Devolvé SOLO la permutación de ${n} enteros (posición = tramo 1..${n}; valor = #recurso). Ejemplo para ${n} recursos: ${JSON.stringify(Array.from({ length: n }, (_, k) => k))}.` },
    ]

    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : ''
    const m = text.match(/\[[\s\S]*?\]/)
    if (!m) { console.warn('[resource-sync] sin array en la respuesta — skip'); return null }

    let arr
    try { arr = JSON.parse(m[0]) } catch { console.warn('[resource-sync] JSON inválido — skip'); return null }

    // Validar que sea una permutación exacta de 0..n-1.
    if (!Array.isArray(arr) || arr.length !== n) return null
    const seen = new Set()
    for (const x of arr) {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= n || seen.has(x)) {
        console.warn('[resource-sync] no es permutación válida — skip'); return null
      }
      seen.add(x)
    }

    // Si la IA devuelve el orden idéntico, igual sirve (no cambia nada).
    console.log(`[resource-sync] orden por narración: [${arr.join(',')}] (original: [${Array.from({ length: n }, (_, k) => k).join(',')}])`)
    return arr
  } catch (e) {
    console.warn(`[resource-sync] failed: ${e?.message ?? e}`)
    return null
  }
}
