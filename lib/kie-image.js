// Kie AI nano-banana-2 wrapper — generate images from text prompt.
//
// Doc: https://docs.kie.ai/market/google/nanobanana2 + /market/common/get-task-detail
// Pattern: async. POST /api/v1/jobs/createTask → poll /jobs/recordInfo → resultUrls
//
// Por qué nano-banana-2 (Gemini 3.1 Flash) vs nano-banana clásico:
//  - Soporta 4K nativo (vs 1K del clásico)
//  - Aspect ratios extra incluido 9:16 (clave para Reels verticales)
//  - Prompts hasta 20k chars (vs 5k)
//  - Acepta image_input para image-to-image en el futuro
//
// Status: módulo creado 2026-05-18. NO integrado a render.js todavía — la
// decisión de DÓNDE insertar las imágenes IA (manual via manifest vs auto-detect
// con LLM analizando el transcript) se discute en próxima sesión.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stylePromptBase, DEFAULT_STYLE } from './styles.js'

const KIE_BASE = 'https://api.kie.ai'
const POLL_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000 // 2 min — imágenes son más rápidas que música

/**
 * Generate an image from a prompt via Kie nano-banana-2.
 * Returns { url, allUrls, taskId } when ready, throws on timeout/failure.
 *
 * opts:
 *   apiKey       — fallback a process.env.KIE_AI_API_KEY
 *   model        — 'nano-banana-2' (default) | 'google/nano-banana' | 'google/nano-banana-edit'
 *   aspectRatio  — '9:16' (default, vertical Reels) | '16:9' | '1:1' | etc.
 *   resolution   — '1K' (default, rápido) | '2K' | '4K'
 *   outputFormat — 'jpg' (default) | 'png'
 *   imageInput   — array de URLs para image-to-image (solo nano-banana-2)
 *   callBackUrl  — opcional, default noop placeholder
 *   timeoutMs    — default 2 min
 */
export async function generateImageFromPrompt(prompt, opts = {}) {
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY
  if (!apiKey) throw new Error('KIE_AI_API_KEY not configured')

  const model = opts.model || 'nano-banana-2'
  const input = {
    prompt,
    aspect_ratio: opts.aspectRatio || '9:16',
    resolution: opts.resolution || '1K',
    output_format: opts.outputFormat || 'jpg',
  }
  if (Array.isArray(opts.imageInput) && opts.imageInput.length) {
    input.image_input = opts.imageInput
  }
  const callBackUrl = opts.callBackUrl || 'https://worker-mackree-ai.kqlrkv.easypanel.host/_noop'
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS

  // 1. Create task
  const createRes = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input, callBackUrl }),
  })
  const createJson = await createRes.json().catch(() => ({}))
  if (createJson.code !== 200 || !createJson.data?.taskId) {
    throw new Error(`Kie create-image failed: code=${createJson.code} msg=${createJson.msg}`)
  }
  const taskId = createJson.data.taskId
  console.log(
    `[kie-image] task created: ${taskId} (model=${model}, ratio=${input.aspect_ratio}, res=${input.resolution})`,
  )

  // 2. Poll status
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    const statusRes = await fetch(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    const statusJson = await statusRes.json().catch(() => ({}))
    if (statusJson.code !== 200) {
      throw new Error(`Kie image status-poll failed: code=${statusJson.code} msg=${statusJson.msg}`)
    }

    const state = statusJson.data?.state
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    console.log(`[kie-image] task ${taskId} state=${state} t+${elapsed}s`)

    if (state === 'success') {
      // resultJson es STRING stringificado — hay que parsearlo
      const resultJsonStr = statusJson.data?.resultJson
      if (!resultJsonStr) throw new Error('Kie returned success but no resultJson')
      let parsed
      try {
        parsed = JSON.parse(resultJsonStr)
      } catch (e) {
        throw new Error(`Kie resultJson not valid JSON: ${e?.message}`)
      }
      const urls = parsed.resultUrls || []
      if (!urls.length) throw new Error('Kie resultJson has no resultUrls')
      return { url: urls[0], allUrls: urls, taskId }
    }

    if (state === 'fail') {
      const failCode = statusJson.data?.failCode || 'unknown'
      const failMsg = statusJson.data?.failMsg || 'no message'
      throw new Error(`Kie image generation failed: ${failCode} - ${failMsg}`)
    }
    // waiting | queuing | generating → seguir polling
  }

  throw new Error(`Kie image generation timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/**
 * Download a generated image from Kie's signed URL to a local path.
 * Files retained for 14 days en Kie según docs.
 */
export async function downloadImageTo(imageUrl, localPath) {
  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(localPath, buf)
  return localPath
}

/**
 * Directiva de orientación para el prompt, derivada del aspect ratio de destino.
 * Garantiza que la ilustración se genere DERECHA (nunca rotada 90°) acorde al
 * lienzo del video. Fix 2026-05-24: con prompts que decían "horizontal composition"
 * y aspect_ratio vertical 9:16, nano-banana acostaba el contenido (texto de lado).
 */
function orientationDirective(ar = '9:16') {
  const a = String(ar)
  if (a.startsWith('16:9')) return 'horizontal landscape composition, full-frame, content upright'
  if (a.startsWith('1:1')) return 'square composition, full-frame, centered, content upright'
  // default y 9:16 → vertical (Reels)
  return 'vertical portrait composition, full-frame, content upright and readable, NEVER rotated sideways, no 90-degree rotation, simple uncluttered layout with ONE focal subject and generous empty space'
}

/**
 * Generar N imágenes en PARALELO desde un array de "moments" detectados por LLM.
 * Cada moment = {startSec, endSec, prompt}.
 * Devuelve [{...moment, imagePath, success}, ...] con success=true si bajó OK.
 * Tolerante a fallos individuales: si una imagen falla, marca success=false y sigue.
 */
export async function generateImagesForMomentsParallel(moments, workDir, opts = {}) {
  if (!Array.isArray(moments) || moments.length === 0) return []
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY

  // Estilo visual elegido por el cliente (manifest.visualStyle). El LLM devuelve
  // SOLO el sujeto/escena; acá le prependemos el prompt_base del estilo (doodle,
  // whiteboard, flat, isometric, claymation, watercolor). Default 'doodle'.
  const visualStyle = opts.visualStyle || DEFAULT_STYLE
  const styleBase = stylePromptBase(visualStyle)

  // Orientación del lienzo de destino (vertical/cuadrada/horizontal). Los
  // prompt_base ya NO fijan orientación (ver styles.js) — la inyectamos acá para
  // que la imagen NUNCA salga rotada respecto al video. Fix 2026-05-24.
  const aspectRatio = opts.aspectRatio || '9:16'
  const orient = orientationDirective(aspectRatio)

  const tasks = moments.map((m, i) =>
    (async () => {
      try {
        const styledPrompt = `${styleBase}, ${orient}. Subject: ${m.prompt}`
        const { url } = await generateImageFromPrompt(styledPrompt, {
          apiKey,
          aspectRatio,
          resolution: opts.resolution || '1K',
          outputFormat: 'jpg',
          timeoutMs: opts.timeoutMs,
        })
        const imagePath = path.join(workDir, `ai_image_${i}.jpg`)
        await downloadImageTo(url, imagePath)
        console.log(`[kie-image] moment ${i} OK → ${path.basename(imagePath)}`)
        return { ...m, imagePath, success: true }
      } catch (e) {
        console.warn(`[kie-image] moment ${i} FAILED (continuing without): ${e?.message ?? e}`)
        return { ...m, imagePath: null, success: false }
      }
    })(),
  )

  return Promise.all(tasks)
}
