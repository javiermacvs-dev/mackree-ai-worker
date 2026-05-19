// MackreeAI render worker — Express server that wraps FFmpeg.
// Receives signed render requests from the Vercel app, pulls assets from
// Supabase Storage, runs the pipeline, uploads the output, and posts back.

import express from 'express'
import morgan from 'morgan'
import { rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { downloadJobAssets, uploadOutput, uploadThumbnail, readJobManifest } from './lib/storage.js'
import { renderJob } from './lib/render.js'
import { postCallback } from './lib/callback.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const PORT = parseInt(process.env.PORT ?? '8080', 10)
const WORKER_SECRET = process.env.WORKER_SECRET
const WORKDIR_ROOT = process.env.RENDER_WORKDIR ?? '/tmp/render-jobs'
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''

if (!WORKER_SECRET) {
  console.error('FATAL: WORKER_SECRET is required')
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(morgan('combined'))

// Health probe for Easypanel — `version` lets us confirm a new deploy is live.
const BUILD_VERSION = 'v23-music-12-genres-pro-prompts'
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: BUILD_VERSION, ts: new Date().toISOString() })
})

// Bearer-auth guard for /render
function requireBearer(req, res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token !== WORKER_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

/**
 * POST /render
 * Body: { jobId: string, userId: string }
 * The worker responds 202 immediately, then runs the render in the
 * background and notifies the Vercel app via the configured CALLBACK_URL.
 */
app.post('/render', requireBearer, async (req, res) => {
  const { jobId, userId } = req.body ?? {}
  if (!jobId || !userId) {
    return res.status(400).json({ error: 'jobId and userId required' })
  }

  // Ack right away — render happens async so HTTP doesn't time out.
  res.status(202).json({ accepted: true, jobId })

  const workDir = path.join(WORKDIR_ROOT, jobId)
  try {
    await mkdir(workDir, { recursive: true })
    console.log(`[render] start jobId=${jobId} userId=${userId}`)

    await downloadJobAssets(userId, jobId, workDir)
    const manifest = await readJobManifest(workDir)
    console.log(`[render] manifest:`, JSON.stringify(manifest).slice(0, 200))

    const renderResult = await renderJob({ workDir, openaiKey: OPENAI_KEY, manifest })
    const outputPath = renderResult.outputPath ?? renderResult  // back-compat
    const stats = renderResult.stats ?? null
    const publicUrl = await uploadOutput(userId, jobId, outputPath, 'output.mp4')

    // Thumbnail: extraer frame en t=1.5s (después del intro del clip).
    // No bloquea si falla — el render principal ya es exitoso.
    let thumbUrl = null
    try {
      const thumbPath = `${workDir}/thumbnail.jpg`
      await execAsync(
        `ffmpeg -y -ss 1.5 -i "${outputPath}" -vframes 1 -vf "scale=540:-2" -q:v 4 "${thumbPath}"`,
        { timeout: 30_000 },
      )
      thumbUrl = await uploadThumbnail(userId, jobId, thumbPath)
      console.log(`[render] thumbnail uploaded: ${thumbUrl}`)
    } catch (thumbErr) {
      console.warn(`[render] thumbnail failed (non-blocking):`, thumbErr?.message ?? thumbErr)
    }

    await postCallback({
      jobId,
      userId,
      status: 'done',
      videoUrl: publicUrl,
      thumbnailUrl: thumbUrl,
      stats,
    })
    console.log(`[render] done jobId=${jobId} url=${publicUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stderr = err?.stderr ? String(err.stderr).slice(-3000) : ''
    const stdout = err?.stdout ? String(err.stdout).slice(-1500) : ''
    console.error(`[render] fail jobId=${jobId}: ${msg}`)
    if (stderr) console.error(`[render] stderr (tail):\n${stderr}`)
    if (stdout) console.error(`[render] stdout (tail):\n${stdout}`)
    await postCallback({
      jobId,
      userId,
      status: 'failed',
      error: (msg + (stderr ? ' | stderr: ' + stderr.slice(-400) : '')).slice(0, 1500),
    })
  } finally {
    // Clean tmpfs regardless of outcome — output is already in Supabase
    rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
})

app.use((_req, res) => res.status(404).json({ error: 'not found' }))

app.listen(PORT, () => {
  console.log(`MackreeAI worker listening on :${PORT}`)
})
