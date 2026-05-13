// MVP render pipeline for the worker.
// Replicates the core of mackree-ai's /api/generate/render/route.ts but
// reads from a local work dir (populated by storage.downloadJobAssets) and
// emits output.mp4 in the same dir.
//
// MVP scope (today): concat media segments + voice + optional music + ASS
// captions in a second pass. Advanced effects from the original endpoint
// (glitch intro, watermark, outro flash, blur_bg, timelapse speed) are
// TODO — they live in commits after this file is wired up end-to-end.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const execAsync = promisify(exec)

const W = 1080
const H = 1920
const FPS = 30

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

async function transcribeWords(voicePath, openaiKey) {
  if (!openaiKey) return []
  try {
    const audio = await readFile(voicePath)
    const form = new FormData()
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3')
    form.append('model', 'whisper-1')
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.words ?? [])
      .map((w) => ({
        word: w.word.replace(/[^\w\sáéíóúñüÁÉÍÓÚÑÜ¿?¡!,.:;]/g, '').trim(),
        start: w.start,
        end: w.end,
      }))
      .filter((w) => w.word.length > 0)
  } catch {
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
      return { filePath: path.join(workDir, e), type }
    })
}

/**
 * Run the render pipeline against a populated work dir.
 * Expects voice.mp3 + media_*.{ext} (+ optional music.mp3 + job.json).
 * Returns the path to the resulting output.mp4.
 */
export async function renderJob({ workDir, openaiKey }) {
  const voicePath = path.join(workDir, 'voice.mp3')
  const voiceDur = await getMediaDuration(voicePath)
  const mediaItems = await findMediaItems(workDir)

  const n = Math.max(1, mediaItems.length)
  const segDur = voiceDur / n

  // ── Build filter_complex ────────────────────────────────────────────────
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
      inputs.push(`-i ${q(item.filePath)}`)
      fc.push(
        `[${idx}:v]trim=0:${(segDur * 1.05).toFixed(2)},setpts=PTS-STARTPTS,` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[seg_${label}]`,
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
  fc.push(`${concatIn}concat=n=${segLabels.length}:v=1:a=0[vfinal]`)

  // Voice
  const voiceIdx = idx
  inputs.push(`-i ${q(voicePath)}`)
  idx++
  fc.push(`[${voiceIdx}:a]apad,atrim=0:${voiceDur.toFixed(2)},asetpts=PTS-STARTPTS,volume=1.3[narr]`)

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

  // ── Pass 1: raw render ──────────────────────────────────────────────────
  const rawPath = path.join(workDir, 'raw.mp4')
  const cmd1 = [
    'ffmpeg -y',
    inputs.join(' '),
    `-filter_complex "${fc.join('; ')}"`,
    `-map "[vfinal]"`,
    `-map "[aout]"`,
    '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p',
    '-crf 20 -preset fast',
    '-c:a aac -b:a 192k -movflags +faststart',
    `-t ${voiceDur.toFixed(2)}`,
    q(rawPath),
  ].join(' ')

  console.log('[render] pass 1 cmd (300):', cmd1.slice(0, 300))
  await execAsync(cmd1, { maxBuffer: 300 * 1024 * 1024, timeout: 600_000 })

  // ── Pass 2: burn ASS captions (graceful fallback if Whisper fails) ───────
  const outputPath = path.join(workDir, 'output.mp4')
  const words = await transcribeWords(voicePath, openaiKey)

  if (words.length > 0) {
    const captionsPath = path.join(workDir, 'captions.ass')
    await writeFile(captionsPath, buildASS(words), 'utf8')
    const escaped = ffmpegAssPath(captionsPath)
    const cmd2 = [
      'ffmpeg -y',
      `-i ${q(rawPath)}`,
      `-vf "ass='${escaped}'"`,
      '-c:a copy -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p',
      q(outputPath),
    ].join(' ')
    try {
      await execAsync(cmd2, { maxBuffer: 300 * 1024 * 1024, timeout: 600_000 })
    } catch (e) {
      console.warn('[render] captions burn failed, using raw:', e?.message ?? e)
      await copyFile(rawPath, outputPath)
    }
  } else {
    await copyFile(rawPath, outputPath)
  }

  return outputPath
}
