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
import { detectWordGaps } from './wordGaps.js'
import {
  generateMusicFromPrompt,
  downloadMusicTo,
  buildMusicPromptFromManifest,
} from './kie-music.js'
import { generateImagesForMomentsParallel } from './kie-image.js'
import { generateVideoClipsParallel } from './kie-video.js'
import { detectKeyMoments, detectScriptScenes } from './llm-moments.js'
import { orderResourcesByNarration } from './llm-resource-sync.js'
import { describeTheme } from './llm-theme-context.js'
import { generateContactIllustration, normalizeContactKind } from './contact-illustration.js'
import { detectSFXMoments, pickRandomSFXFile } from './llm-sfx.js'
import { resolveSubtitleStyle } from './subtitle-styles.js'
import { addIntroOutro, BRANDING_OVERHEAD } from './intro-outro.js'

const execAsync = promisify(exec)

// WS4 (2026-06-14): el lienzo se deriva del formato del video. W/H son `let` (no const)
// porque renderJob los setea por-job desde manifest.format vía dimsForFormat(). Mutarlos a
// nivel módulo es SEGURO porque server.js serializa los renders (semáforo de 1 a la vez,
// inamovible #1 v30) → nunca corren 2 jobs en paralelo. Todo el pipeline ya usa ${W}/${H}
// (scale/crop, Ken Burns, PlayResX/Y de captions, fondo, intro/outro y contacto reciben {W,H}).
let W = 1080
let H = 1920
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

// WS7 (2026-06-07; techo ESTRICTO sobre el video final 2026-06-10): ajusta la VOZ
// para que el VIDEO FINAL respete la duración elegida. Reglas de Javier: PISO DURO =
// target (el video NUNCA dura menos), techo ESTRICTO = target+4 (NUNCA más). Como la
// voz es el master de duración de renderCreate, ajustar la voz ajusta el video entero
// — sin tocar las ~10 referencias a voiceDur del pipeline.
//
// CLAVE (fix 2026-06-10): el branding (intro 1.8s + outro 1.5s = 3.3s) se SUMA después
// vía addIntroOutro. Antes el techo target+4 se medía sobre la VOZ → el video final
// salía hasta target+7.3 (ej. 50→57s, reportado por Javier). Ahora el piso/techo se
// calculan sobre el video FINAL: se descuenta `overheadSec` (branding) del objetivo de
// la voz, así  final = voz + overhead  cae estrictamente en [target, target+4].
//   - effTarget = target - overhead (piso de la voz);  effHi = effTarget + 4 (techo)
//   - voz > effHi    → acelerar con atempo, tope 1.10x (CALIDAD; preserva el tono).
//   - voz < effTarget→ extender con silencio al final (apad) hasta effTarget.
//   - voz ∈ [effTarget, effHi] → no se toca (voz natural, calidad máxima).
// Si target inválido (0) → no toca nada (back-compat con jobs sin duration).
async function adjustVoiceToTarget(voicePath, voiceDur, targetSec, workDir, overheadSec = 0) {
  if (!targetSec || targetSec <= 0) return { path: voicePath, dur: voiceDur }
  // Objetivo efectivo de la VOZ = target final menos el overhead del branding.
  // Clamp a >=1s para targets muy chicos (no debería pasar; el SaaS pide >=15s).
  const effTarget = Math.max(1, targetSec - overheadSec)
  const hi = effTarget + 4
  const out = path.join(workDir, 'voice_adj.mp3')
  try {
    if (voiceDur > hi) {
      const factor = Math.min(1.10, voiceDur / hi)   // tope 1.10x = calidad (Javier)
      await execAsync(
        `ffmpeg -y -i ${q(voicePath)} -filter:a "atempo=${factor.toFixed(4)}" -c:a libmp3lame -q:a 2 ${q(out)}`,
        { timeout: 60_000 },
      )
      const d = await getMediaDuration(out)
      console.log(`[render][create] WS7 voz ${voiceDur.toFixed(1)}s > effHi ${hi.toFixed(1)}s (target ${targetSec}s − branding ${overheadSec.toFixed(1)}s) → atempo ${factor.toFixed(3)}x → ${d.toFixed(1)}s · video final ≈ ${(d + overheadSec).toFixed(1)}s`)
      return { path: out, dur: d }
    }
    if (voiceDur < effTarget) {
      await execAsync(
        `ffmpeg -y -i ${q(voicePath)} -af "apad=whole_dur=${effTarget.toFixed(2)}" -c:a libmp3lame -q:a 2 ${q(out)}`,
        { timeout: 60_000 },
      )
      const d = await getMediaDuration(out)
      console.log(`[render][create] WS7 voz ${voiceDur.toFixed(1)}s < effTarget ${effTarget.toFixed(1)}s → apad → ${d.toFixed(1)}s · video final ≈ ${(d + overheadSec).toFixed(1)}s`)
      return { path: out, dur: d }
    }
    console.log(`[render][create] WS7 voz ${voiceDur.toFixed(1)}s ∈ [${effTarget.toFixed(1)},${hi.toFixed(1)}] → sin ajuste · video final ≈ ${(voiceDur + overheadSec).toFixed(1)}s`)
    return { path: voicePath, dur: voiceDur }
  } catch (e) {
    console.warn(`[render][create] WS7 ajuste de voz falló, sigo sin ajustar: ${e?.message ?? e}`)
    return { path: voicePath, dur: voiceDur }
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

// Texto del badge de contacto según el tipo. El teléfono lleva el prefijo "WhatsApp"
// (look original); correo y web se muestran tal cual (la web sin http:// ni / final).
function formatContactCta(c) {
  const v = String(c.value).trim()
  if (c.kind === 'phone')   return `WhatsApp  ${v}`
  if (c.kind === 'website') return v.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return v   // email (u otro): tal cual
}

// Genera ASS karaoke con el ESTILO elegido (manifest.subtitleStyle). Captions siempre
// on (inamovible); solo cambia el look. styleKey ausente/ inválido → 'classic' (= look
// actual exacto, cero regresión). Catálogo en lib/subtitle-styles.js (aprobado Javier).
function buildASS(words, styleKey, contactCtas) {
  const s = resolveSubtitleStyle(styleKey)
  const CHUNK = s.chunk
  const hasContacts = Array.isArray(contactCtas) && contactCtas.length > 0
  const styleLines = [
    `Style: Default,${s.font},${s.size},${s.primary},&H000000FF,${s.outline},${s.back},${s.bold},0,0,0,100,100,0,0,${s.borderStyle},${s.ol},${s.sh},${s.align},${s.mL},${s.mR},${s.mv},1`,
  ]
  // CTA de contacto (regla de marca): caja verde + dato, animada (fade + slide-up),
  // cuando el video menciona el contacto. Verde WhatsApp #25D366 = &H0066D325 (BGR).
  // Puede haber hasta 3 (correo/teléfono/web) apilados según el checklist del cliente.
  if (hasContacts) {
    styleLines.push(
      `Style: WA,Liberation Sans,60,&H00FFFFFF,&H000000FF,&H0066D325,&H64000000,-1,0,0,0,100,100,0,0,3,24,6,5,40,40,0,1`,
    )
  }
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 1',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const lines = [header]
  if (hasContacts) {
    const x = Math.round(W / 2)
    const gap = Math.round(H * 0.065)   // separación vertical entre badges apilados
    // i=0 es el más abajo; cada contacto siguiente sube una fila. Todos hacen
    // slide-up al aparecer (mismo gesto que el badge único original).
    for (let i = 0; i < contactCtas.length; i++) {
      const c = contactCtas[i]
      const y1 = Math.round(H * 0.90) - i * gap
      const y2 = Math.round(H * 0.73) - i * gap
      lines.push(
        `Dialogue: 1,${sToASS(c.startSec)},${sToASS(c.endSec)},WA,,0,0,0,,{\\fad(350,350)\\move(${x},${y1},${x},${y2})}${c.text}`,
      )
    }
  }
  for (let i = 0; i < words.length; i++) {
    const cs = Math.floor(i / CHUNK) * CHUNK
    const chunk = words.slice(cs, cs + CHUNK)
    const pos = i - cs
    const text = chunk
      .map((w, ci) => {
        const isActive = ci === pos
        // active=null → resaltar con negrita en vez de color (estilo minimal)
        if (isActive && s.active === null) return `{\\b1}${w.word}{\\b0}`
        return `{\\c${isActive ? s.active : s.primary}&}${w.word}`
      })
      .join(' ')
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

// Ken Burns (zoom/pan) para segmentos de IMAGEN — INAMOVIBLE #17 (Javier 2026-05-23):
// las imágenes/doodles NUNCA salen estáticas; siempre llevan movimiento sutil (estilo
// Santiago). Pre-escala 2x antes del zoompan para suavizar (evita jitter conocido).
// `variant` rota por índice para dar variedad. Expresiones validadas con ffmpeg local
// (zoom 1.0→1.12 / pan horizontal usando `on`). Devuelve la cadena [src]→[out].
function imageMotionChain(srcLabel, outLabel, segDur, variant) {
  const N = Math.max(1, Math.round(segDur * FPS))
  const pre = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`
  const yC = 'ih/2-(ih/zoom/2)'
  let zp
  if (variant === 'pan_right') {
    zp = `zoompan=z='1.12':x='(iw-iw/zoom)*on/${N}':y='${yC}':d=${N}:s=${W}x${H}:fps=${FPS}`
  } else if (variant === 'pan_left') {
    zp = `zoompan=z='1.12':x='(iw-iw/zoom)*(${N}-on)/${N}':y='${yC}':d=${N}:s=${W}x${H}:fps=${FPS}`
  } else {
    // zoom_in (default): paso = 0.12/N para llegar a 1.12 al final, sin importar segDur
    const step = (0.12 / N).toFixed(6)
    zp = `zoompan=z='min(zoom+${step},1.12)':x='iw/2-(iw/zoom/2)':y='${yC}':d=${N}:s=${W}x${H}:fps=${FPS}`
  }
  return `${srcLabel}${pre},${zp},trim=duration=${segDur.toFixed(2)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p${outLabel}`
}

// ──────────────────────────────────────────────────────────────────────────────
// CREATE MODE  (voice.mp3 master)
// ──────────────────────────────────────────────────────────────────────────────
// Mapea el formato del video (manifest.format) al aspect ratio que espera kie-image.
function formatToAspect(format) {
  if (format === '1:1') return '1:1'
  if (format === '16:9') return '16:9'
  return '9:16'
}

// WS4: dimensiones del lienzo final según el formato elegido. Cada clip/imagen se
// RE-ENCUADRA desde la fuente a este lienzo (scale+crop), NO se recorta un mp4 ya hecho.
function dimsForFormat(format) {
  if (format === '1:1')  return { W: 1080, H: 1080 }
  if (format === '16:9') return { W: 1920, H: 1080 }
  return { W: 1080, H: 1920 }   // 9:16 (default, retrato Reels/TikTok/Shorts)
}

// OPCIÓN 3 (generate_full_ai): genera el LIENZO del video con IA ANTES del pass 1.
// El cliente NO sube footage — solo una descripción. Acá: transcribe la voz (para
// alinear las escenas con la narración) → divide el guión en N escenas consecutivas
// → genera N ilustraciones full-frame en el estilo elegido → las renombra a media_*.jpg.
// A partir de ahí el resto del pipeline (Ken Burns, xfade, captions, música, SFX,
// intro/outro) corre IDÉNTICO, tratándolas como si fueran media del cliente.
// Graceful TOTAL: si una imagen falla se omite; si fallan todas o no hay key/escenas →
// 0 media → renderCreate cae al fondo negro existente (piso aceptable, con warning).
// Devuelve los `words` ya transcritos para reutilizarlos en el pass 2 (evita doble Whisper).
async function generateCanvasImages({ workDir, voicePath, voiceDur, manifest, openaiKey }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const kieKey = process.env.KIE_AI_API_KEY
  if (!anthropicKey || !kieKey) {
    console.warn('[render][full-ai] missing ANTHROPIC/KIE key — cannot generate canvas, fallback to black bg')
    return { words: [] }
  }
  // 1. Transcribir la voz → escenas alineadas a la narración (se reusa en pass 2).
  const words = await transcribeWords(voicePath, openaiKey)
  // 2. Densidad: ~1 imagen cada 7s, mínimo 2, tope 12 (acota costo Kie + tiempo).
  const targetCount = Math.max(2, Math.min(12, Math.round(voiceDur / 7)))
  // 3. Dividir el guión en escenas consecutivas que cubren todo el video.
  const scenes = await detectScriptScenes(words, anthropicKey, {
    targetCount,
    totalDur: voiceDur,
    visualStyle: manifest?.visualStyle,
    description: manifest?.description,
    script: manifest?.script,
  })
  if (!scenes.length) {
    console.warn('[render][full-ai] no scenes detected — fallback to black bg')
    return { words }
  }
  // 4. Marcar escenas de acento como 'video' (apertura + reveal); resto como 'image'.
  //    Máx 2 clips de video; el resto se genera como ilustración.
  const accentIndices = new Set()
  if (scenes.length >= 1) accentIndices.add(0)                     // apertura (gancho)
  if (scenes.length >= 3) accentIndices.add(scenes.length - 1)     // reveal final
  const aspectRatio = formatToAspect(manifest?.format)

  // 4a. Generar clips de video para las escenas de acento (en paralelo).
  const videoScenes = scenes.filter((_, i) => accentIndices.has(i))
  const imageScenes = scenes.filter((_, i) => !accentIndices.has(i))

  console.log(`[render][full-ai] generating ${videoScenes.length} accent video clips + ${imageScenes.length} images (style "${manifest?.visualStyle || 'doodle'}")...`)

  const [videoResults, imageResults] = await Promise.all([
    // Video clips — realistas cinematográficos (NO usan el estilo de ilustración)
    kieKey && videoScenes.length > 0
      ? generateVideoClipsParallel(videoScenes, workDir, { apiKey: kieKey, aspectRatio })
      : Promise.resolve([]),
    // Imágenes — estilo elegido por el usuario
    generateImagesForMomentsParallel(imageScenes, workDir, {
      visualStyle: manifest?.visualStyle,
      aspectRatio,
    }),
  ])

  // 4b. Armar lista de media en ORDEN NARRATIVO (orden original de scenes).
  //     Clips de video → ai_video_N.mp4; imágenes → ai_image_N.jpg (ya en workdir).
  //     Si un clip de video falla, lo reemplazamos con imagen fallback (graceful).
  let mediaSeq = []
  let vIdx = 0; let imgIdx = 0
  for (let i = 0; i < scenes.length; i++) {
    if (accentIndices.has(i)) {
      const vr = videoResults[vIdx++]
      if (vr?.success) { mediaSeq.push({ type: 'video', path: vr.clipPath }) }
      else {
        // Fallback: generar imagen para esa escena
        console.warn(`[render][full-ai] video clip ${i} failed — generating image fallback`)
        const fb = await generateImagesForMomentsParallel([scenes[i]], workDir, { visualStyle: manifest?.visualStyle, aspectRatio })
        if (fb[0]?.success) mediaSeq.push({ type: 'image', path: fb[0].imagePath })
      }
    } else {
      const ir = imageResults[imgIdx++]
      if (ir?.success && ir.imagePath) mediaSeq.push({ type: 'image', path: ir.imagePath })
    }
  }

  // 5. Renombrar a media_01.{ext}, media_02.{ext}, ... (orden narrativo).
  let n = 0
  for (const m of mediaSeq) {
    n++
    const ext = m.type === 'video' ? 'mp4' : 'jpg'
    const dest = path.join(workDir, `media_${String(n).padStart(2, '0')}.${ext}`)
    await copyFile(m.path, dest)
  }
  console.log(`[render][full-ai] canvas ready: ${n}/${scenes.length} media (${videoResults.filter(v=>v?.success).length} clips + ${imageResults.filter(i=>i?.success).length} images) → media_*.{mp4,jpg}`)
  return { words }
}

async function renderCreate({ workDir, openaiKey, manifest }) {
  let voicePath = path.join(workDir, 'voice.mp3')
  let voiceDur = await getMediaDuration(voicePath)

  // WS7: respetar la duración elegida. Ajusta la voz (master de duración) ANTES de
  // todo el pipeline → afecta a "editar video con voz" Y a "generar con IA" (ambos
  // pasan por renderCreate). renderEdit (footage + voz propia) NO se toca.
  {
    const targetSec = parseInt(manifest?.duration, 10) || 0
    // El branding (intro+outro) se suma DESPUÉS solo si hay logo (mismo gate que
    // addIntroOutro). Se descuenta del objetivo de la voz para que el video FINAL
    // respete el techo estricto target+4.
    const overheadSec = manifest?.brandLogoUrl ? BRANDING_OVERHEAD : 0
    const adj = await adjustVoiceToTarget(voicePath, voiceDur, targetSec, workDir, overheadSec)
    voicePath = adj.path
    voiceDur = adj.dur
  }

  // OPCIÓN 3 (generate_full_ai): si no hay footage, la IA genera el lienzo ANTES del
  // pass 1. Gateado por manifest.generateMedia === true (ausente en los flujos actuales
  // → cero impacto sobre ellos). Reusa el transcript para los captions del pass 2.
  let preWords = null
  if (manifest?.generateMedia === true) {
    const r = await generateCanvasImages({ workDir, voicePath, voiceDur, manifest, openaiKey })
    preWords = r.words
  }

  const mediaItems = await findMediaItems(workDir)

  const n = Math.max(1, mediaItems.length)
  // INAMOVIBLE #18 (Javier 2026-05-23): transiciones automáticas (xfade cross-dissolve
  // 0.35s) entre segmentos. Para que el video dure EXACTAMENTE igual que la voz pese al
  // solapamiento, cada segmento se alarga a segDurEff = (voiceDur+(N-1)*D)/N; tras el fold
  // de xfade el total vuelve a voiceDur. Solo create mode; fallback a corte duro si xfade
  // falla o si los segmentos son demasiado cortos. Off con manifest.transitions:'off'.
  const XFADE_DUR = 0.35
  const wantXfade = n >= 2 && manifest?.transitions !== 'off'
  const segDur = voiceDur / n
  const segDurEff = wantXfade ? (voiceDur + (n - 1) * XFADE_DUR) / n : segDur

  // Brand logo (top-right watermark) — null si el user no subió logo
  const logoPath = await downloadBrandLogo(manifest?.brandLogoUrl, workDir)
  console.log(`[render][create] brand logo: ${logoPath ? 'yes' : 'none'}`)

  const inputs = []
  const fc = []
  let idx = 0
  const segLabels = []

  // SINCRONIZACIÓN (universal, inamovible backend): reordenar los recursos del
  // cliente para que cada uno caiga donde la narración habla de algo relacionado
  // ("que la imagen concuerde con lo que se dice"). La IA mira cada recurso (Vision)
  // + el guión y devuelve la permutación. Fallback TOTAL: si falla → orden original
  // (cero regresión). Opt-out técnico: manifest.resourceSync === 'off'.
  let orderedMedia = mediaItems
  // En Opción 3 (generateMedia) las imágenes YA vienen en orden narrativo desde
  // detectScriptScenes — no hay nada que reordenar, se salta el resource-sync.
  if (manifest?.resourceSync !== 'off' && manifest?.generateMedia !== true && mediaItems.length >= 2) {
    try {
      const order = await orderResourcesByNarration(mediaItems, manifest?.script, process.env.ANTHROPIC_API_KEY, workDir)
      if (order) orderedMedia = order.map((k) => mediaItems[k])
    } catch (e) { console.warn('[render][create] resource sync error:', e?.message ?? e) }
  }

  for (let i = 0; i < orderedMedia.length; i++) {
    const item = orderedMedia[i]
    const label = `s${i}`
    segLabels.push(label)

    if (item.type === 'image') {
      // INAMOVIBLE #17: imágenes con Ken Burns (zoom/pan), nunca estáticas. variant rota.
      const variant = ['zoom_in', 'pan_right', 'pan_left'][i % 3]
      inputs.push(`-loop 1 -t ${(segDurEff + 1).toFixed(2)} -i ${q(item.filePath)}`)
      fc.push(imageMotionChain(`[${idx}:v]`, `[seg_${label}]`, segDurEff, variant))
    } else {
      // VIDEO CHAIN — dos sub-casos:
      //   A) Clip IA generado (manifest.generateMedia && nombre media_NN.mp4):
      //      Ya tiene la duración correcta y movimiento real → NO timelapse, NO deshake.
      //      Solo scale/crop + suave eq de color + trim exacto al slot.
      //   B) Clip del cliente (subido): INAMOVIBLE #16 timelapse REAL + deshake.
      const isGeneratedClip = manifest?.generateMedia === true && /^media_\d+\.mp4$/.test(item.name ?? '')

      let origDur = 0
      try { origDur = await getMediaDuration(item.filePath) } catch { origDur = 0 }

      inputs.push(`-i ${q(item.filePath)}`)
      if (isGeneratedClip) {
        // Clip IA: reproducir a velocidad nativa, trim exacto al slot, sin timelapse ni deshake agresivo.
        const speed = Math.min(2, Math.max(0.5, origDur > 0 ? origDur / segDurEff : 1))
        console.log(`[render][create] AI clip ${item.name}: orig=${origDur.toFixed(1)}s slot=${segDurEff.toFixed(1)}s speed=${speed.toFixed(2)}x (generated, no timelapse)`)
        fc.push(
          `[${idx}:v]setpts=(PTS-STARTPTS)/${speed.toFixed(4)},trim=0:${segDurEff.toFixed(2)},setpts=PTS-STARTPTS,` +
            `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,` +
            `eq=contrast=1.03:saturation=1.05:gamma=0.99,` +
            `format=yuv420p[seg_${label}]`,
        )
      } else {
        // Clip cliente: timelapse REAL + deshake + unsharp + eq (inamovible #16)
        const tlSpeed = Math.min(60, Math.max(1, origDur / segDurEff || 1))
        console.log(`[render][create] timelapse ${item.name}: orig=${origDur.toFixed(1)}s slot=${segDurEff.toFixed(1)}s → ${tlSpeed.toFixed(1)}x`)
        fc.push(
          `[${idx}:v]setpts=(PTS-STARTPTS)/${tlSpeed.toFixed(4)},trim=0:${segDurEff.toFixed(2)},setpts=PTS-STARTPTS,` +
            `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,` +
            `deshake=rx=16:ry=16,` +
            `unsharp=5:5:0.6:5:5:0.0,` +
            `eq=contrast=1.05:saturation=1.08:gamma=0.98,` +
            `format=yuv420p[seg_${label}]`,
        )
      }
    }
    idx++
  }

  if (mediaItems.length === 0) {
    inputs.push(`-f lavfi -t ${voiceDur.toFixed(2)} -i color=black:s=${W}x${H}:r=${FPS}`)
    fc.push(`[${idx}:v]setsar=1,format=yuv420p[seg_s0]`)
    segLabels.push('s0')
    idx++
  }

  // El video-combine ([seg_*] → [vconcat]) se appendea al FINAL del filter_complex
  // (xfade con transiciones, o concat duro de fallback). ffmpeg resuelve el grafo por
  // labels, así que el orden de declaración no importa — ver buildCmd más abajo.

  // Voice — volume boost + loudnorm para audio limpio y consistente
  const voiceIdx = idx
  inputs.push(`-i ${q(voicePath)}`)
  idx++
  fc.push(
    `[${voiceIdx}:a]apad,atrim=0:${voiceDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
      `volume=1.45,loudnorm=I=-16:LRA=11:TP=-1.5[narr]`,
  )

  // Optional music — genera con Kie Suno si el cliente eligió un género y NO hay
  // music.mp3 subido. BUGFIX 2026-05-23 (Javier): antes renderCreate SOLO leía un
  // music.mp3 que en este flujo NADIE sube → el video de "Crear con voz" SIEMPRE
  // salía sin música, aunque el cliente eligiera (p.ej. electrónica). Portado de
  // renderEdit. El género viaja en manifest.music y buildMusicPromptFromManifest
  // lo mapea (electronic→EDM, urban→trap, etc.). Fallback graceful si Kie falla.
  const musicPath = path.join(workDir, 'music.mp3')
  let hasMusic = false
  try {
    await readFile(musicPath)
    hasMusic = true
  } catch {
    const musicVal = String(manifest?.music ?? '').toLowerCase()
    // 'none' = sin música; 'custom' = el usuario subió su propia → ya en workdir (descargado por downloadJobAssets)
    const wantMusic = manifest?.music && musicVal !== 'none' && musicVal !== 'custom'
    if (wantMusic) {
      try {
        const prompt = buildMusicPromptFromManifest(manifest)
        console.log(`[render][create] generating music via Kie Suno V5: "${prompt.slice(0, 120)}..."`)
        const { audioUrl, duration: musicDur } = await generateMusicFromPrompt(prompt, {
          model: 'V5',
          instrumental: true,
        })
        await downloadMusicTo(audioUrl, musicPath)
        hasMusic = true
        console.log(`[render][create] Kie music ready (${musicDur}s) → music.mp3`)
      } catch (e) {
        console.warn(
          `[render][create] Kie music generation FAILED, rendering without music: ${e?.message ?? e}`,
        )
        hasMusic = false
      }
    }
  }

  // v45 (Javier 2026-05-24 "voz más alta, música más baja"): commercial 0.09 / personal 0.17.
  // La voz (narr) subió a 1.45. Trayectoria comercial: v27=0.06 → v29=0.12 → v45=0.09.
  const isCommercial = (manifest?.style ?? 'commercial') === 'commercial'
  const musicVol = isCommercial ? 0.09 : 0.17

  const audioLabels = ['[narr]']
  if (hasMusic) {
    const musicIdx = idx
    const musicOffset = Math.max(0, Number(manifest?.musicOffsetSec) || 0)   // WS10: parte elegida de la canción propia
    inputs.push(`${musicOffset > 0 ? `-ss ${musicOffset.toFixed(2)} ` : ''}-i ${q(musicPath)}`)
    idx++
    fc.push(
      `[${musicIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${voiceDur.toFixed(2)},asetpts=PTS-STARTPTS,volume=${musicVol},` +
        `afade=t=out:st=${Math.max(0, voiceDur - 1.5).toFixed(2)}:d=1.5[music]`,
    )
    audioLabels.push('[music]')
  }

  if (audioLabels.length === 2) {
    fc.push(`${audioLabels.join('')}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`)
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

  // Combine de video: concat duro (fallback / N<2 / off) vs fold de xfade (transiciones).
  const concatCombine = () => {
    const concatIn = segLabels.map((l) => `[seg_${l}]`).join('')
    return [`${concatIn}concat=n=${segLabels.length}:v=1:a=0[vconcat]`]
  }
  // Fold encadenado de xfade: offset(k) = k*(segDurEff - D). Con segmentos iguales el
  // total vuelve a voiceDur exacto. Validado con ffmpeg local (offsets + duración).
  const xfadeCombine = () => {
    const lines = []
    let acc = `[seg_${segLabels[0]}]`
    for (let k = 1; k < segLabels.length; k++) {
      const off = (k * (segDurEff - XFADE_DUR)).toFixed(3)
      const out = k === segLabels.length - 1 ? '[vconcat]' : `[xf${k}]`
      lines.push(`${acc}[seg_${segLabels[k]}]xfade=transition=fade:duration=${XFADE_DUR}:offset=${off}${out}`)
      acc = out
    }
    return lines
  }
  const buildCmd = (combineLines) => [
    'ffmpeg -y',
    inputs.join(' '),
    `-filter_complex "${[...fc, ...combineLines].join('; ')}"`,
    `-map "${videoOutLabel}"`,
    `-map "[aout]"`,
    '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p',
    '-crf 26 -preset fast',
    '-c:a aac -b:a 192k -movflags +faststart',
    `-t ${voiceDur.toFixed(2)}`,
    q(rawPath),
  ].join(' ')

  const opts1 = { maxBuffer: 300 * 1024 * 1024, timeout: 900_000 }
  // Solo xfade si hay ≥2 segmentos y son lo bastante largos para la transición.
  const canXfade = wantXfade && segLabels.length >= 2 && segDurEff > XFADE_DUR + 0.1
  if (canXfade) {
    try {
      console.log(`[render][create] pass 1: ${segLabels.length - 1} transición(es) xfade ${XFADE_DUR}s`)
      await execAsync(buildCmd(xfadeCombine()), opts1)
    } catch (e) {
      console.warn(`[render][create] xfade FALLÓ, fallback a corte duro: ${e?.message ?? e}`)
      await execAsync(buildCmd(concatCombine()), opts1)
    }
  } else {
    console.log('[render][create] pass 1: corte duro (sin transiciones)')
    await execAsync(buildCmd(concatCombine()), opts1)
  }

  // Pass 2: burn ASS captions (graceful fallback if Whisper fails or captions=false)
  const outputPath = path.join(workDir, 'output.mp4')
  // INAMOVIBLE 2026-05-19 (Javier): captions SIEMPRE activadas, sin toggle off.
  // Antes leía manifest.captions; ahora ignorado. Es regla de marca del producto.
  const wantCaptions = true; void manifest?.captions
  // Opción 3: reusar el transcript que ya sacó generateCanvasImages (evita doble Whisper).
  const words = wantCaptions
    ? (preWords && preWords.length ? preWords : await transcribeWords(voicePath, openaiKey))
    : []

  // ⛔ REGLA INAMOVIBLE (Javier 2026-06-02, UNIVERSAL): los SUBTÍTULOS van SIEMPRE al
  // FRENTE — nunca tapados por las animaciones. Por eso las imágenes IA se overlayean
  // PRIMERO (sobre el video base), y los captions se queman DESPUÉS, encima de TODO.
  // (Antes el orden estaba invertido y las animaciones tapaban los subtítulos.)
  const aiImagesEnabled =
    manifest?.aiImages !== 'off' &&
    manifest?.generateMedia !== true && // Opción 3: las imágenes YA son el lienzo, no overlay
    manifest?.style === 'commercial' &&
    words.length > 0 &&
    Boolean(process.env.ANTHROPIC_API_KEY) &&
    Boolean(process.env.KIE_AI_API_KEY)

  let captionBase = rawPath   // base sobre la que se queman los captions (al final)
  if (aiImagesEnabled) {
    try {
      console.log('[render][create] AI images (BEFORE captions): detecting key moments...')
      // Anclar las ilustraciones al TEMA REAL: la IA mira los recursos del cliente
      // (footage/fotos) + la descripción y devuelve el tema ("a red food truck...").
      // Así las imágenes NO salen genéricas (fix Javier 2026-06-03). Fallback null.
      const themeContext = await describeTheme(orderedMedia, manifest?.description, process.env.ANTHROPIC_API_KEY, workDir)
      const moments = await detectKeyMoments(words, process.env.ANTHROPIC_API_KEY, {
        maxMoments: 5,
        visualStyle: manifest?.visualStyle,
        themeContext,
        description: manifest?.description,
        script: manifest?.script,
      })
      if (moments.length > 0) {
        console.log(`[render][create] generating ${moments.length} AI images in parallel...`)
        const generated = await generateImagesForMomentsParallel(moments, workDir, {
          visualStyle: manifest?.visualStyle,
          aspectRatio: '9:16', // ratio del video (Reel vertical) — animaciones simples llenan el frame
        })
        const ok = generated.filter((g) => g.success && g.imagePath)
        if (ok.length > 0) {
          console.log(`[render][create] overlaying ${ok.length} AI images on the base video...`)
          const withImagesPath = path.join(workDir, 'with_images.mp4')
          const inputs3 = [`-i ${q(rawPath)}`]   // sobre el video BASE, no sobre los captions
          const fc3 = []
          let lastLabel = '[0:v]'
          ok.forEach((g, i) => {
            inputs3.push(`-i ${q(g.imagePath)}`)
            // Ilustración IA en 9:16 (ratio del video) a PANTALLA COMPLETA. Las animaciones
            // se generan SIMPLES y verticales (ver llm-moments + styles), así llenan el frame
            // derechas sin acostarse ni recorte. (Opción 1 Javier 2026-05-24.)
            fc3.push(
              `[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
                `format=yuva420p,colorchannelmixer=aa=0.92[img${i}]`,
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
          console.log('[render][create] AI images cmd (300):', cmd3.slice(0, 300))
          await execAsync(cmd3, { maxBuffer: 300 * 1024 * 1024, timeout: 300_000 })
          captionBase = withImagesPath   // los captions se queman ENCIMA de las imágenes
          console.log('[render][create] AI images applied (before captions)')
        }
      } else {
        console.log('[render][create] AI images skipped: LLM returned 0 moments')
      }
    } catch (e) {
      console.warn(
        `[render][create] AI images FAILED, captions over clean base: ${e?.message ?? e}`,
      )
    }
  }

  // Captions SIEMPRE al FINAL → quedan encima de las imágenes IA (regla inamovible).
  if (words.length > 0) {
    await burnCaptions({ rawPath: captionBase, words, outputPath, workDir, subtitleStyle: manifest?.subtitleStyle, captionReplacements: manifest?.captionReplacements, whatsappNumber: manifest?.whatsappNumber, contacts: manifest?.contacts, visualStyle: manifest?.visualStyle })
  } else {
    await copyFile(captionBase, outputPath)
  }

  // ── PASS 4: AI-driven SFX — PORTADO desde edit mode (bugfix 2026-05-23, Javier).
  // Antes SOLO renderEdit tenía SFX; el flujo "Crear video con voz" salía SIN efectos
  // de sonido (Javier lo reportó: "no los vi por ningún lado"). Mismo gate, mismas
  // reglas profesionales de llm-sfx.js, fallback graceful. En create el totalDur es
  // voiceDur (la voz en off es el master de duración). amix duration=first + -c:v copy.
  const sfxEnabled =
    manifest?.sfx !== 'off' &&
    words.length > 0 &&
    Boolean(process.env.ANTHROPIC_API_KEY)

  if (sfxEnabled) {
    try {
      const sfxCatalogPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'sfx', 'catalog.json')
      const catalog = JSON.parse(await readFile(sfxCatalogPath, 'utf-8'))
      const sfxMoments = await detectSFXMoments(words, process.env.ANTHROPIC_API_KEY, voiceDur)

      const sfxPlacements = sfxMoments
        .map((m) => ({ ...m, filePath: pickRandomSFXFile(m.category, catalog) }))
        .filter((m) => m.filePath !== null)

      if (sfxPlacements.length > 0) {
        console.log(`[render][create] pass 4: mixing ${sfxPlacements.length} SFX into audio...`)
        const withSfxPath = path.join(workDir, 'output_with_sfx.mp4')

        const inputs4 = [`-i ${q(outputPath)}`]
        const fc4Parts = [`[0:a]volume=1.0[main]`]
        const mixLabels = ['[main]']

        sfxPlacements.forEach((sfx, i) => {
          inputs4.push(`-i ${q(sfx.filePath)}`)
          fc4Parts.push(
            `[${i + 1}:a]adelay=${sfx.delay_ms}|${sfx.delay_ms},volume=${sfx.volume}[sfx${i}]`,
          )
          mixLabels.push(`[sfx${i}]`)
        })

        fc4Parts.push(
          `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
            `alimiter=limit=0.95[aout]`,
        )

        const cmd4 = [
          'ffmpeg -y',
          inputs4.join(' '),
          `-filter_complex "${fc4Parts.join('; ')}"`,
          `-map "0:v"`,
          `-map "[aout]"`,
          '-c:v copy',
          '-c:a aac -b:a 192k',
          '-movflags +faststart',
          q(withSfxPath),
        ].join(' ')

        console.log('[render][create] pass 4 cmd (300):', cmd4.slice(0, 300))
        await execAsync(cmd4, { maxBuffer: 300 * 1024 * 1024, timeout: 120_000 })
        await copyFile(withSfxPath, outputPath)
        console.log(`[render][create] pass 4 done — ${sfxPlacements.length} SFX applied`)
      } else {
        console.log('[render][create] pass 4 skipped: no SFX placements from LLM')
      }
    } catch (e) {
      console.warn(`[render][create] pass 4 (SFX) FAILED, keeping clean output: ${e?.message ?? e}`)
    }
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
  // Branding: intro glitch + outro blanco con el logo (si el cliente tiene logo).
  await addIntroOutro(outputPath, logoPath, workDir, { W, H })
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
    const musicValEdit = String(manifest?.music ?? '').toLowerCase()
    const wantMusic = manifest?.music && musicValEdit !== 'none' && musicValEdit !== 'custom'
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
  // v45 (Javier 2026-05-24): "voz más alta, música más baja". commercial 0.12 → 0.09; personal 0.17 igual.
  // Trayectoria comercial: v27=0.06 → v28=0.10 → v29=0.12 → v45=0.09. Ver CLAUDE.md sección 5.
  const musicVol = isCommercial ? 0.09 : 0.17

  // Audio post-concat: loudnorm EBU R128 antes del mix con música, alimiter final
  if (hasMusic) {
    const musicIdx = idx
    const musicOffset = Math.max(0, Number(manifest?.musicOffsetSec) || 0)   // WS10: parte elegida de la canción propia
    inputs.push(`${musicOffset > 0 ? `-ss ${musicOffset.toFixed(2)} ` : ''}-i ${q(musicPath)}`)
    idx++
    fc.push(
      `[${musicIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `volume=${musicVol},afade=t=out:st=${Math.max(0, totalDur - 1.5).toFixed(2)}:d=1.5[music]`,
    )
    fc.push(
      `[acat]loudnorm=I=-16:LRA=11:TP=-1.5[anorm]; ` +
        `[anorm][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
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
        await burnCaptions({ rawPath: finalRawPath, words: finalWords, outputPath, workDir, subtitleStyle: manifest?.subtitleStyle, captionReplacements: manifest?.captionReplacements, whatsappNumber: manifest?.whatsappNumber, contacts: manifest?.contacts, visualStyle: manifest?.visualStyle })
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
      // Anclar al TEMA REAL de los recursos del cliente (fix Javier 2026-06-03).
      const themeContextEdit = await describeTheme(await findMediaItems(workDir), manifest?.description, process.env.ANTHROPIC_API_KEY, workDir)
      const moments = await detectKeyMoments(words, process.env.ANTHROPIC_API_KEY, {
        maxMoments: 5,
        visualStyle: manifest?.visualStyle,
        themeContext: themeContextEdit,
        description: manifest?.description,
        script: manifest?.script,
      })
      if (moments.length > 0) {
        console.log(`[render][edit] generating ${moments.length} AI images in parallel...`)
        const generated = await generateImagesForMomentsParallel(moments, workDir, {
          visualStyle: manifest?.visualStyle,
          aspectRatio: '9:16', // ratio del video (Reel vertical) — animaciones simples llenan el frame
        })
        const ok = generated.filter((g) => g.success && g.imagePath)
        if (ok.length > 0) {
          console.log(`[render][edit] pass 3: overlaying ${ok.length} AI images on output.mp4...`)
          const withImagesPath = path.join(workDir, 'output_with_images.mp4')
          const inputs3 = [`-i ${q(outputPath)}`]
          const fc3 = []
          let lastLabel = '[0:v]'
          ok.forEach((g, i) => {
            inputs3.push(`-i ${q(g.imagePath)}`)
            // Ilustración IA en 9:16 (ratio del video) a PANTALLA COMPLETA. Las animaciones
            // se generan SIMPLES y verticales (ver llm-moments + styles), así llenan el frame
            // derechas sin acostarse ni recorte. (Opción 1 Javier 2026-05-24.)
            fc3.push(
              `[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
                `format=yuva420p,colorchannelmixer=aa=0.92[img${i}]`,
            )
            const nextLabel = `[v${i}]`
            fc3.push(
              `${lastLabel}[img${i}]overlay=enable='between(t,${g.startSec.toFixed(2)},${g.endSec.toFixed(2)})':x=0:y=0${nextLabel}`,
            )
            lastLabel = nextLabel
          })
          // ⛔ REGLA INAMOVIBLE (Javier 2026-06-02, UNIVERSAL): los SUBTÍTULOS van SIEMPRE
          // al FRENTE — nunca tapados por las animaciones. Re-quema el ASS de captions
          // ENCIMA de las imágenes IA (el .ass ya lo generó burnCaptions en este workDir).
          let mapLabel = lastLabel
          try {
            const capAss = path.join(workDir, 'captions.ass')
            await readFile(capAss)
            fc3.push(`${lastLabel}ass='${ffmpegAssPath(capAss)}'[vcap]`)
            mapLabel = '[vcap]'
          } catch { /* sin captions.ass → solo imágenes */ }
          const cmd3 = [
            'ffmpeg -y',
            inputs3.join(' '),
            `-filter_complex "${fc3.join('; ')}"`,
            `-map "${mapLabel}"`,
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

  // ── PASS 4: AI-driven SFX (whoosh, ding, boom, pop, sparkle, swoosh, click) ──
  // Claude Haiku analyzes the Whisper transcript and returns timestamps + categories.
  // Professional mixing rules enforced: volume hierarchy, min gap, boom+boom guard,
  // timing offsets, orchestra rule. Graceful fallback — never throws.
  const sfxEnabled =
    manifest?.sfx !== 'off' &&
    words.length > 0 &&
    Boolean(process.env.ANTHROPIC_API_KEY)

  if (sfxEnabled) {
    try {
      const sfxCatalogPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'sfx', 'catalog.json')
      const catalog = JSON.parse(await readFile(sfxCatalogPath, 'utf-8'))
      const sfxMoments = await detectSFXMoments(words, process.env.ANTHROPIC_API_KEY, totalDur)

      const sfxPlacements = sfxMoments
        .map((m) => ({ ...m, filePath: pickRandomSFXFile(m.category, catalog) }))
        .filter((m) => m.filePath !== null)

      if (sfxPlacements.length > 0) {
        console.log(`[render][edit] pass 4: mixing ${sfxPlacements.length} SFX into audio...`)
        const withSfxPath = path.join(workDir, 'output_with_sfx.mp4')

        // Build ffmpeg filter_complex: one input per SFX file + the source video
        // adelay offsets each SFX to its timestamp; amix blends all with the main audio.
        // -c:v copy avoids re-encoding video (fast audio-only re-encode pass).
        const inputs4 = [`-i ${q(outputPath)}`]
        const fc4Parts = [`[0:a]volume=1.0[main]`]
        const mixLabels = ['[main]']

        sfxPlacements.forEach((sfx, i) => {
          inputs4.push(`-i ${q(sfx.filePath)}`)
          fc4Parts.push(
            `[${i + 1}:a]adelay=${sfx.delay_ms}|${sfx.delay_ms},volume=${sfx.volume}[sfx${i}]`,
          )
          mixLabels.push(`[sfx${i}]`)
        })

        fc4Parts.push(
          `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
            `alimiter=limit=0.95[aout]`,
        )

        const cmd4 = [
          'ffmpeg -y',
          inputs4.join(' '),
          `-filter_complex "${fc4Parts.join('; ')}"`,
          `-map "0:v"`,
          `-map "[aout]"`,
          '-c:v copy',
          '-c:a aac -b:a 192k',
          '-movflags +faststart',
          q(withSfxPath),
        ].join(' ')

        console.log('[render][edit] pass 4 cmd (300):', cmd4.slice(0, 300))
        await execAsync(cmd4, { maxBuffer: 300 * 1024 * 1024, timeout: 120_000 })
        await copyFile(withSfxPath, outputPath)
        console.log(
          `[render][edit] pass 4 done — ${sfxPlacements.length} SFX applied`,
        )
      } else {
        console.log('[render][edit] pass 4 skipped: no SFX placements from LLM')
      }
    } catch (e) {
      console.warn(`[render][edit] pass 4 (SFX) FAILED, keeping clean output: ${e?.message ?? e}`)
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
  // Branding: intro glitch + outro blanco con el logo (si el cliente tiene logo).
  await addIntroOutro(outputPath, logoPath, workDir, { W, H })
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
  // 1c. v27 INAMOVIBLE: WORD-GAP silence cuts agresivo (init + mid + end).
  //     Threshold bajado 0.4 → 0.30s. Captura ruido al INICIO del clip
  //     (antes de la primera palabra) y al FINAL (después de la última),
  //     no solo gaps mid-speech. Resuelve queja Javier 2026-05-19:
  //     "AL INICIO seg 3 mucho espacio en silencio, ruido terrible".
  const rawDur = await getMediaDuration(rawPath)
  const gaps = detectWordGaps(words, {
    minGapSec: 0.30,
    padding: 0.10,
    minInitGapSec: 0.40,
    minEndGapSec: 0.40,
    totalDur: rawDur,
  })
  // 2. Detección LLM: tomas falsas explícitas + repeticiones reformuladas
  const llmRanges = await llmDetectFalseStartsAndRetakes(words, anthropicKey)
  const allRanges = mergeRanges([...det.ranges, ...bridge.ranges, ...gaps.ranges, ...llmRanges])

  if (allRanges.length === 0) {
    console.log('[content-trim] no ranges to cut, keeping raw')
    return { path: rawPath, words, removedSec: 0, ranges: [] }
  }

  // Reuse rawDur de la llamada anterior (evita doble ffprobe)
  const totalDur = rawDur
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
  const gapsStr = gaps.counts.gap ? `gap×${gaps.counts.gap}` : 'none'
  console.log(
    `[content-trim] cutting ${allRanges.length} ranges = ${removedSec.toFixed(2)}s ` +
      `(deterministic: ${detStr || 'none'}, bridge: ${bridgeStr || 'none'}, ` +
      `word-gaps: ${gapsStr}, llm: ${llmRanges.length})`,
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
// Corrección de subtítulos (v39): reemplaza palabras mal transcritas por Whisper
// (típico: nombres de marca como "Mac Gyver" → "gaiber"). MACtin pasa los pares
// {from,to} y se aplican a las palabras antes de construir el ASS. Match por palabra
// completa, case-insensitive, ignorando puntuación. `to` puede ser multi-palabra.
function applyCaptionReplacements(words, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) return words
  const norm = replacements
    .filter((r) => r && r.from && r.to)
    .map((r) => ({ from: String(r.from).trim().toLowerCase(), to: String(r.to).trim() }))
  if (norm.length === 0) return words
  return words.map((w) => {
    const clean = String(w.word ?? '').trim().toLowerCase().replace(/[.,!?;:¡¿"']/g, '')
    const hit = norm.find((r) => clean === r.from)
    return hit ? { ...w, word: hit.to } : w
  })
}

async function burnCaptions({ rawPath, words, outputPath, workDir, subtitleStyle, captionReplacements, whatsappNumber, contacts, visualStyle }) {
  const captionsPath = path.join(workDir, 'captions.ass')
  const fixedWords = applyCaptionReplacements(words, captionReplacements)
  if (fixedWords !== words) console.log(`[render] caption replacements applied: ${(captionReplacements || []).length}`)

  // ── Tarjeta de contacto (WS9, regla de marca) ──────────────────────────────
  // Reemplaza el viejo badge verde plano por una TARJETA generada (lib/contact-card.js)
  // adaptada a la PALETA del estilo visual elegido, con íconos (WhatsApp + web/correo) y
  // dominio limpio. Se compone como overlay animado (fade in/out) en el momento en que el
  // video menciona el contacto; fallback cerca del cierre. Datos del checklist (manifest.contacts);
  // back-compat con whatsappNumber (= solo teléfono). Sin datos → no se muestra.
  let contactList = Array.isArray(contacts)
    ? contacts.filter((c) => c && c.value && String(c.value).trim())
    : []
  if (contactList.length === 0 && whatsappNumber && String(whatsappNumber).trim()) {
    contactList = [{ kind: 'phone', value: String(whatsappNumber).trim() }]
  }

  // Animación de contacto: una ILUSTRACIÓN en el ESTILO elegido por canal (WhatsApp/web/
  // correo), con el dato sobreimpreso (auto-fit), en el momento en que la voz lo menciona
  // (fallback: hacia el cierre). Reemplaza la tarjeta canvas (pedido Javier 2026-06-03,
  // muestras aprobadas). Reusa el motor de imágenes en estilo (contact-illustration.js).
  let contactOverlays = []   // [{ path, start, end }]
  let contactTotalDur = 0
  if (contactList.length) {
    try { contactTotalDur = await getMediaDuration(rawPath) } catch { contactTotalDur = 0 }
    const kieKey = process.env.KIE_AI_API_KEY
    const RE = {
      phone:   /whats|wasap|watsap|guats|escr[ií]b|ll[aá]m|cont[aá]ct/i,
      website: /web|p[aá]gina|sitio|s[ií]guenos|vis[ií]t/i,
      email:   /correo|e-?mail|mail/i,
    }
    // Por canal: clasificar su mención + generar la ilustración (en paralelo).
    const items = contactList.slice(0, 3).map((c, i) => {
      const channel = normalizeContactKind(c.kind)
      const m = fixedWords.find((w) => (RE[channel] || RE.phone).test(String(w.word ?? '')))
      return { ...c, channel, mentionStart: m ? m.start : null, index: i }
    })
    let gens = []
    if (kieKey) {
      gens = await Promise.all(items.map((it) =>
        generateContactIllustration({ kind: it.channel, value: it.value, style: visualStyle, workDir, apiKey: kieKey, W, H, index: it.index }),
      ))
    } else {
      console.warn('[render] no KIE key — contact illustrations skipped')
    }
    // Asignar ventanas SIN solapar: con mención → en su momento; sin mención → hacia el cierre.
    const DUR = 4.0
    const cands = items.map((it, i) => ({ path: gens[i], channel: it.channel, pref: it.mentionStart })).filter((c) => c.path)
    let endCursor = Math.max(0, (contactTotalDur || DUR * cands.length) - DUR)
    for (let i = cands.length - 1; i >= 0; i--) {
      if (cands[i].pref == null) { cands[i].pref = endCursor; endCursor -= DUR }
    }
    cands.sort((a, b) => a.pref - b.pref)
    let last = -999
    for (const c of cands) {
      let s = Math.max(0, c.pref, last + DUR)
      if (contactTotalDur > 0) s = Math.min(s, contactTotalDur - 1.0)
      const e = contactTotalDur > 0 ? Math.min(s + DUR, contactTotalDur - 0.05) : s + DUR
      if (e > s + 0.6) { contactOverlays.push({ path: c.path, start: s, end: e, channel: c.channel }); last = s }
    }
    if (contactOverlays.length) {
      console.log(`[render] contact illustrations: ${contactOverlays.map((o) => `${o.channel}@${o.start.toFixed(1)}s`).join(', ')} (style=${visualStyle || 'default'})`)
    }
  }

  // Subtítulos karaoke (sin badges de contacto — la tarjeta va como overlay aparte).
  await writeFile(captionsPath, buildASS(fixedWords, subtitleStyle, []), 'utf8')
  const escaped = ffmpegAssPath(captionsPath)

  let cmd2
  if (contactOverlays.length) {
    const loopDur = contactTotalDur > 0 ? contactTotalDur : Math.max(...contactOverlays.map((o) => o.end)) + 1
    const inputs = [`-i ${q(rawPath)}`]
    const fc = []
    let lastLabel = '[0:v]'
    contactOverlays.forEach((o, i) => {
      inputs.push(`-loop 1 -t ${loopDur.toFixed(2)} -i ${q(o.path)}`)   // loopear (sin esto el overlay no aparece, error #11)
      const fadeOut = Math.max(o.start, o.end - 0.4)
      // Ilustración de contacto a PANTALLA COMPLETA (protagonista), con fade in/out.
      fc.push(
        `[${i + 1}:v]format=rgba,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
          `fade=t=in:st=${o.start.toFixed(2)}:d=0.4:alpha=1,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.4:alpha=1[cta${i}]`,
      )
      const nl = `[m${i}]`
      fc.push(`${lastLabel}[cta${i}]overlay=x=0:y=0:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'${nl}`)
      lastLabel = nl
    })
    // SUBTÍTULOS al FINAL, encima de TODO (regla inamovible #25 — captions al frente).
    fc.push(`${lastLabel}ass='${escaped}'[v]`)
    cmd2 = [
      'ffmpeg -y',
      inputs.join(' '),
      `-filter_complex "${fc.join('; ')}"`,
      '-map "[v]" -map 0:a?',
      '-c:a copy -c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
      q(outputPath),
    ].join(' ')
  } else {
    cmd2 = [
      'ffmpeg -y',
      `-i ${q(rawPath)}`,
      `-vf "ass='${escaped}'"`,
      '-c:a copy -c:v libx264 -crf 26 -preset fast -pix_fmt yuv420p',
      q(outputPath),
    ].join(' ')
  }
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
  // WS4: derivar el lienzo del formato elegido ANTES de cualquier trabajo de render.
  // Seguro mutar W/H a nivel módulo: server.js serializa los renders (1 a la vez).
  ;({ W, H } = dimsForFormat(manifest?.format))
  const isEdit = manifest?.mode === 'edit' || manifest?.noVoice === true
  console.log(`[render] mode=${isEdit ? 'edit' : 'create'} format=${manifest?.format || '9:16'} canvas=${W}x${H}`)
  if (isEdit) return renderEdit({ workDir, openaiKey, manifest })
  return renderCreate({ workDir, openaiKey, manifest })
}
