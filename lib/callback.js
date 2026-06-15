// Notify the Vercel app when a render finishes (or fails).
// The Vercel endpoint expects the same WORKER_SECRET in the Authorization
// header so it knows the request is genuine.

const CALLBACK_URL = process.env.CALLBACK_URL
const WORKER_SECRET = process.env.WORKER_SECRET

export async function postCallback({ jobId, userId, status, videoUrl, thumbnailUrl, coverUrl, coverTitle, stats, error }) {
  if (!CALLBACK_URL) {
    console.warn('[callback] CALLBACK_URL not set, skipping')
    return
  }
  const body = JSON.stringify({ jobId, userId, status, videoUrl, thumbnailUrl, coverUrl, coverTitle, stats, error })
  try {
    const res = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WORKER_SECRET ?? ''}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.error(`[callback] ${res.status}: ${txt.slice(0, 200)}`)
    }
  } catch (err) {
    console.error('[callback] fetch failed:', err?.message ?? err)
  }
}
