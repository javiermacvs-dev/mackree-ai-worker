// Chixy render worker — Express server that wraps FFmpeg.
// Receives signed render requests from the Vercel app, pulls assets from
// Supabase Storage, runs the pipeline, uploads the output, and posts back.

import express from 'express'
import morgan from 'morgan'
import { rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { downloadJobAssets, uploadOutput, uploadThumbnail, readJobManifest, downloadOneAsset, uploadAsset, createSignedAssetUrl, downloadBrandLogo } from './lib/storage.js'
import { renderJob, runCaptionsFix } from './lib/render.js'
import { cutFragments } from './lib/music-fragments.js'
import { generateCover, generateCoverFields, extractCoverFrames, FONT_CATALOG } from './lib/cover.js'
import { existsSync } from 'node:fs'
import { postCallback } from './lib/callback.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const PORT = parseInt(process.env.PORT ?? '8080', 10)
const WORKER_SECRET = process.env.WORKER_SECRET
const WORKDIR_ROOT = process.env.RENDER_WORKDIR ?? '/tmp/render-jobs'
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''   // WS11: título de portada

if (!WORKER_SECRET) {
  console.error('FATAL: WORKER_SECRET is required')
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(morgan('combined'))

// Health probe for Easypanel — `version` lets us confirm a new deploy is live.
const BUILD_VERSION = 'v73-captions-only-fix'
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

    // WS11: PORTADA estilo CapCut — frame REAL del footage + textos IA editables.
    // La IA propone los textos; el cliente edita todo (textos/tipografía/color/frame)
    // y regenera vía POST /cover. Frames candidatos del footage real para elegir.
    // No bloquea si falla.
    let coverUrl = null
    let coverTitle = null
    let coverFields = null
    let coverFrames = []
    try {
      const logoPath = manifest?.brandLogoUrl ? path.join(workDir, 'logo.png') : null
      const logo = logoPath && existsSync(logoPath) ? logoPath : null
      // 1) Frames candidatos del footage real (antes de las ilustraciones IA).
      const framePaths = await extractCoverFrames({ workDir, fallbackVideo: outputPath, format: manifest?.format, max: 6 })
      for (let i = 0; i < framePaths.length; i++) {
        try { coverFrames.push(await uploadAsset(userId, jobId, framePaths[i], `cover_frame_${i}.jpg`, 'image/jpeg')) } catch { /* skip */ }
      }
      // 2) Textos propuestos por IA + estilo por defecto.
      const f = await generateCoverFields(manifest?.script || manifest?.description || '', ANTHROPIC_KEY)
      coverFields = { ...f, font: 'anton', accentColor: '#FFE400', frameIndex: 0 }
      // 3) Componer la portada con el primer frame real.
      const coverPath = await generateCover({
        framePath: framePaths[0] || null,
        videoPath: outputPath,
        format: manifest?.format,
        logoPath: logo,
        workDir,
        fields: coverFields,
      })
      coverUrl = await uploadAsset(userId, jobId, coverPath, 'cover.png', 'image/png')
      coverTitle = [coverFields.title1, coverFields.title2].filter(Boolean).join(' ')
      console.log(`[render] cover uploaded: ${coverUrl} (${coverFrames.length} frames, "${coverTitle}")`)
    } catch (coverErr) {
      console.warn(`[render] cover failed (non-blocking):`, coverErr?.message ?? coverErr)
    }

    await postCallback({
      jobId,
      userId,
      status: 'done',
      videoUrl: publicUrl,
      thumbnailUrl: thumbUrl,
      coverUrl,
      coverTitle,
      coverFields,
      coverFrames,
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

/**
 * Corrección de SOLO SUBTÍTULOS sobre un video ya renderizado (ver runCaptionsFix
 * en render.js) — NO rehace voz/ilustraciones/avatar/música. Va por la MISMA cola
 * que /render (semáforo de 1) porque burnCaptions usa el ancho/alto del módulo
 * (W/H, mutados por-job) — no es seguro correrlo en paralelo con otro render.
 */
async function runCaptionsFixJob(jobId, userId, newReplacements) {
  const workDir = path.join(WORKDIR_ROOT, `capfix-${jobId}`)
  try {
    await mkdir(workDir, { recursive: true })
    console.log(`[captions-fix] start jobId=${jobId} userId=${userId}`)

    const result = await runCaptionsFix({ workDir, userId, jobId, newReplacements })

    // Thumbnail (mismo patrón que runRender). No bloqueante.
    let thumbUrl = null
    try {
      const thumbPath = `${workDir}/thumbnail.jpg`
      await execAsync(
        `ffmpeg -y -ss 1.5 -i "${result.outputPath}" -vframes 1 -vf "scale=540:-2" -q:v 4 "${thumbPath}"`,
        { timeout: 30_000 },
      )
      thumbUrl = await uploadThumbnail(userId, jobId, thumbPath)
    } catch (thumbErr) {
      console.warn(`[captions-fix] thumbnail failed (non-blocking):`, thumbErr?.message ?? thumbErr)
    }

    await postCallback({ jobId, userId, status: 'done', videoUrl: result.publicUrl, thumbnailUrl: thumbUrl, captionReplacements: result.mergedReplacements })
    console.log(`[captions-fix] done jobId=${jobId}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errorCode = err?.code === 'no_precaptions_asset' ? 'no_precaptions_asset' : msg
    console.error(`[captions-fix] fail jobId=${jobId}: ${errorCode}`)
    await postCallback({ jobId, userId, status: 'failed', error: errorCode })
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Procesa la cola de a uno. Re-llamado al terminar cada render.
function pump() {
  if (activeRender) return
  const next = renderQueue.shift()
  if (!next) return
  activeRender = true
  console.log(`[queue] starting ${next.kind ?? 'render'} jobId=${next.jobId} (remaining in queue: ${renderQueue.length})`)

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('render_timeout')), RENDER_TIMEOUT_MS)
  })

  const task = next.kind === 'captions-fix'
    ? runCaptionsFixJob(next.jobId, next.userId, next.captionReplacements)
    : runRender(next.jobId, next.userId)

  Promise.race([task, timeout])
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

/**
 * POST /captions-fix
 * Body: { jobId, userId, captionReplacements: [{from,to}] }
 * Corrige SOLO los subtítulos de un video YA renderizado — no vuelve a generar
 * voz/ilustraciones/avatar/música. Responde 202 y ENCOLA (misma cola que /render,
 * ver runCaptionsFixJob). Si el job es de antes de esta función (no tiene
 * precaptions.mp4) falla con error 'no_precaptions_asset' vía el callback — el
 * SaaS cae a un render completo en ese caso.
 */
app.post('/captions-fix', requireBearer, (req, res) => {
  const { jobId, userId, captionReplacements } = req.body ?? {}
  if (!jobId || !userId) {
    return res.status(400).json({ error: 'jobId and userId required' })
  }
  renderQueue.push({ kind: 'captions-fix', jobId, userId, captionReplacements })
  const position = renderQueue.length + (activeRender ? 1 : 0)
  console.log(`[queue] enqueued captions-fix jobId=${jobId} (position ${position}, active=${activeRender})`)
  res.status(202).json({ accepted: true, jobId, queued: true, position })
  pump()
})

/**
 * POST /music-fragments  (WS10)
 * Body: { jobId, userId, durationSec }
 * Baja la canción propia (music.mp3 ya subida), corta hasta 4 fragmentos de
 * durationSec de distintas partes, los sube y devuelve URLs firmadas para que el
 * cliente los ESCUCHE y elija. Síncrono (segundos), fuera de la cola de render.
 */
/**
 * POST /cover  (WS11)
 * Body: { jobId, userId, fields?: { title1,title2,badge,subtitle,font,accentColor,frameIndex }, title? (legacy) }
 * Regenera la PORTADA estilo CapCut con los campos editados (textos/tipografía/
 * color/frame). Reusa output.mp4 + job.json + el frame elegido (cover_frame_N.jpg)
 * ya en Storage. Síncrono (pocos segundos).
 */
app.post('/cover', requireBearer, async (req, res) => {
  const { jobId, userId, fields, title } = req.body ?? {}
  if (!jobId || !userId) return res.status(400).json({ error: 'jobId and userId required' })
  const workDir = path.join(WORKDIR_ROOT, `cover-${jobId}`)
  try {
    await mkdir(workDir, { recursive: true })
    await downloadOneAsset(userId, jobId, 'job.json', path.join(workDir, 'job.json'))
    const manifest = await readJobManifest(workDir)
    const videoPath = path.join(workDir, 'output.mp4')
    await downloadOneAsset(userId, jobId, 'output.mp4', videoPath).catch(() => {})

    let logoPath = null
    if (manifest?.brandLogoUrl) {
      logoPath = await downloadBrandLogo(manifest.brandLogoUrl, workDir).catch(() => null)
    }

    // Campos editables. Compatibilidad con el body viejo {title}.
    let f = (fields && typeof fields === 'object') ? { ...fields } : {}
    if (!fields && title) f = { title1: String(title).toUpperCase() }
    if (!f.title1 && !f.title2) {
      const ai = await generateCoverFields(manifest?.script || manifest?.description || '', ANTHROPIC_KEY)
      f = { ...ai, ...f }
    }
    f.font = f.font || 'anton'
    f.accentColor = f.accentColor || '#FFE400'
    const frameIndex = Number.isInteger(f.frameIndex) ? f.frameIndex : 0

    // Frame de fondo elegido (footage real). Si no se baja → fallback al output.
    let framePath = path.join(workDir, `cover_frame_${frameIndex}.jpg`)
    const gotFrame = await downloadOneAsset(userId, jobId, `cover_frame_${frameIndex}.jpg`, framePath).then(() => true).catch(() => false)
    if (!gotFrame) framePath = null

    const coverPath = await generateCover({ framePath, videoPath, format: manifest?.format, logoPath, workDir, fields: f })
    const coverUrl = await uploadAsset(userId, jobId, coverPath, 'cover.png', 'image/png')
    const finalTitle = [f.title1, f.title2].filter(Boolean).join(' ')
    res.json({ ok: true, coverUrl, title: finalTitle, fields: { ...f, frameIndex } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[cover] regenerate fail jobId=${jobId}: ${msg}`)
    res.status(500).json({ error: 'cover_failed', detail: msg.slice(0, 300) })
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * GET /cover-fonts — catálogo de tipografías disponibles para el editor de portada.
 */
app.get('/cover-fonts', (_req, res) => {
  res.json({ fonts: FONT_CATALOG.map(f => ({ key: f.key, label: f.label })) })
})

app.post('/music-fragments', requireBearer, async (req, res) => {
  const { jobId, userId, durationSec } = req.body ?? {}
  if (!jobId || !userId) return res.status(400).json({ error: 'jobId and userId required' })
  const workDir = path.join(WORKDIR_ROOT, `frag_${jobId}`)
  try {
    await mkdir(workDir, { recursive: true })
    const musicPath = path.join(workDir, 'music.mp3')
    await downloadOneAsset(userId, jobId, 'music.mp3', musicPath)
    const frags = await cutFragments({ musicPath, durationSec: Number(durationSec) || 30, workDir })
    const options = []
    for (const f of frags) {
      const remoteName = `music_frag_${f.index}.m4a`
      await uploadAsset(userId, jobId, f.localPath, remoteName, 'audio/mp4')
      const url = await createSignedAssetUrl(userId, jobId, remoteName, 3600)
      options.push({ index: f.index, offsetSec: f.offsetSec, label: f.label, url })
    }
    res.json({ ok: true, options })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[music-fragments] jobId=${jobId}: ${msg}`)
    res.status(500).json({ error: 'fragments_failed', detail: msg.slice(0, 300) })
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
})

app.use((_req, res) => res.status(404).json({ error: 'not found' }))

app.listen(PORT, () => {
  console.log(`Chixy worker listening on :${PORT}`)
})
