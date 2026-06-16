// 4ª opción de Chixy — CLONACIÓN de la persona (talking-head / avatar).
// KIE AI "Kling AI Avatar": foto (retrato) + audio → video del cliente HABLANDO ese audio
// con lip-sync real (boca, parpadeo, micro-movimiento de cabeza), preservando su identidad.
//
// Patrón: async. POST /api/v1/jobs/createTask → poll /jobs/recordInfo → resultUrls.
// Mismo patrón que kie-video.js / kie-image.js (misma KIE_AI_API_KEY).
//
// Contrato (docs.kie.ai, validado con smoke test 2026-06-15):
//   model: 'kling/ai-avatar-standard' (720p, barato) | 'kling/ai-avatar-pro' (1080p)
//   input: { image_url, audio_url, prompt }  ← los 3 REQUERIDOS (prompt NO puede ir vacío)
//   image_url: jpeg/png público ≤10MB · audio_url: mp3/wav/aac/mp4/ogg público ≤100MB, ≤5min
// La salida sigue el aspecto de la imagen; el pipeline la re-encuadra a W×H (scale+crop).

const KIE_BASE = 'https://api.kie.ai'
const POLL_INTERVAL_MS = 6_000
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000 // avatar puede tardar varios minutos (audio largo)

export const AVATAR_MODEL_STANDARD = 'kling/ai-avatar-standard'
export const AVATAR_MODEL_PRO = 'kling/ai-avatar-pro'

// Prompt por defecto: el modelo lo EXIGE no-vacío; guía expresión/motion sin cambiar identidad.
const DEFAULT_AVATAR_PROMPT =
  'a person speaking naturally and confidently to the camera, friendly warm expression, subtle natural head movement and blinking, professional lighting'

/**
 * generateAvatarClip(imageUrl, audioUrl, opts?) → { url, taskId } | null
 *  - imageUrl / audioUrl: URLs PÚBLICAS (KIE las descarga; no acepta archivos crudos)
 *  - opts.apiKey   — fallback a process.env.KIE_AI_API_KEY
 *  - opts.model    — AVATAR_MODEL_STANDARD (default) | AVATAR_MODEL_PRO
 *  - opts.prompt   — guía de expresión (default sensato; nunca vacío)
 *  - opts.timeoutMs
 * Fallback TOTAL: devuelve null ante cualquier fallo (el caller cae al pipeline sin avatar).
 */
export async function generateAvatarClip(imageUrl, audioUrl, opts = {}) {
  const apiKey = opts.apiKey || process.env.KIE_AI_API_KEY
  if (!apiKey) { console.warn('[kie-avatar] KIE_AI_API_KEY not set — skip'); return null }
  if (!imageUrl || !audioUrl) { console.warn('[kie-avatar] missing image/audio URL — skip'); return null }

  const model = opts.model === AVATAR_MODEL_PRO ? AVATAR_MODEL_PRO : AVATAR_MODEL_STANDARD
  const prompt = (opts.prompt && String(opts.prompt).trim()) || DEFAULT_AVATAR_PROMPT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let taskId
  try {
    const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: { image_url: imageUrl, audio_url: audioUrl, prompt },
        callBackUrl: 'https://example.com/_noop',
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (json.code !== 200 || !json.data?.taskId) {
      console.warn(`[kie-avatar] createTask failed: code=${json.code} msg=${json.msg}`)
      return null
    }
    taskId = json.data.taskId
    console.log(`[kie-avatar] task ${taskId} (${model})`)
  } catch (e) {
    console.warn('[kie-avatar] createTask error:', e?.message)
    return null
  }

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const res = await fetch(
        `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      )
      const json = await res.json().catch(() => ({}))
      if (json.code !== 200) { console.warn('[kie-avatar] poll error:', json.msg); return null }
      const { state } = json.data ?? {}
      if (state === 'success') {
        const rj = JSON.parse(json.data.resultJson ?? '{}')
        const url = rj.resultUrls?.[0]
        if (!url) { console.warn('[kie-avatar] no resultUrl'); return null }
        console.log(`[kie-avatar] success in ${Math.round((Date.now() - start) / 1000)}s`)
        return { url, taskId }
      }
      if (state === 'fail') {
        console.warn('[kie-avatar] task failed:', json.data?.failCode, json.data?.failMsg)
        return null
      }
      // waiting / queuing / generating → seguir
    } catch (e) {
      console.warn('[kie-avatar] poll exception:', e?.message)
      return null
    }
  }
  console.warn('[kie-avatar] timeout after', Math.round(timeoutMs / 1000), 's')
  return null
}
