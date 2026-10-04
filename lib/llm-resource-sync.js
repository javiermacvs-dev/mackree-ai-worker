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

// ════════════════════════════════════════════════════════════════════════════
// v88 (Javier 2026-10-04) — ANCLAJE de cada recurso a la FRASE de la narración
// ════════════════════════════════════════════════════════════════════════════
// Reporte: "hay pedazos sin coherencia — si está hablando de la cabina que salga
// la cabina, si habla del dumpster que salga el dumpster". La permutación de
// arriba solo ORDENA y reparte el tiempo en tramos fijos: el recurso n.º k cae
// en el tramo k aunque la voz hable de él mucho antes o después. Acá la IA
// asigna cada recurso a la FRASE del guion donde debe empezar a verse, y el
// caller convierte esas frases en segundos reales con el transcript (words de
// Whisper). Además usa las ETIQUETAS que escribió el cliente ("Dumpster antes",
// "Camión después - video resultado final") como verdad sobre qué muestra cada
// archivo — antes se ignoraban.

/** Parte el guion en frases (por . ! ? y saltos de línea). */
export function splitScriptSentences(script) {
  return String(script || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
}

/**
 * Segundo de inicio de cada frase, alineando el conteo de palabras del guion con
 * las words de Whisper (proporcional — tolera pequeñas diferencias de conteo).
 */
export function sentenceStartTimes(sentences, words, voiceDur) {
  const counts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length)
  const total = counts.reduce((a, b) => a + b, 0) || 1
  const nw = Array.isArray(words) ? words.length : 0
  let cum = 0
  return counts.map((c) => {
    const frac = cum / total
    cum += c
    if (nw > 0) {
      const wi = Math.min(nw - 1, Math.round(frac * nw))
      return Math.max(0, Number(words[wi]?.start) || 0)
    }
    return frac * voiceDur
  })
}

/**
 * planResourcesByNarration(mediaItems, script, key, workDir, { labels, words, voiceDur })
 *   → { order: number[], startSec: number[] } | null
 * order = índices de mediaItems en el orden en que aparecen; startSec = segundo de
 * la narración donde cada uno empieza (creciente, el primero en 0).
 * null → el caller usa el comportamiento previo (permutación + reparto ponderado).
 */
export async function planResourcesByNarration(mediaItems, script, anthropicKey, workDir, { labels = [], words = [], voiceDur = 0 } = {}) {
  try {
    if (!anthropicKey) return null
    if (!Array.isArray(mediaItems) || mediaItems.length < 2 || !(voiceDur > 0)) return null
    const sentences = splitScriptSentences(script)
    if (sentences.length < 2) return null
    const n = mediaItems.length
    const starts = sentenceStartTimes(sentences, words, voiceDur)

    const blocks = []
    for (let i = 0; i < n; i++) {
      const buf = await representativeJpeg(mediaItems[i], workDir, `plan_${i}`)
      if (!buf) { console.warn(`[resource-plan] no pude leer recurso #${i} — skip`); return null }
      const lab = String(labels?.[i]?.label || '').trim()
      const kind = mediaItems[i].type === 'video' ? 'VIDEO' : 'FOTO'
      blocks.push({ type: 'text', text: `Recurso #${i} (${kind})${lab ? ` — etiqueta del cliente: "${lab}"` : ' — sin etiqueta'}:` })
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } })
    }

    const numbered = sentences.map((s, k) => `F${k}: ${s}`).join('\n')
    const system = `Sos editor de video profesional. Tenés el GUIÓN de una narración en off partido en frases numeradas (F0…F${sentences.length - 1}, en orden temporal) y ${n} recursos visuales del cliente (#0…#${n - 1}).
Tu tarea: decidir EN QUÉ FRASE empieza a verse cada recurso, para que la imagen muestre LO QUE LA VOZ ESTÁ DICIENDO en ese momento.
Reglas:
- La ETIQUETA del cliente es la verdad sobre qué muestra el recurso (antes/después, camión/dumpster, cabina, etc.). Si no hay etiqueta, mirá la imagen.
- Si la voz habla de X, tiene que verse X: el camión cuando habla del camión, el dumpster cuando habla del dumpster, el "antes" cuando habla de cómo estaba, el "después"/resultado cuando habla del resultado o el reveal.
- Usá CADA recurso exactamente una vez. Varios recursos pueden empezar en la misma frase (se reparten ese tramo).
- Si hay un VIDEO del resultado final, ponelo como ÚLTIMO recurso: empieza en la frase del reveal/resultado y sigue durante el cierre. Las fotos del "después" van ANTES de ese video, cuando la voz empieza a hablar del resultado.
- Si una frase habla de algo que ningún recurso muestra, no le asignes nada (sigue viéndose el recurso anterior).
- Si el guion ABRE mencionando el resultado (gancho: "mirá cómo quedó…"), usá ahí 1-3 fotos del después; después volvé al "antes".
- Repartí: evitá amontonar muchas fotos en UNA sola frase si hay otras frases que también hablan de lo mismo (ej. varias frases sobre el resultado → repartí las fotos del después entre ellas).
- Mantené una progresión lógica (antes → resultado).
OUTPUT: SOLO un array JSON de objetos {"r": númeroDeRecurso, "f": númeroDeFrase}, uno por recurso, sin texto extra ni markdown.`

    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `GUIÓN por frases:\n${numbered.slice(0, 4000)}\n\nRecursos:` },
        ...blocks,
        { type: 'text', text: `Devolvé SOLO el array JSON con ${n} objetos {"r","f"}.` },
      ] }],
    })
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : ''
    const a = text.indexOf('['), b = text.lastIndexOf(']')
    if (a < 0 || b <= a) { console.warn('[resource-plan] sin array — skip'); return null }
    let arr
    try { arr = JSON.parse(text.slice(a, b + 1)) } catch { console.warn('[resource-plan] JSON inválido — skip'); return null }
    if (!Array.isArray(arr) || arr.length !== n) { console.warn('[resource-plan] largo inválido — skip'); return null }
    const seen = new Set()
    const items = []
    for (let k = 0; k < arr.length; k++) {
      const r = Number(arr[k]?.r), f = Number(arr[k]?.f)
      if (!Number.isInteger(r) || r < 0 || r >= n || seen.has(r)) { console.warn('[resource-plan] recurso inválido — skip'); return null }
      if (!Number.isInteger(f)) { console.warn('[resource-plan] frase inválida — skip'); return null }
      seen.add(r)
      items.push({ r, f: Math.min(sentences.length - 1, Math.max(0, f)), k })
    }
    items.sort((x, y) => x.f - y.f || x.k - y.k)

    // Regla dura: el VIDEO que el cliente etiquetó como resultado final cierra el
    // video (la IA a veces le deja fotos después). Se mueve al final.
    const finalIdx = items.findIndex((x) => mediaItems[x.r].type === 'video' && /final|resultado|result|reveal|terminad/i.test(String(labels?.[x.r]?.label || '')))
    if (finalIdx >= 0 && finalIdx < items.length - 1) {
      const [fin] = items.splice(finalIdx, 1)
      fin.f = Math.max(fin.f, items[items.length - 1].f)
      items.push(fin)
    }

    // Segundos de inicio: los que comparten frase se reparten su tramo.
    const startSec = []
    for (let i = 0; i < items.length; ) {
      let j = i
      while (j < items.length && items[j].f === items[i].f) j++
      const s0 = starts[items[i].f]
      const s1 = j < items.length ? starts[items[j].f] : voiceDur
      const span = Math.max(0, s1 - s0)
      for (let t = i; t < j; t++) startSec.push(s0 + (span * (t - i)) / (j - i))
      i = j
    }
    startSec[0] = 0
    for (let i = 1; i < startSec.length; i++) startSec[i] = Math.max(startSec[i], startSec[i - 1])
    const order = items.map((x) => x.r)
    console.log(`[resource-plan] ${items.map((x, i) => `#${x.r}@F${x.f}(${startSec[i].toFixed(1)}s)`).join(' ')}`)
    return { order, startSec }
  } catch (e) {
    console.warn(`[resource-plan] failed: ${e?.message ?? e}`)
    return null
  }
}

/**
 * Convierte inicios anclados en duraciones respetando mínimos/máximos por recurso
 * (redistribuye lo que sobra/falta entre los que tienen holgura). Suma = total.
 */
export function anchoredDurations(startSec, total, mins, maxs) {
  const n = startSec.length
  if (n === 1) return [total]
  // Si los mínimos no entran se escalan; si los máximos no alcanzan, se estiran.
  const sumMin = mins.reduce((a, b) => a + b, 0)
  const lo = sumMin > total ? mins.map((m) => (m * total) / sumMin) : mins.slice()
  let hi = maxs.map((m, i) => Math.max(lo[i], m))
  const sumMax = hi.reduce((a, b) => a + b, 0)
  if (sumMax < total) hi = hi.map((h) => (h * total) / sumMax)
  // Buscamos inicios s[i] lo MÁS CERCA posible de los anclajes (la frase donde la
  // voz menciona cada recurso) respetando lo/hi por recurso. Alternamos: tirar
  // hacia el anclaje → proyectar a lo factible (pasada hacia adelante desde 0 y
  // hacia atrás desde el total). Así un clip largo empuja solo a sus vecinos,
  // no corre todas las fotos del video.
  const a = startSec.map((x, i) => (i === 0 ? 0 : Math.min(total, Math.max(0, x))))
  let s = a.slice()
  const project = () => {
    for (let k = 0; k < 60; k++) {
      s[0] = 0
      for (let i = 0; i < n - 1; i++) s[i + 1] = Math.min(s[i] + hi[i], Math.max(s[i] + lo[i], s[i + 1]))
      let next = total
      for (let i = n - 1; i >= 1; i--) { s[i] = Math.min(next - lo[i], Math.max(next - hi[i], s[i])); next = s[i] }
      if (Math.abs(s[0]) < 1e-4) break
    }
    s[0] = 0
  }
  project()
  for (let it = 0; it < 200; it++) {
    s = s.map((x, i) => x + 0.3 * (a[i] - x))
    project()
  }
  const d = s.map((x, i) => Math.max(0.01, (i + 1 < n ? s[i + 1] : total) - x))
  const sum = d.reduce((x, y) => x + y, 0) || 1
  return d.map((x) => (x * total) / sum)
}
