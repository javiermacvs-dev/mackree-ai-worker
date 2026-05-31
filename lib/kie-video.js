// Kie AI video generation wrapper — generate short cinematic clips from text.
//
// Model: bytedance/seedance-2 (Seedance 2.0 — validado con smoke test 2026-05-31)
// Slug de Kling 3.0 no disponible con esta API key; cambiar VIDEO_MODEL cuando
// se habilite (misma firma de API, solo cambia el slug y duración máx).
//
// Pattern: async. POST /api/v1/jobs/createTask → poll /jobs/recordInfo → resultUrls
// Same pattern as kie-image.js + kie-music.js.
//
// Uso en render.js: generateVideoClipsParallel(scenes, workDir, {apiKey, aspectRatio})
// Cada clip se guarda como media_NN.mp4 y entra al pipeline de renderCreate
// como media de tipo 'video' (ya manejado por findMediaItems + segment loop).

import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const KIE_BASE = 'https://api.kie.ai'
const POLL_INTERVAL_MS = 5_000         // 5 s entre polls (video es más lento)
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000  // 6 min timeout (Seedance ~1-3 min)

// Modelo principal. Para cambiar a Kling cuando esté disponible:
// export const VIDEO_MODEL = 'kuaishou/kling-3.0'
export const VIDEO_MODEL = 'bytedance/seedance-2'

// Duración máxima por clip (Seedance soporta hasta 15s; Kling hasta 15s también).
// Mantenemos 5-8s para que el render no exceda el timeout del worker.
const MAX_CLIP_SEC = 8
const MIN_CLIP_SEC = 4

/**
 * Generate a single cinematic video clip from a text prompt.
 * Returns { url, taskId } or null on failure (graceful).
 *
 * opts:
 *   apiKey      — fallback a process.env.KIE_AI_API_KEY
 *   aspectRatio — '9:16' (default) | '16:9' | '1:1'
 *   durationSec — segundos del clip (clamp a MIN-MAX)
 *   timeoutMs   — default 6 min
 */
export async function generateVideoClip(prompt, opts = {}) {
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY
  if (!apiKey) { console.warn('[kie-video] KIE_AI_API_KEY not set — skip'); return null }

  const duration = Math.max(MIN_CLIP_SEC, Math.min(MAX_CLIP_SEC, Math.round(opts.durationSec ?? 5)))
  const aspectRatio = opts.aspectRatio || '9:16'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Enriquecer el prompt para garantizar realismo cinematográfico
  const cinematicPrompt = `cinematic realistic footage, smooth professional camera movement, shallow depth of field, natural lighting. ${prompt}`

  let taskId
  try {
    const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VIDEO_MODEL,
        input: { prompt: cinematicPrompt, aspect_ratio: aspectRatio, duration },
        callBackUrl: 'https://example.com/_noop',
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (json.code !== 200 || !json.data?.taskId) {
      console.warn(`[kie-video] createTask failed: code=${json.code} msg=${json.msg}`)
      return null
    }
    taskId = json.data.taskId
  } catch (e) {
    console.warn('[kie-video] createTask error:', e?.message)
    return null
  }

  // Poll hasta success o timeout
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const res = await fetch(
        `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      )
      const json = await res.json().catch(() => ({}))
      if (json.code !== 200) { console.warn('[kie-video] poll error:', json.msg); return null }
      const { state } = json.data ?? {}
      if (state === 'success') {
        const rj = JSON.parse(json.data.resultJson ?? '{}')
        const url = rj.resultUrls?.[0]
        if (!url) { console.warn('[kie-video] no resultUrl'); return null }
        return { url, taskId }
      }
      if (state === 'fail') {
        console.warn('[kie-video] task failed:', json.data?.failCode, json.data?.failMsg)
        return null
      }
      // waiting / queuing / generating → seguir
    } catch (e) {
      console.warn('[kie-video] poll exception:', e?.message)
      return null
    }
  }
  console.warn('[kie-video] timeout after', Math.round(timeoutMs / 1000), 's')
  return null
}

/**
 * Generate multiple video clips in parallel and download them.
 * scenes: [{prompt, startSec, endSec, kind:'video'}]
 * Returns array of {index, clipPath, success} — failed clips have success:false.
 */
export async function generateVideoClipsParallel(scenes, workDir, opts = {}) {
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY
  const aspectRatio = opts.aspectRatio || '9:16'

  const results = await Promise.all(
    scenes.map(async (scene, i) => {
      const durationSec = Math.max(MIN_CLIP_SEC, Math.ceil((scene.endSec ?? 5) - (scene.startSec ?? 0)) + 1)
      console.log(`[kie-video] generating clip ${i + 1}/${scenes.length}: "${scene.prompt?.slice(0, 60)}" dur=${durationSec}s`)

      const result = await generateVideoClip(scene.prompt, { apiKey, aspectRatio, durationSec })
      if (!result) return { index: i, success: false }

      // Descargar el video al workdir
      const clipPath = path.join(workDir, `ai_video_${i}.mp4`)
      try {
        const res = await fetch(result.url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()))
        console.log(`[kie-video] clip ${i + 1} downloaded → ai_video_${i}.mp4`)
        return { index: i, clipPath, success: true }
      } catch (e) {
        console.warn(`[kie-video] download failed clip ${i + 1}:`, e?.message)
        return { index: i, success: false }
      }
    }),
  )
  return results
}
