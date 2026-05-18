// MVP render pipeline for the worker.
// Two modes branched off the manifest written by /api/generate/render:
//
//   CREATE  (manifest.mode === 'create' or missing):
//     Expects voice.mp3 + media_*.{ext} (+ optional music.mp3).
//     Visuals are segmented to match voice duration; voice is the master track.
//     Whisper transcribes voice.mp3 → ASS captions burned in pass 2.
//
//   EDIT    (manifest.mode === 'edit' or manifest.noVoice === true):
//     Expects only media_*.{ext} (+ optional music.mp3). NO voice.mp3.
//     Concatenates clips preserving their own audio. Total duration = sum of clips.
//     Whisper transcribes the concatenated audio → ASS captions burned in pass 2
//     (if manifest.captions !== false).
//
// Advanced effects from the original endpoint (glitch intro, watermark, outro
// flash, blur_bg, timelapse speed) are TODO — they'll be added as HyperFrames
// branded overlays in a follow-up sprint.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { downloadBrandLogo } from './storage.js'

const execAsync = promisify(exec)

const W = 1080
const H = 1920
const FPS = 30
const IMAGE_DEFAULT_DUR = 3   // seconds per image in edit mode

function fwd(p) {
  return p.replace(/\\/g, '/')
}

function ffmpegAssPath(p) {
  // FFmpeg's subtitle filter needs colons escaped on Windows-style paths.
  return fwd(p).replace(/^([A-Za-z]):/, '$1\\:')
}

function q(p) {
  return `"${fwd(p)}"`
}

async function getMediaDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${q(filePath)}`,
      { timeout: 15_000 },
    )
    const d = parseFloat(stdout.trim())
    return Number.isFinite(d) ? d : 10
  } catch {
    return 10
  }
}

async function hasAudioStream(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 ${q(filePath)}`,
      { timeout: 15_000 },
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Detect long silences in a video clip and produce a trimmed copy that skips them.
 * Returns the path to the trimmed clip (or the original if no silences found).
 *
 * minSilenceDur: silencios MAYORES a este threshold se cortan (segundos)
 * noiseDb: nivel de "silencio" en dB (-30 = típico para grabaciones limpias)
 * padding: mantener N segundos antes/después de cada silencio (evita cortes bruscos)
 */
async function trimSilences(inputPath, outputDir, indexLabel, opts = {}) {
  const minSilenceDur = opts.minSilenceDur ?? 0.8
  const noiseDb = opts.noiseDb ?? -30
  const padding = opts.padding ?? 0.1

  // Pass 1: detect silences via silencedetect (escribe a stderr)
  let detectStderr = ''
  try {
    await execAsync(
      `ffmpeg -hide_banner -i ${q(inputPath)} -af silencedetect=noise=${noiseDb}dB:d=${minSilenceDur} -f null -`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 180_000 },
    )
  } catch (e) {
    // ffmpeg con -f null - sale con 0 normalmente, pero por si acaso capturamos stderr
    detectStderr = e?.stderr ? String(e.stderr) : ''
  }
  // En caso de éxito, ffmpeg devuelve stderr en el resolved object. Re-correr con captura explícita:
  if (!detectStderr) {
    try {
      const { stderr } = await execAsync(
        `ffmpeg -hide_banner -i ${q(inputPath)} -af silencedetect=noise=${noiseDb}dB:d=${minSilenceDur} -f null - 2>&1`,
        { maxBuffer: 50 * 1024 * 1024, timeout: 180_000, shell: true },
      )
      detectStderr = stderr ?? ''
    } catch {}
  }

  // Parse silencias del log
  const silences = []
  const lines = (detectStderr || '').split('\n')
  let pendingStart = null
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s+([\d.]+)/)
    const endMatch = line.match(/silence_end:\s+([\d.]+)/)
    if (startMatch) pendingStart = parseFloat(startMatch[1])
    if (endMatch && pendingStart !== null) {
      const end = parseFloat(endMatch[1])
      // padding: contraer el rango de silencio para no cortar respiración
      const start = pendingStart + padding
      const endPadded = end - padding
      if (endPadded - start >= 0.3) silences.push({ start, end: endPadded })
      pendingStart = null
    }
  }

  if (silences.length === 0) {
    console.log(`[silence] ${indexLabel}: no silences > ${minSilenceDur}s detected, keeping original`)
    return { path: inputPath, removedSec: 0, trimmed: false }
  }

  const totalDur = await getMediaDuration(inputPath)
  if (!Number.isFinite(totalDur) || totalDur <= 0) {
    return { path: inputPath, removedSec: 0, trimmed: false }
  }

  // Build keep ranges (inverso de silences)
  const keepRanges = []
  let cursor = 0
  for (const s of silences) {
    if (s.start > cursor) keepRanges.push([cursor, s.start])
    cursor = s.end
  }
  if (cursor < totalDur) keepRanges.push([cursor, totalDur])

  if (keepRanges.length === 0) {
    console.warn(`[silence] ${indexLabel}: full clip is silence, keeping original`)
    return { path: inputPath, removedSec: 0, trimmed: false }
  }

  const selectExpr = keepRanges
    .map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`)
    .join('+')

  const trimmedPath = path.join(outputDir, `${indexLabel}_trimmed.mp4`)
  // Pass 2: re-encode skipeando silencios. setpts/asetpts re-asignan timestamps
  // para que después del corte, el siguiente frame siga inmediatamente al anterior.
  const cmd = [
    'ffmpeg -y -hide_banner',
    `-i ${q(inputPath)}`,
    `-vf "select='${selectExpr}',setpts=N/FRAME_RATE/TB"`,
    `-af "aselect='${selectExpr}',asetpts=N/SR/TB"`,
    '-c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
    '-c:a aac -b:a 128k',
    q(trimmedPath),
  ].join(' ')

  try {
    await execAsync(cmd, { maxBuffer: 300 * 1024 * 1024, timeout: 300_000 })
  } catch (e) {
    console.warn(`[silence] ${indexLabel}: trim cmd failed, using original. err=${e?.message ?? e}`)
    return { path: inputPath, removedSec: 0, trimmed: false }
  }

  const removedSec = silences.reduce((acc, s) => acc + (s.end - s.start), 0)
  console.log(`[silence] ${indexLabel}: removed ${removedSec.toFixed(2)}s from ${silences.length} silences (orig ${totalDur.toFixed(1)}s)`)
  return { path: trimmedPath, removedSec, trimmed: true }
}

function sToASS(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.round((s % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function buildASS(words) {
  const LIME = '&H0000FF80'
  const WHITE = '&H00FFFFFF'
  const CHUNK = 5
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 1',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Impact,76,${WHITE},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,10,10,80,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const lines = [header]
  for (let i = 0; i < words.length; i++) {
    const cs = Math.floor(i / CHUNK) * CHUNK
    const chunk = words.slice(cs, cs + CHUNK)
    const pos = i - cs
    const text = chunk.map((w, ci) => `{\\c${ci === pos ? LIME : WHITE}&}${w.word}`).join(' ')
    lines.push(
      `Dialogue: 0,${sToASS(words[i].start)},${sToASS(words[i].end)},Default,,0,0,0,,{\\an2}${text}`,
    )
  }
  return lines.join('\n')
}

async function transcribeWords(audioPath, openaiKey) {
  if (!openaiKey) {
    console.warn('[transcribe] OPENAI_API_KEY missing — captions skipped')
    return []
  }
  try {
    const audio = await readFile(audioPath)
    const ext = audioPath.split('.').pop()?.toLowerCase() ?? 'mp3'
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'audio/aac'
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`)
    form.append('model', 'whisper-1')
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    console.log(`[transcribe] uploading ${audio.length} bytes to Whisper...`)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error(`[transcribe] Whisper failed ${res.status}: ${errBody.slice(0, 300)}`)
      return []
    }
    const data = await res.json()
    const words = (data.words ?? [])
      .map((w) => ({
        word: w.word.replace(/[^\w\sáéíóúñüÁÉÍÓÚÑÜ¿?¡!,.:;]/g, '').trim(),
        start: w.start,
        end: w.end,
      }))
      .filter((w) => w.word.length > 0)
    console.log(`[transcribe] got ${words.length} words from Whisper`)
    return words
  } catch (e) {
    console.error(`[transcribe] exception:`, e?.message ?? e)
    return []
  }
}

async function findMediaItems(workDir) {
  const entries = await readdir(workDir)
  return entries
    .filter((e) => e.startsWith('media_'))
    .sort((a, b) => {
      const na = parseInt(a.replace('media_', '').split('.')[0])
      const nb = parseInt(b.replace('media_', '').split('.')[0])
      return na - nb
    })
    .map((e) => {
      const ext = e.split('.').pop()?.toLowerCase() ?? ''
      const type = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext) ? 'video' : 'image'
      return { filePath: path.join(workDir, e), type, name: e }
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// CREATE MODE  (voice.mp3 master)
// ──────────────────────────────────────────────────────────────────────────────
async function renderCreate({ workDir, openaiKey, manifest }) {
  const voicePath = path.join(workDir, 'voice.mp3')
  const voiceDur = await getMediaDuration(voicePath)
  const mediaItems = await findMediaItems(workDir)

  const n = Math.max(1, mediaItems.length)
  const segDur = voiceDur / n

  // Brand logo (top-right watermark) — null si el user no subió logo
  const logoPath = await downloadBrandLogo(manifest?.brandLogoUrl, workDir)
  console.log(`[render][create] brand logo: ${logoPath ? 'yes' : 'none'}`)

  const inputs = []
  const fc = []
  let idx = 0
  const segLabels = []

  for (let i = 0; i < mediaItems.length; i++) {
    const item = mediaItems[i]
    const label = `s${i}`
    segLabels.push(label)

    if (item.type === 'image') {
      inputs.push(`-loop 1 -t ${(segDur + 1).toFixed(2)} -i ${q(item.filePath)}`)
      fc.push(
        `[${idx}:v]fps=${FPS},setpts=PTS-STARTPTS,trim=duration=${segDur.toFixed(2)},setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[seg_${label}]`,
      )
    } else {
      // VIDEO CHAIN — base + deshake (estabilización) + unsharp (nitidez) + eq (color)
      inputs.push(`-i ${q(item.filePath)}`)
      fc.push(
        `[${idx}:v]trim=0:${(segDur * 1.05).toFixed(2)},setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,` +
          `deshake=rx=16:ry=16,` +
          `unsharp=5:5:0.6:5:5:0.0,` +
          `eq=contrast=1.05:saturation=1.08:gamma=0.98,` +
          `format=yuv420p[seg_${label}]`,
      )
    }
    idx++
  }

  if (mediaItems.length === 0) {
    inputs.push(`-f lavfi -t ${voiceDur.toFixed(2)} -i color=black:s=${W}x${H}:r=${FPS}`)
    fc.push(`[${idx}:v]setsar=1,format=yuv420p[seg_s0]`)
    segLabels.push('s0')
    idx++
  }

  const concatIn = segLabels.map((l) => `[seg_${l}]`).join('')
  fc.push(`${concatIn}concat=n=${segLabels.length}:v=1:a=0[vconcat]`)

  // Voice — volume boost + loudnorm para audio limpio y consistente
  const voiceIdx = idx
  inputs.push(`-i ${q(voicePath)}`)
  idx++
  fc.push(
    `[${voiceIdx}:a]apad,atrim=0:${voiceDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
      `volume=1.3,loudnorm=I=-16:LRA=11:TP=-1.5[narr]`,
  )

  // Optional music
  const musicPath = path.join(workDir, 'music.mp3')
  let hasMusic = false
  try {
    await readFile(musicPath)
    hasMusic = true
  } catch {
    hasMusic = false
  }

  const audioLabels = ['[narr]']
  if (hasMusic) {
    const musicIdx = idx
    inputs.push(`-i ${q(musicPath)}`)
    idx++
    fc.push(
      `[${musicIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${voiceDur.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.06,` +
        `afade=t=out:st=${Math.max(0, voiceDur - 1.5).toFixed(2)}:d=1.5[music]`,
    )
    audioLabels.push('[music]')
  }

  if (audioLabels.length === 2) {
    fc.push(`${audioLabels.join('')}amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]`)
  } else {
    fc.push(`[narr]alimiter=limit=0.95[aout]`)
  }

  // Video post-concat: overlay del logo top-right si existe
  let videoOutLabel = '[vconcat]'
  if (logoPath) {
    const logoIdx = idx
    inputs.push(`-i ${q(logoPath)}`)
    idx++
    fc.push(`[${logoIdx}:v]scale=140:-1[logo_scaled]`)
    fc.push(`[vconcat][logo_scaled]overlay=W-w-30:30[vfinal]`)
    videoOutLabel = '[vfinal]'
  } else {
    // Sin logo: re-etiquetamos para mantener el alias [vfinal] que usa el -map
    fc.push(`[vconcat]copy[vfinal]`)
    videoOutLabel = '[vfinal]'
  }

  const rawPath = path.join(workDir, 'raw.mp4')
  const cmd1 = [
    'ffmpeg -y',
    inputs.join(' '),
    `-filter_complex "${fc.join('; ')}"`,
    `-map "${videoOutLabel}"`,
    `-map "[aout]"`,
    '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p',
    '-crf 26 -preset fast',
    '-c:a aac -b:a 192k -movflags +faststart',
    `-t ${voiceDur.toFixed(2)}`,
    q(rawPath),
  ].join(' ')

  console.log('[render][create] pass 1 cmd (300):', cmd1.slice(0, 300))
  await execAsync(cmd1, { maxBuffer: 300 * 1024 * 1024, timeout: 900_000 })

  // Pass 2: burn ASS captions (graceful fallback if Whisper fails or captions=false)
  const outputPath = path.join(workDir, 'output.mp4')
  const wantCaptions = manifest?.captions !== false
  const words = wantCaptions ? await transcribeWords(voicePath, openaiKey) : []

  if (words.length > 0) {
    await burnCaptions({ rawPath, words, outputPath, workDir })
  } else {
    await copyFile(rawPath, outputPath)
  }

  return outputPath
}

// ──────────────────────────────────────────────────────────────────────────────
// EDIT MODE  (no voice.mp3 — audio comes from the clips themselves)
// ──────────────────────────────────────────────────────────────────────────────
async function renderEdit({ workDir, openaiKey, manifest }) {
  const mediaItems = await findMediaItems(workDir)
  if (mediaItems.length === 0) {
    throw new Error('edit_mode_requires_at_least_one_clip')
  }

  // Probe each clip for duration + audio presence
  const probed = []
  for (const item of mediaItems) {
    if (item.type === 'video') {
      const dur = await getMediaDuration(item.filePath)
      const hasA = await hasAudioStream(item.filePath)
      probed.push({ ...item, dur, hasAudio: hasA })
    } else {
      probed.push({ ...item, dur: IMAGE_DEFAULT_DUR, hasAudio: false })
    }
  }

  // Pre-pass: cortar silencios largos (>0.8s) de cada clip de video con audio.
  // Mantiene sync video/audio porque procesa AMBOS streams con select/aselect.
  const wantSilenceTrim = manifest?.silenceTrim !== false  // default ON
  if (wantSilenceTrim) {
    for (let i = 0; i < probed.length; i++) {
      const item = probed[i]
      if (item.type === 'video' && item.hasAudio) {
        const label = `clip${i + 1}`
        const result = await trimSilences(item.filePath, workDir, label, {
          minSilenceDur: 0.8,
          noiseDb: -30,
          padding: 0.1,
        })
        if (result.trimmed) {
          probed[i].filePath = result.path
          probed[i].dur = await getMediaDuration(result.path)
        }
      }
    }
  }

  const totalDur = probed.reduce((acc, p) => acc + p.dur, 0)

  // Brand logo (top-right watermark) — null si el user no subió logo
  const logoPath = await downloadBrandLogo(manifest?.brandLogoUrl, workDir)
  console.log(`[render][edit] brand logo: ${logoPath ? 'yes' : 'none'} silenceTrim: ${wantSilenceTrim}`)

  // Build filter_complex with V+A concat
  const inputs = []
  const fc = []
  let idx = 0
  const concatPairs = []  // ["[v0][a0]", "[v1][a1]", ...]

  for (let i = 0; i < probed.length; i++) {
    const item = probed[i]
    const vLabel = `v${i}`
    const aLabel = `a${i}`

    // Normalizamos TODO el audio (real o sintético) al mismo formato para que
    // el concat filter no rechace por mismatch (sample_fmt/rate/channels).
    const AFMT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo'

    if (item.type === 'image') {
      // Image → loop for IMAGE_DEFAULT_DUR with silent audio
      inputs.push(`-loop 1 -t ${item.dur.toFixed(2)} -i ${q(item.filePath)}`)
      fc.push(
        `[${idx}:v]fps=${FPS},setpts=PTS-STARTPTS,trim=duration=${item.dur.toFixed(2)},setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[${vLabel}]`,
      )
      fc.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${item.dur.toFixed(2)},${AFMT}[${aLabel}]`,
      )
      idx++
    } else {
      inputs.push(`-i ${q(item.filePath)}`)
      // VIDEO CHAIN — base + deshake (estabilización) + unsharp (nitidez) + eq (color)
      fc.push(
        `[${idx}:v]setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
          `fps=${FPS},setsar=1,` +
          `deshake=rx=16:ry=16,` +
          `unsharp=5:5:0.6:5:5:0.0,` +
          `eq=contrast=1.05:saturation=1.08:gamma=0.98,` +
          `format=yuv420p[${vLabel}]`,
      )
      if (item.hasAudio) {
        // AUDIO CHAIN — denoise (afftdn) + dynamic normalize (dynaudnorm) + format
        fc.push(
          `[${idx}:a]aresample=44100,asetpts=PTS-STARTPTS,` +
            `afftdn=nr=35,` +
            `dynaudnorm=f=250:g=15,` +
            `${AFMT}[${aLabel}]`,
        )
      } else {
        fc.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${item.dur.toFixed(2)},${AFMT}[${aLabel}]`,
        )
      }
      idx++
    }
    concatPairs.push(`[${vLabel}][${aLabel}]`)
  }

  fc.push(`${concatPairs.join('')}concat=n=${probed.length}:v=1:a=1[vcat][acat]`)

  // Optional music underneath (low volume per style)
  const musicPath = path.join(workDir, 'music.mp3')
  let hasMusic = false
  try {
    await readFile(musicPath)
    hasMusic = true
  } catch {
    hasMusic = false
  }

  const isCommercial = (manifest?.style ?? 'commercial') === 'commercial'
  const musicVol = isCommercial ? 0.06 : 0.12  // EDIT_VIDEO rule #3

  // Audio post-concat: loudnorm EBU R128 antes del mix con música, alimiter final
  if (hasMusic) {
    const musicIdx = idx
    inputs.push(`-i ${q(musicPath)}`)
    idx++
    fc.push(
      `[${musicIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `volume=${musicVol},afade=t=out:st=${Math.max(0, totalDur - 1.5).toFixed(2)}:d=1.5[music]`,
    )
    fc.push(
      `[acat]loudnorm=I=-16:LRA=11:TP=-1.5[anorm]; ` +
        `[anorm][music]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]`,
    )
  } else {
    fc.push(`[acat]loudnorm=I=-16:LRA=11:TP=-1.5,alimiter=limit=0.95[aout]`)
  }

  // Video post-concat: overlay del logo top-right si existe
  let videoOutLabel = '[vcat]'
  if (logoPath) {
    const logoIdx = idx
    inputs.push(`-i ${q(logoPath)}`)
    idx++
    // Logo a ~140px ancho, esquina superior derecha con 30px margen
    fc.push(`[${logoIdx}:v]scale=140:-1[logo_scaled]`)
    fc.push(`[vcat][logo_scaled]overlay=W-w-30:30[vout]`)
    videoOutLabel = '[vout]'
  }

  const rawPath = path.join(workDir, 'raw.mp4')
  const cmd1 = [
    'ffmpeg -y',
    inputs.join(' '),
    `-filter_complex "${fc.join('; ')}"`,
    `-map "${videoOutLabel}"`,
    `-map "[aout]"`,
    '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p',
    '-crf 26 -preset fast',
    '-c:a aac -b:a 192k -movflags +faststart',
    `-t ${totalDur.toFixed(2)}`,
    q(rawPath),
  ].join(' ')

  console.log('[render][edit] pass 1 cmd (300):', cmd1.slice(0, 300))
  await execAsync(cmd1, { maxBuffer: 300 * 1024 * 1024, timeout: 900_000 })

  // Pass 2: extract audio, Whisper, burn ASS captions (if requested + clip had audio)
  const outputPath = path.join(workDir, 'output.mp4')
  const wantCaptions = manifest?.captions !== false
  const anyAudio = probed.some(p => p.hasAudio)
  console.log(`[render][edit] captions decision: wantCaptions=${wantCaptions} anyAudio=${anyAudio} openaiKey_present=${Boolean(openaiKey)}`)

  if (wantCaptions && anyAudio && openaiKey) {
    const extractedAudio = path.join(workDir, 'extracted_audio.m4a')
    try {
      await execAsync(
        `ffmpeg -y -i ${q(rawPath)} -vn -c:a aac -b:a 128k ${q(extractedAudio)}`,
        { timeout: 120_000 },
      )
      const words = await transcribeWords(extractedAudio, openaiKey)
      if (words.length > 0) {
        await burnCaptions({ rawPath, words, outputPath, workDir })
      } else {
        await copyFile(rawPath, outputPath)
      }
    } catch (e) {
      console.warn('[render][edit] caption pass failed, using raw:', e?.message ?? e)
      await copyFile(rawPath, outputPath)
    }
  } else {
    await copyFile(rawPath, outputPath)
  }

  return outputPath
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared captions pass
// ──────────────────────────────────────────────────────────────────────────────
async function burnCaptions({ rawPath, words, outputPath, workDir }) {
  const captionsPath = path.join(workDir, 'captions.ass')
  await writeFile(captionsPath, buildASS(words), 'utf8')
  const escaped = ffmpegAssPath(captionsPath)
  const cmd2 = [
    'ffmpeg -y',
    `-i ${q(rawPath)}`,
    `-vf "ass='${escaped}'"`,
    '-c:a copy -c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
    q(outputPath),
  ].join(' ')
  try {
    await execAsync(cmd2, { maxBuffer: 300 * 1024 * 1024, timeout: 900_000 })
  } catch (e) {
    console.warn('[render] captions burn failed, using raw:', e?.message ?? e)
    await copyFile(rawPath, outputPath)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point — dispatch by mode
// ──────────────────────────────────────────────────────────────────────────────
export async function renderJob({ workDir, openaiKey, manifest }) {
  const isEdit = manifest?.mode === 'edit' || manifest?.noVoice === true
  console.log(`[render] mode=${isEdit ? 'edit' : 'create'}`)
  if (isEdit) return renderEdit({ workDir, openaiKey, manifest })
  return renderCreate({ workDir, openaiKey, manifest })
}
