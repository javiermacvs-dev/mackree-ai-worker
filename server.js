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
const BUILD_VERSION = 'v46-simple-images-vertical'
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

// ── Render queue: semáforo de 1 render a la vez + timeout (bug #15) ───────────
// Evita el crash por renders concurrentes saturando el contenedor (incidente v19).
// Cola FIFO GLOBAL para todos los clientes: el 2º pedido espera su turno, no
// compite por la máquina. El cliente no se bloquea (recibe 202 al instante; el
// dashboard hace polling). Escala futura (subir concurrencia / cola compartida
// con varios workers): ver mackree-ai-worker/CLAUDE.md → Errores #1.
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS ?? '1500000', 10) // 25 min
let activeRender = false
const renderQueue = []

async function runRender(jobId, userId) {
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
}

// Procesa la cola de a uno. Re-llamado al terminar cada render.
function pump() {
  if (activeRender) return
  const next = renderQueue.shift()
  if (!next) return
  activeRender = true
  console.log(`[queue] starting jobId=${next.jobId} (remaining in queue: ${renderQueue.length})`)

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('render_timeout')), RENDER_TIMEOUT_MS)
  })

  Promise.race([runRender(next.jobId, next.userId), timeout])
    .catch(async (err) => {
      // runRender atrapa sus propios errores; esto captura sobre todo el timeout,
      // que libera el slot aunque un render quede colgado (los ffmpeg internos
      // tienen su propio timeout y terminan muriendo).
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[queue] jobId=${next.jobId} aborted by guard: ${msg}`)
      if (msg === 'render_timeout') {
        await postCallback({
          jobId: next.jobId,
          userId: next.userId,
          status: 'failed',
          error: 'render_timeout',
        }).catch(() => {})
        rm(path.join(WORKDIR_ROOT, next.jobId), { recursive: true, force: true }).catch(() => {})
      }
    })
    .finally(() => {
      clearTimeout(timer)
      activeRender = false
      pump() // siguiente de la fila
    })
}

/**
 * POST /render
 * Body: { jobId: string, userId: string }
 * Responde 202 al instante y ENCOLA el render. Se procesa de a UNO a la vez
 * (semáforo) con timeout de seguridad. Ver bug #15 en CLAUDE.md.
 */
app.post('/render', requireBearer, (req, res) => {
  const { jobId, userId } = req.body ?? {}
  if (!jobId || !userId) {
    return res.status(400).json({ error: 'jobId and userId required' })
  }
  renderQueue.push({ jobId, userId })
  const position = renderQueue.length + (activeRender ? 1 : 0)
  console.log(`[queue] enqueued jobId=${jobId} (position ${position}, active=${activeRender})`)
  res.status(202).json({ accepted: true, jobId, queued: true, position })
  pump()
})

app.use((_req, res) => res.status(404).json({ error: 'not found' }))

app.listen(PORT, () => {
  console.log(`MackreeAI worker listening on :${PORT}`)
})
