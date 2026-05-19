// Kie AI Suno wrapper — generate background music from a text prompt.
//
// Doc: https://docs.kie.ai/suno-api/generate-music + /get-music-details
// Pattern: async. POST /api/v1/generate → taskId → poll /record-info → audioUrl
//
// Why Kie Suno (decided 2026-05-18 with Javier):
//  - 1 API key consolidates music + future image generation (nano-banana)
//  - Suno V5 has top quality + no 8-min cap like V4_5
//  - Always instrumental for our case (voice mix on top would clash with lyrics)

import { writeFile } from 'node:fs/promises'

const KIE_BASE = 'https://api.kie.ai'
const POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 min — Suno can take 30-120s typical

/**
 * Generate background music from a prompt via Kie Suno.
 * Returns { audioUrl, duration, title } when ready, throws on timeout/failure.
 *
 * opts:
 *   apiKey       — fallback to process.env.KIE_AI_API_KEY
 *   model        — V4 | V4_5 | V4_5PLUS | V4_5ALL | V5 | V5_5  (default V5)
 *   instrumental — boolean (default true)
 *   callBackUrl  — optional webhook (default uses noop https placeholder)
 *   timeoutMs    — default 5 min
 */
export async function generateMusicFromPrompt(prompt, opts = {}) {
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY
  if (!apiKey) throw new Error('KIE_AI_API_KEY not configured')

  const model = opts.model || 'V5'
  const instrumental = opts.instrumental !== false
  // Kie requires callBackUrl but the polling path works fine without an active webhook.
  const callBackUrl = opts.callBackUrl || 'https://worker-mackree-ai.kqlrkv.easypanel.host/_noop'
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS

  // 1. Create task
  const createRes = await fetch(`${KIE_BASE}/api/v1/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, customMode: false, instrumental, model, callBackUrl }),
  })
  const createJson = await createRes.json().catch(() => ({}))
  if (createJson.code !== 200 || !createJson.data?.taskId) {
    throw new Error(`Kie create-music failed: code=${createJson.code} msg=${createJson.msg}`)
  }
  const taskId = createJson.data.taskId
  console.log(`[kie-music] task created: ${taskId} (model=${model}, instrumental=${instrumental})`)

  // 2. Poll status
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    const statusRes = await fetch(
      `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    const statusJson = await statusRes.json().catch(() => ({}))
    if (statusJson.code !== 200) {
      throw new Error(`Kie status-poll failed: code=${statusJson.code} msg=${statusJson.msg}`)
    }

    const status = statusJson.data?.status
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    console.log(`[kie-music] task ${taskId} status=${status} t+${elapsed}s`)

    if (status === 'SUCCESS') {
      const sunoData = statusJson.data?.response?.sunoData
      if (!Array.isArray(sunoData) || !sunoData.length || !sunoData[0].audioUrl) {
        throw new Error('Kie returned SUCCESS but no sunoData[0].audioUrl')
      }
      return {
        audioUrl: sunoData[0].audioUrl,
        duration: sunoData[0].duration,
        title: sunoData[0].title,
        taskId,
      }
    }

    if (
      [
        'CREATE_TASK_FAILED',
        'GENERATE_AUDIO_FAILED',
        'CALLBACK_EXCEPTION',
        'SENSITIVE_WORD_ERROR',
      ].includes(status)
    ) {
      const errMsg = statusJson.data?.errorMessage || 'no message'
      throw new Error(`Kie music generation failed: ${status} - ${errMsg}`)
    }
    // PENDING | TEXT_SUCCESS | FIRST_SUCCESS → keep polling
  }

  throw new Error(`Kie music generation timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/**
 * Download a generated music MP3 from Kie's signed URL to a local path.
 */
export async function downloadMusicTo(audioUrl, localPath) {
  const res = await fetch(audioUrl)
  if (!res.ok) throw new Error(`Music download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(localPath, buf)
  return localPath
}

/**
 * Build a music prompt from the job manifest. Heuristic, not an LLM call.
 *
 *  - manifest.music: dashboard preference ('urban', 'acoustic', 'instrumental', 'cinematic', etc.)
 *  - manifest.style: 'commercial' | 'personal'
 *  - manifest.description: free-text brief of the video
 *
 * Builds a short prompt aimed at Kie Suno. Keep under 500 chars (non-custom mode).
 */
export function buildMusicPromptFromManifest(manifest) {
  const music = (manifest?.music || '').toLowerCase().trim()
  const style = (manifest?.style || 'commercial').toLowerCase()
  const desc = (manifest?.description || '').slice(0, 200).trim()

  const base =
    music && music !== 'none'
      ? music
      : style === 'commercial'
        ? 'energetic urban'
        : 'soft ambient'

  const mood =
    style === 'commercial'
      ? 'instrumental background for commercial wrap reveal video, modern punchy beat, no vocals'
      : 'instrumental background for personal emotional video, gentle atmosphere, no vocals'

  // Description as context, truncated. Helps Kie match the vibe.
  const context = desc ? ` — context: ${desc}` : ''

  return `${base} ${mood}${context}`.slice(0, 500)
}
