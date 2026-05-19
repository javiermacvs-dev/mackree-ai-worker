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
import {
  detectFillerRanges,
  detectClipBridgeRepetitions,
  mergeRanges,
  buildKeepFilter,
} from './fillerWords.js'
import { llmDetectFalseStartsAndRetakes } from './llmTrim.js'
import {
  generateMusicFromPrompt,
  downloadMusicTo,
  buildMusicPromptFromManifest,
} from './kie-music.js'
import { generateImagesForMomentsParallel } from './kie-image.js'
import { detectKeyMoments } from './llm-moments.js'

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

/**
 * Estima el "motion score" promedio del clip via vmafmotion filter.
 * Útil para decidir si aplicar `deshake` (caro) o no.
 *
 * Threshold típico: clips estables (selfie con cámara fija) < 0.5;
 * clips con movimiento (caminata, mano alzada) > 1.5.
 *
 * Procesa solo los primeros 8 segundos del clip (suficiente para estimar)
 * con escala bajada a 320x180 para ser rápido (~3-5s para el probe).
 */
async function estimateMotion(filePath) {
  try {
    const { stderr } = await execAsync(
      `ffmpeg -hide_banner -i ${q(filePath)} -t 8 -vf "scale=320:180,vmafmotion" -f null - 2>&1`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 30_000, shell: true },
    )
    // vmafmotion logs: "VMAF motion avg: X.XX"
    const match = (stderr || '').match(/VMAF motion avg:\s+([\d.]+)/)
    if (match) {
      const motion = parseFloat(match[1])
      return Number.isFinite(motion) ? motion : null
    }
    return null
  } catch {
    return null
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
  // Mínimo rango efectivo a cortar tras aplicar padding. Si minSilenceDur es
  // agresivo (0.35s), bajamos también este floor para que silencios cortos
  // calificados realmente se corten. Floor = max(0.15, minSilenceDur - 2*padding).
  const effectiveFloor = Math.max(0.15, minSilenceDur - 2 * padding)
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s+([\d.]+)/)
    const endMatch = line.match(/silence_end:\s+([\d.]+)/)
    if (startMatch) pendingStart = parseFloat(startMatch[1])
    if (endMatch && pendingStart !== null) {
      const end = parseFloat(endMatch[1])
      // padding: contraer el rango de silencio para no cortar respiración
      const start = pendingStart + padding
      const endPadded = end - padding
      if (endPadded - start >= effectiveFloor) silences.push({ start, end: endPadded })
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

  const trimmedPath = path.join(outputDir, `${indexLabel}_trimmed.mp4`)

  // v18 perf B: para N grande (>10 keepRanges), usar trim+concat filter en
  // lugar de select=between×N. El filter `select` evalúa la expresión por
  // CADA frame contra TODAS las N condiciones (CPU O(frames×N)). El filter
  // `trim` solo procesa frames dentro del rango (CPU O(frames mantenidos)).
  // Para N=50, ~3-5× más rápido. Para N pequeño, select sigue siendo simple.
  const USE_CONCAT_FILTER_THRESHOLD = 10
  let cmd
  if (keepRanges.length <= USE_CONCAT_FILTER_THRESHOLD) {
    const selectExpr = keepRanges
      .map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`)
      .join('+')
    cmd = [
      'ffmpeg -y -hide_banner',
      `-i ${q(inputPath)}`,
      `-vf "select='${selectExpr}',setpts=N/FRAME_RATE/TB"`,
      `-af "aselect='${selectExpr}',asetpts=N/SR/TB"`,
      '-c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
      '-c:a aac -b:a 128k',
      q(trimmedPath),
    ].join(' ')
  } else {
    // trim + concat filter — split inicial necesario para que ffmpeg permita
    // referenciar el mismo stream N veces sin error.
    const n = keepRanges.length
    const vSplits = Array.from({ length: n }, (_, i) => `[v_${i}]`).join('')
    const aSplits = Array.from({ length: n }, (_, i) => `[a_${i}]`).join('')
    const segments = keepRanges
      .map(
        ([a, b], i) =>
          `[v_${i}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[vt${i}]; ` +
          `[a_${i}]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS[at${i}]`,
      )
      .join('; ')
    const concatIns = keepRanges.map((_, i) => `[vt${i}][at${i}]`).join('')
    const fc =
      `[0:v]split=${n}${vSplits}; ` +
      `[0:a]asplit=${n}${aSplits}; ` +
      `${segments}; ` +
      `${concatIns}concat=n=${n}:v=1:a=1[vout][aout]`
    cmd = [
      'ffmpeg -y -hide_banner',
      `-i ${q(inputPath)}`,
      `-filter_complex "${fc}"`,
      '-map "[vout]" -map "[aout]"',
      '-c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
      '-c:a aac -b:a 128k',
      q(trimmedPath),
    ].join(' ')
  }

  try {
    await execAsync(cmd, { maxBuffer: 300 * 1024 * 1024, timeout: 300_000 })
  } catch (e) {
    console.warn(`[silence] ${indexLabel}: trim cmd failed, using original. err=${e?.message ?? e}`)
    return { path: inputPath, removedSec: 0, trimmed: false }
  }

  const removedSec = silences.reduce((acc, s) => acc + (s.end - s.start), 0)
  const algo = keepRanges.length <= 10 ? 'select' : 'concat-filter'
  console.log(
    `[silence] ${indexLabel}: removed ${removedSec.toFixed(2)}s from ${silences.length} silences ` +
      `(orig ${totalDur.toFixed(1)}s, kept ${keepRanges.length} ranges, algo=${algo})`,
  )
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

/**
 * Transcribe los clips individuales en paralelo y concatena las words con
 * offsets acumulados para que los timestamps coincidan con el video final.
 *
 * Esto permite que Whisper corra EN PARALELO con el pass 1 ffmpeg (que es
 * CPU-bound y toma 10-13 min), gratis. Antes era post-pass-1 secuencial
 * (~60-90s extra). Y deja la puerta abierta para Kie/Suno paralelos.
 *
 * Si un clip no tiene audio, contribuye con offset pero 0 words.
 *
 * Returns array global de {word, start, end} con timestamps en la
 * timeline del concatenado.
 */
async function transcribeClipsInParallel(probed, workDir, openaiKey) {
  if (!openaiKey) {
    console.warn('[transcribe-parallel] OPENAI_API_KEY missing — skipped')
    return []
  }

  // Extract audio + transcribe each clip in parallel.
  const tasks = probed.map(async (item, i) => {
    if (item.type !== 'video' || !item.hasAudio) {
      return { index: i, words: [], dur: item.dur }
    }
    const audioPath = path.join(workDir, `audio_${i}.m4a`)
    try {
      await execAsync(
        `ffmpeg -y -i ${q(item.filePath)} -vn -c:a aac -b:a 128k ${q(audioPath)}`,
        { timeout: 120_000 },
      )
    } catch (e) {
      console.warn(`[transcribe-parallel] clip${i + 1} audio extract failed:`, e?.message ?? e)
      return { index: i, words: [], dur: item.dur }
    }
    const words = await transcribeWords(audioPath, openaiKey)
    return { index: i, words, dur: item.dur }
  })

  const results = await Promise.all(tasks)

  // Concatenate words with cumulative offset.
  let offset = 0
  const allWords = []
  for (const r of results.sort((a, b) => a.index - b.index)) {
    for (const w of r.words) {
      allWords.push({
        word: w.word,
        start: w.start + offset,
        end: w.end + offset,
      })
    }
    offset += r.dur
  }
  console.log(
    `[transcribe-parallel] ${allWords.length} words across ${probed.length} clips ` +
      `(timeline 0..${offset.toFixed(1)}s)`,
  )
  return allWords
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
    // INAMOVIBLE 2026-05-19 (Javier): logo a 240px ancho (~22% del frame 1080).
    // Antes 140px = ~13%, demasiado chico para branding fuerte. NO bajar.
    fc.push(`[${logoIdx}:v]scale=240:-1[logo_scaled]`)
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
  // INAMOVIBLE 2026-05-19 (Javier): captions SIEMPRE activadas, sin toggle off.
  // Antes leía manifest.captions; ahora ignorado. Es regla de marca del producto.
  const wantCaptions = true; void manifest?.captions
  const words = wantCaptions ? await transcribeWords(voicePath, openaiKey) : []

  if (words.length > 0) {
    await burnCaptions({ rawPath, words, outputPath, workDir })
  } else {
    await copyFile(rawPath, outputPath)
  }

  // Stats vacios en create mode (no aplica content-trim aqui).
  const stats = {
    original_dur_sec: round2(voiceDur),
    final_dur_sec: round2(voiceDur),
    total_removed_sec: 0,
    silence_removed_sec: 0,
    silence_clips_affected: 0,
    content_removed_sec: 0,
    cuts_by_reason: {},
  }
  return { outputPath, stats }
}

// ──────────────────────────────────────────────────────────────────────────────
// EDIT MODE  (no voice.mp3 — audio comes from the clips themselves)
// ──────────────────────────────────────────────────────────────────────────────
async function renderEdit({ workDir, openaiKey, manifest }) {
  const mediaItems = await findMediaItems(workDir)
  if (mediaItems.length === 0) {
    throw new Error('edit_mode_requires_at_least_one_clip')
  }

  // Probe each clip for duration + audio presence + motion score
  // Motion score se usa para decidir si aplicar deshake (caro) o skipear.
  const probed = []
  for (const item of mediaItems) {
    if (item.type === 'video') {
      const dur = await getMediaDuration(item.filePath)
      const hasA = await hasAudioStream(item.filePath)
      const motion = await estimateMotion(item.filePath)
      probed.push({ ...item, dur, originalDur: dur, hasAudio: hasA, motion })
      console.log(
        `[probe] ${item.name}: dur=${dur.toFixed(1)}s, audio=${hasA}, motion=${motion !== null ? motion.toFixed(2) : 'unknown'}`,
      )
    } else {
      probed.push({ ...item, dur: IMAGE_DEFAULT_DUR, originalDur: IMAGE_DEFAULT_DUR, hasAudio: false, motion: 0 })
    }
  }

  // Track stats — totales pre-trim para calcular cuanto cortamos
  const originalConcatDur = probed.reduce((acc, p) => acc + p.originalDur, 0)
  let silenceRemovedSec = 0
  let silenceClipsAffected = 0

  // Pre-pass: cortar silencios largos (super-agresivo v14).
  const wantSilenceTrim = manifest?.silenceTrim !== false  // default ON
  if (wantSilenceTrim) {
    for (let i = 0; i < probed.length; i++) {
      const item = probed[i]
      if (item.type === 'video' && item.hasAudio) {
        const label = `clip${i + 1}`
        // INAMOVIBLE 2026-05-19 v25 — silence trim MEGA-AGRESIVO para Reels.
        // Calibrado contra fuentes expertas (Rendi.dev FFmpeg API + Descript blog):
        //   High-energy YouTube/Reels: d=0.3-0.5s, noise=-25 dB
        //   Educational: d=0.5-0.8s, noise=-30 dB
        //   Podcast: d=0.8-1.0s, noise=-32 dB
        // Antes (v24): 0.55/-32/0.12 = umbrales de podcast → silence_removed_sec=0 en speech real.
        // Javier (2026-05-19 madrugada): "tiene demasiados espacios en silencio, súper agresivo".
        // NO suavizar de nuevo. Si un cliente quiere conservar pausas, usa otra app.
        const result = await trimSilences(item.filePath, workDir, label, {
          minSilenceDur: 0.30,
          noiseDb: -25,
          padding: 0.05,
        })
        if (result.trimmed) {
          probed[i].filePath = result.path
          probed[i].dur = await getMediaDuration(result.path)
          silenceRemovedSec += result.removedSec
          silenceClipsAffected++
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
      // VIDEO CHAIN — base + (deshake si motion alto) + unsharp + eq (color)
      // v18 perf A: skip deshake si el motion score es bajo (cámara estable).
      // Ahorra 30-40% del CPU del pass 1 en clips selfie/talking-head.
      const MOTION_THRESHOLD = 1.0
      const skipDeshake = item.motion !== null && item.motion !== undefined && item.motion < MOTION_THRESHOLD
      const deshakeStep = skipDeshake ? '' : 'deshake=rx=16:ry=16,'
      if (skipDeshake) {
        console.log(`[render][edit] clip${i + 1}: motion=${item.motion.toFixed(2)} < ${MOTION_THRESHOLD} → skip deshake`)
      }
      fc.push(
        `[${idx}:v]setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
          `fps=${FPS},setsar=1,` +
          deshakeStep +
          `unsharp=5:5:0.6:5:5:0.0,` +
          `eq=contrast=1.05:saturation=1.08:gamma=0.98,` +
          `format=yuv420p[${vLabel}]`,
      )
      if (item.hasAudio) {
        // AUDIO CHAIN — highpass (corta rumble bajo) + denoise (afftdn) + dynamic normalize (dynaudnorm) + format
        // Trayectoria del denoise (Javier la subió 3 veces): nr=10 → nr=25 → nr=35 → nr=50.
        // Nota inamovible: nr SOLO sube, JAMÁS baja. Ver mackree-ai-worker/CLAUDE.md → "Decisiones inamovibles".
        fc.push(
          `[${idx}:a]aresample=44100,asetpts=PTS-STARTPTS,` +
            `highpass=f=100,` +
            `afftdn=nr=50,` +
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

  // Optional music underneath (low volume per style).
  // v21: si manifest.music !== 'none' y NO hay music.mp3 subido, generar con Kie Suno.
  // Si Kie falla, fallback graceful: render sin música (no bloquea el job entero).
  const musicPath = path.join(workDir, 'music.mp3')
  let hasMusic = false
  try {
    await readFile(musicPath)
    hasMusic = true
  } catch {
    const wantMusic = manifest?.music && String(manifest.music).toLowerCase() !== 'none'
    if (wantMusic) {
      try {
        const prompt = buildMusicPromptFromManifest(manifest)
        console.log(`[render][edit] generating music via Kie Suno V5: "${prompt.slice(0, 120)}..."`)
        const { audioUrl, duration: musicDur } = await generateMusicFromPrompt(prompt, {
          model: 'V5',
          instrumental: true,
        })
        await downloadMusicTo(audioUrl, musicPath)
        hasMusic = true
        console.log(`[render][edit] Kie music ready (${musicDur}s) → music.mp3`)
      } catch (e) {
        console.warn(
          `[render][edit] Kie music generation FAILED, rendering without music: ${e?.message ?? e}`,
        )
        hasMusic = false
      }
    }
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
    // INAMOVIBLE 2026-05-19 (Javier): logo a 240px ancho (~22% del frame 1080).
    // Antes 140px = ~13%, demasiado chico para branding fuerte. NO bajar.
    fc.push(`[${logoIdx}:v]scale=240:-1[logo_scaled]`)
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

  // v19 perf C — Paralelización: Whisper transcribe los clips ORIGINALES
  // mientras ffmpeg pass 1 corre el concat+filtros. Cada uno toma sus
  // 10-13 min (ffmpeg) y 30-60s (Whisper). Antes era secuencial → ahora
  // los 30-60s de Whisper se solapan gratis. Base lista para Kie/Suno
  // paralelos en Fase B (también arrancan acá sin sumar tiempo).
  // INAMOVIBLE 2026-05-19 (Javier): captions SIEMPRE activadas, sin toggle off.
  // Antes leía manifest.captions; ahora ignorado. Es regla de marca del producto.
  const wantCaptions = true; void manifest?.captions
  const anyAudio = probed.some(p => p.hasAudio)
  console.log(`[render][edit] captions decision: wantCaptions=${wantCaptions} anyAudio=${anyAudio} openaiKey_present=${Boolean(openaiKey)}`)

  const pass1Promise = execAsync(cmd1, { maxBuffer: 300 * 1024 * 1024, timeout: 900_000 })
  const transcribePromise =
    wantCaptions && anyAudio && openaiKey
      ? transcribeClipsInParallel(probed, workDir, openaiKey)
      : Promise.resolve([])

  let words = []
  try {
    const [_, w] = await Promise.all([pass1Promise, transcribePromise])
    words = w
  } catch (e) {
    // Si pass 1 falla, propagamos. Si Whisper falla, words queda en [] y
    // continuamos sin captions.
    if (typeof e?.message === 'string' && e.message.includes('ffmpeg')) {
      throw e
    }
    console.warn('[render][edit] parallel stage error:', e?.message ?? e)
    // Si llegamos acá es porque pass1 OK pero transcribe falló; sigamos sin words
    await pass1Promise.catch(() => {})
  }

  // Pass 2: content-trim + burn ASS captions
  const outputPath = path.join(workDir, 'output.mp4')

  // Stats del content-trim (acumulan vacios si no se ejecuta)
  let contentRemovedSec = 0
  let contentBreakdown = {}

  if (words.length > 0) {
    try {
      const wantContentTrim = manifest?.contentTrim !== false
      const anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
      const lang = (manifest?.lang ?? 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
      let finalRawPath = rawPath
      let finalWords = words
      if (wantContentTrim) {
        const result = await applyContentTrim({
          rawPath,
          words,
          workDir,
          anthropicKey,
          lang,
          openaiKey,
        })
        finalRawPath = result.path
        finalWords = result.words.length > 0 ? result.words : words
        contentRemovedSec = result.removedSec ?? 0
        contentBreakdown = rangesToBreakdown(result.ranges ?? [])
      }
      if (finalWords.length > 0) {
        await burnCaptions({ rawPath: finalRawPath, words: finalWords, outputPath, workDir })
      } else {
        await copyFile(finalRawPath, outputPath)
      }
    } catch (e) {
      console.warn('[render][edit] caption pass failed, using raw:', e?.message ?? e)
      await copyFile(rawPath, outputPath)
    }
  } else {
    await copyFile(rawPath, outputPath)
  }

  // Pass 3 (v22): overlay imágenes IA en momentos clave detectados por LLM.
  // Flow: Claude Haiku analiza el transcript → identifica hasta 5 momentos visuales
  // → Kie nano-banana-2 genera las imágenes en paralelo → overlay fullscreen 0.85 opacidad.
  //
  // TODO arquitectural (Javier 2026-05-18): hoy disparamos por style==='commercial'.
  // Próximamente el dashboard tendrá multi-empresa (Creator/Pro tier) y el trigger
  // será "el cliente eligió una empresa para este render" (manifest.selectedCompany).
  // El prompt del LLM va a poder incluir el contexto de la empresa (industria, brand).
  const aiImagesEnabled =
    manifest?.aiImages !== 'off' &&
    manifest?.style === 'commercial' &&
    words.length > 0 &&
    Boolean(process.env.ANTHROPIC_API_KEY) &&
    Boolean(process.env.KIE_AI_API_KEY)
  if (aiImagesEnabled) {
    try {
      console.log('[render][edit] pass 3: detecting key moments for AI images...')
      const moments = await detectKeyMoments(words, process.env.ANTHROPIC_API_KEY, {
        maxMoments: 5,
      })
      if (moments.length > 0) {
        console.log(`[render][edit] generating ${moments.length} AI images in parallel...`)
        const generated = await generateImagesForMomentsParallel(moments, workDir)
        const ok = generated.filter((g) => g.success && g.imagePath)
        if (ok.length > 0) {
          console.log(`[render][edit] pass 3: overlaying ${ok.length} AI images on output.mp4...`)
          const withImagesPath = path.join(workDir, 'output_with_images.mp4')
          const inputs3 = [`-i ${q(outputPath)}`]
          const fc3 = []
          let lastLabel = '[0:v]'
          ok.forEach((g, i) => {
            inputs3.push(`-i ${q(g.imagePath)}`)
            // Scale 9:16 fullscreen + alpha 0.85 (yuva420p para soportar alpha)
            fc3.push(
              `[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
                `format=yuva420p,colorchannelmixer=aa=0.85[img${i}]`,
            )
            const nextLabel = `[v${i}]`
            fc3.push(
              `${lastLabel}[img${i}]overlay=enable='between(t,${g.startSec.toFixed(2)},${g.endSec.toFixed(2)})':x=0:y=0${nextLabel}`,
            )
            lastLabel = nextLabel
          })
          const cmd3 = [
            'ffmpeg -y',
            inputs3.join(' '),
            `-filter_complex "${fc3.join('; ')}"`,
            `-map "${lastLabel}"`,
            `-map "0:a"`,
            '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p',
            '-crf 26 -preset fast',
            '-c:a copy',
            '-movflags +faststart',
            q(withImagesPath),
          ].join(' ')
          console.log('[render][edit] pass 3 cmd (300):', cmd3.slice(0, 300))
          await execAsync(cmd3, { maxBuffer: 300 * 1024 * 1024, timeout: 300_000 })
          await copyFile(withImagesPath, outputPath)
          console.log('[render][edit] pass 3 done — AI images applied')
        }
      } else {
        console.log('[render][edit] pass 3 skipped: LLM returned 0 moments')
      }
    } catch (e) {
      console.warn(
        `[render][edit] pass 3 (AI images) FAILED, keeping clean output: ${e?.message ?? e}`,
      )
    }
  }

  // Stats finales: cuanto cortamos por categoria, duracion original vs final.
  // Se devuelven adjuntos al outputPath para que server.js los pase al callback.
  const finalDur = await getMediaDuration(outputPath)
  const stats = {
    original_dur_sec: round2(originalConcatDur),
    final_dur_sec: round2(finalDur),
    total_removed_sec: round2(originalConcatDur - finalDur),
    silence_removed_sec: round2(silenceRemovedSec),
    silence_clips_affected: silenceClipsAffected,
    content_removed_sec: round2(contentRemovedSec),
    cuts_by_reason: contentBreakdown,
  }
  console.log(`[render][edit] stats: ${JSON.stringify(stats)}`)
  return { outputPath, stats }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Convierte un array de ranges con `reason` en counts agrupados por categoria.
 * Ej: [{reason:'filler:eh'},{reason:'filler:este'},{reason:'prolonged:y_0.88s'}]
 *  → {filler: 2, prolonged: 1}
 */
function rangesToBreakdown(ranges) {
  const counts = {}
  for (const r of ranges) {
    const cat = (r.reason || 'unknown').split(':')[0]
    counts[cat] = (counts[cat] ?? 0) + 1
  }
  return counts
}

// ──────────────────────────────────────────────────────────────────────────────
// Content trim pass — corta muletillas, repeticiones, trabazones (determinista)
// + comienzos titubeantes y tomas falsas (LLM). Re-encode + re-transcribe.
// Devuelve { path, words } actualizados, o el input intacto si nada que cortar.
// ──────────────────────────────────────────────────────────────────────────────
async function applyContentTrim({ rawPath, words, workDir, anthropicKey, lang, openaiKey }) {
  // 1. Detección determinista: muletillas + repeticiones + trabazones + prolonged
  const det = detectFillerRanges(words, { lang })
  // 1b. Detección determinista: palabra-puente entre clips (Javier: "debe ir
  //     SOLA, quitala de una de las dos versiones"). Garantía via código.
  const bridge = detectClipBridgeRepetitions(words)
  // 2. Detección LLM: tomas falsas explícitas + repeticiones reformuladas
  const llmRanges = await llmDetectFalseStartsAndRetakes(words, anthropicKey)
  const allRanges = mergeRanges([...det.ranges, ...bridge.ranges, ...llmRanges])

  if (allRanges.length === 0) {
    console.log('[content-trim] no ranges to cut, keeping raw')
    return { path: rawPath, words, removedSec: 0, ranges: [] }
  }

  const totalDur = await getMediaDuration(rawPath)
  const keepExpr = buildKeepFilter(allRanges, totalDur)
  if (!keepExpr) {
    console.warn('[content-trim] empty keep filter, keeping raw')
    return { path: rawPath, words, removedSec: 0, ranges: [] }
  }

  const trimmedPath = path.join(workDir, 'content_trimmed.mp4')
  const cmd = [
    'ffmpeg -y -hide_banner',
    `-i ${q(rawPath)}`,
    `-vf "select='${keepExpr}',setpts=N/FRAME_RATE/TB"`,
    `-af "aselect='${keepExpr}',asetpts=N/SR/TB"`,
    // veryfast en lugar de fast: ~40% mas rapido este pass. Calidad
    // marginalmente menor pero imperceptible para Reels (CRF 26 compensa).
    '-c:v libx264 -crf 26 -preset veryfast -pix_fmt yuv420p',
    '-c:a aac -b:a 192k',
    q(trimmedPath),
  ].join(' ')

  const removedSec = allRanges.reduce((acc, r) => acc + (r.end - r.start), 0)
  const detStr = Object.entries(det.counts)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')
  const bridgeStr = Object.entries(bridge.counts)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')
  console.log(
    `[content-trim] cutting ${allRanges.length} ranges = ${removedSec.toFixed(2)}s ` +
      `(deterministic: ${detStr || 'none'}, bridge: ${bridgeStr || 'none'}, llm: ${llmRanges.length})`,
  )

  try {
    await execAsync(cmd, { maxBuffer: 300 * 1024 * 1024, timeout: 600_000 })
  } catch (e) {
    console.warn('[content-trim] ffmpeg select failed, keeping raw:', e?.message ?? e)
    return { path: rawPath, words, removedSec: 0, ranges: [] }
  }

  // OPTIMIZACION (v12): ajustar timestamps de las palabras manualmente en JS
  // en lugar de re-transcribir con Whisper. Ahorra 1 Whisper API call (~30-60s)
  // + 1 ffmpeg extract audio (~5s). Equivalente exacto: para cada palabra
  // original, si cae dentro de un rango cortado se descarta; si está después,
  // se le resta el offset acumulado de cortes previos.
  const adjustedWords = adjustWordTimestamps(words, allRanges)
  console.log(
    `[content-trim] adjusted timestamps in JS: ${adjustedWords.length} words ` +
      `(was ${words.length}, dropped ${words.length - adjustedWords.length}) — no Whisper retry`,
  )
  return { path: trimmedPath, words: adjustedWords, removedSec, ranges: allRanges }
}

/**
 * Ajusta los timestamps de las palabras de Whisper después de aplicar cortes
 * con ffmpeg select+setpts. Replica matemáticamente lo que ffmpeg hace al
 * comprimir la timeline: cada cut quita (end - start) segundos del eje t.
 *
 * - Si una palabra está dentro de un cut → descartada (su audio se elimina)
 * - Si una palabra está después de un cut → sus timestamps bajan por la suma
 *   de duraciones de cuts previos
 * - Si una palabra cruza un cut (raro porque cuts caen entre palabras) → descartada
 */
function adjustWordTimestamps(words, cutRanges) {
  const cuts = [...cutRanges].sort((a, b) => a.start - b.start)
  const result = []
  for (const w of words) {
    let offset = 0
    let drop = false
    for (const cut of cuts) {
      if (cut.end <= w.start) {
        // Cut está completamente antes de la palabra: acumular offset
        offset += cut.end - cut.start
      } else if (cut.start >= w.end) {
        // Cut está completamente después: no afecta
        break
      } else {
        // Overlap: la palabra cae total o parcialmente dentro del cut
        drop = true
        break
      }
    }
    if (!drop) {
      result.push({
        word: w.word,
        start: Math.max(0, w.start - offset),
        end: Math.max(0, w.end - offset),
      })
    }
  }
  return result
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
