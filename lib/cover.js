// cover.js — WS11: genera la PORTADA (cover/thumbnail) del video.
// Agarra UN frame representativo del propio video + le pone un TÍTULO corto y
// llamativo. Aplica 5 referencias investigadas (2026-06-14):
//  1. título MUY corto (≤4 palabras) — no repetir el del post
//  2. tipografía bold + alto contraste (amarillo + borde negro = lo más visible)
//  3. un solo foco, diseño limpio
//  4. safe zone: vertical → tercio superior/centro (nunca el borde inferior);
//     horizontal → evitar esquina inferior derecha (timestamp YouTube)
//  5. curiosity gap (lo aporta el título generado por el LLM)
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import fs from 'fs'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fuente bold (Liberation en el Docker, Arial en Windows local).
let FONT = 'sans-serif'
for (const p of [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
]) {
  try { if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, 'CoverSans'); FONT = 'CoverSans'; break } } catch { /* ignore */ }
}

// Lienzo de la portada = formato del video.
function coverDims(format) {
  if (format === '1:1')  return { W: 1080, H: 1080 }
  if (format === '16:9') return { W: 1920, H: 1080 }
  return { W: 1080, H: 1920 }   // 9:16 default
}

/**
 * Genera un título de portada corto y llamativo (≤4 palabras, MAYÚSCULAS) a partir
 * del guión/descripción. Fallback robusto sin LLM (primeras palabras significativas).
 */
export async function generateCoverTitle(text, anthropicKey) {
  const fallback = () => {
    const words = String(text || '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
    return (words.slice(0, 3).join(' ') || 'MIRÁ ESTO').toUpperCase()
  }
  if (!anthropicKey || !text) return fallback()
  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      system: 'Generás títulos de PORTADA para videos cortos (Reels/TikTok/YouTube). Reglas: MÁXIMO 4 palabras, en MAYÚSCULAS, llamativo con "curiosity gap" (insinúa el valor sin revelarlo todo), sin signos de puntuación finales, sin emojis, sin comillas. Devolvé SOLO el título, nada más.',
      messages: [{ role: 'user', content: `Guión del video:\n${String(text).slice(0, 900)}\n\nTítulo de portada (máx 4 palabras, MAYÚSCULAS):` }],
    })
    const raw = (resp.content?.[0]?.text || '').trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/[.!?…]+$/, '')
      .toUpperCase()
    const words = raw.split(/\s+/).filter(Boolean)
    return words.length ? words.slice(0, 5).join(' ') : fallback()
  } catch (e) {
    console.warn('[cover] title LLM failed:', e?.message ?? e)
    return fallback()
  }
}

// Elige el layout del título: 1 línea, o 2 líneas balanceadas — el que dé MÁS
// tamaño de fuente (más impacto), siempre cabiendo en maxW (auto-fit).
function layoutTitle(ctx, title, maxW, startPx) {
  const words = title.split(/\s+/).filter(Boolean)
  const fitPx = (lines) => {
    let px = startPx
    while (px > startPx * 0.42) {
      ctx.font = `bold ${px}px ${FONT}`
      if (lines.every(l => ctx.measureText(l).width <= maxW)) return px
      px -= 4
    }
    return Math.round(startPx * 0.42)
  }
  if (words.length <= 1) {
    const l = [words[0] || '']
    return { lines: l, fontPx: fitPx(l) }
  }
  const oneLine = [words.join(' ')]
  const onePx = fitPx(oneLine)
  const mid = Math.ceil(words.length / 2)
  const twoLines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
  const twoPx = fitPx(twoLines)
  return twoPx > onePx ? { lines: twoLines, fontPx: twoPx } : { lines: oneLine, fontPx: onePx }
}

/**
 * Compone la portada: frame del video + scrim + título + logo.
 * @returns {Promise<string>} ruta del PNG generado.
 */
export async function generateCover({ videoPath, title, format, logoPath, workDir, outName = 'cover.png' }) {
  const { W, H } = coverDims(format)
  const framePath = path.join(workDir, 'cover_frame.jpg')

  // 1) Frame representativo del CUERPO del video (salta el intro/outro).
  //    NO usar el filtro `thumbnail`: elige el frame más ATÍPICO del lote, que en
  //    un video con intro negro (glitch) + outro blanco + xfades termina siendo un
  //    frame NEGRO → portada negra. Tomamos UN frame determinista en `t`.
  let dur = 0
  try {
    const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`)
    dur = parseFloat(stdout) || 0
  } catch { /* ignore */ }
  // Si ffprobe falla (dur=0) asumimos un cuerpo razonable en vez de caer a t=0.3s
  // (que aterriza de lleno en el intro negro de 1.8s).
  const safeDur = dur > 0 ? dur : 12
  const INTRO_SKIP = 2.0   // > intro 1.8s
  const OUTRO_SKIP = 2.0   // > outro 1.5s
  const t = safeDur > (INTRO_SKIP + OUTRO_SKIP + 1)
    ? Math.min(Math.max(safeDur * 0.35, INTRO_SKIP + 0.5), safeDur - OUTRO_SKIP)
    : Math.max(safeDur * 0.5, 1.0)
  await execAsync(
    `ffmpeg -y -ss ${t.toFixed(2)} -i "${videoPath}" ` +
    `-frames:v 1 -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" ` +
    `-q:v 2 "${framePath}"`,
    { timeout: 30_000 },
  )

  // 2) Composición con canvas.
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const frame = await loadImage(framePath)
  ctx.drawImage(frame, 0, 0, W, H)

  const isVertical = H >= W

  // Scrim oscuro arriba (legibilidad del título) — degradado, sin tapar la foto.
  const scrimH = H * (isVertical ? 0.46 : 0.55)
  const grad = ctx.createLinearGradient(0, 0, 0, scrimH)
  grad.addColorStop(0, 'rgba(0,0,0,0.58)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, scrimH)

  // 3) Título: bold, MAYÚSCULAS, amarillo + grueso borde negro (ref #2), en la
  // safe zone (tercio superior/centro — ref #4).
  const safeW = W * 0.86
  const txt = String(title || '').toUpperCase()
  const { lines, fontPx } = layoutTitle(ctx, txt, safeW, Math.round(W * 0.125))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.font = `bold ${fontPx}px ${FONT}`
  const lineH = fontPx * 1.06
  const cy = isVertical ? H * 0.24 : H * 0.30   // centro del bloque de título
  let y = cy - (lines.length * lineH) / 2 + lineH / 2
  for (const line of lines) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = Math.round(fontPx * 0.12)
    ctx.shadowOffsetY = Math.round(fontPx * 0.05)
    ctx.lineWidth = Math.max(7, fontPx * 0.17)
    ctx.strokeStyle = '#000000'
    ctx.strokeText(line, W / 2, y)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.fillStyle = '#FFE400'   // amarillo alto contraste
    ctx.fillText(line, W / 2, y)
    y += lineH
  }

  // 4) Logo chico arriba a la IZQUIERDA (safe en vertical y horizontal; lejos del
  // timestamp inf-derecha de YouTube). Sin logo → se omite.
  if (logoPath) {
    try {
      const logo = await loadImage(logoPath)
      const lw = Math.round(W * 0.12)
      const lh = Math.round(lw * (logo.height / logo.width))
      const m = Math.round(W * 0.035)
      ctx.drawImage(logo, m, m, lw, lh)
    } catch { /* logo opcional */ }
  }

  const out = path.join(workDir, outName)
  fs.writeFileSync(out, canvas.toBuffer('image/png'))
  return out
}
