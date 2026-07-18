// cover.js — PORTADA (cover/thumbnail) estilo CapCut, EDITABLE.
// Fondo = frame REAL del footage (no las ilustraciones IA) + texto bold con
// contorno + sombra + glow, una palabra/línea en color de acento, badge superior
// y subtítulo. Todo editable desde el SaaS: textos, tipografía, color, frame.
// Referencias CapCut aplicadas: texto corto, alto contraste, un foco, safe zone.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import fs from 'fs'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts')

// Catálogo de tipografías (Google Fonts, todas display/bold → impacto real).
// La `key` es lo que viaja en coverFields.font; `family` es el nombre registrado.
export const FONT_CATALOG = [
  { key: 'anton',    file: 'Anton.ttf',        label: 'Anton' },
  { key: 'archivo',  file: 'ArchivoBlack.ttf', label: 'Archivo Black' },
  { key: 'bebas',    file: 'BebasNeue.ttf',    label: 'Bebas Neue' },
  { key: 'bangers',  file: 'Bangers.ttf',      label: 'Bangers' },
  { key: 'bungee',   file: 'Bungee.ttf',       label: 'Bungee' },
  { key: 'passion',  file: 'PassionOne.ttf',   label: 'Passion One' },
  { key: 'luckiest', file: 'LuckiestGuy.ttf',  label: 'Luckiest Guy' },
  { key: 'poppins',  file: 'PoppinsBlack.ttf', label: 'Poppins Black' },
  { key: 'fjalla',   file: 'FjallaOne.ttf',    label: 'Fjalla One' },
  { key: 'titan',    file: 'TitanOne.ttf',     label: 'Titan One' },
]
const DEFAULT_FONT = 'anton'
const UI_FONT = 'archivo'   // badge + subtítulo (legible)
const DEFAULT_ACCENT = '#FFE400'

// Registrar todas las fuentes una sola vez (familia = Cover_<key>).
const REGISTERED = {}
for (const f of FONT_CATALOG) {
  const p = path.join(FONTS_DIR, f.file)
  const family = `Cover_${f.key}`
  try {
    if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, family); REGISTERED[f.key] = family }
  } catch { /* ignore */ }
}
function familyFor(key) {
  return REGISTERED[key] || REGISTERED[DEFAULT_FONT] || 'sans-serif'
}

// Lienzo de la portada = formato del video.
export function coverDims(format) {
  if (format === '1:1')  return { W: 1080, H: 1080 }
  if (format === '16:9') return { W: 1920, H: 1080 }
  return { W: 1080, H: 1920 }   // 9:16 default
}

/**
 * Propone los CAMPOS de la portada (título en 2 partes + badge + subtítulo) a
 * partir del guión. El cliente luego los edita. Fallback robusto sin LLM.
 */
export async function generateCoverFields(text, anthropicKey) {
  const fallback = () => {
    const words = String(text || '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/).filter(w => w.length > 2)
    const t1 = (words.slice(0, 2).join(' ') || 'MIRÁ ESTO').toUpperCase()
    const t2 = (words.slice(2, 4).join(' ') || '').toUpperCase()
    return { title1: t1, title2: t2, badge: '', subtitle: '' }
  }
  if (!anthropicKey || !text) return fallback()
  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      system: 'Generás los textos de una PORTADA llamativa para video corto (Reels/TikTok/YouTube), estilo CapCut. Reglas: MAYÚSCULAS, MUY corto y con gancho (curiosity gap). Devolvé SOLO un JSON con: {"title1": "1-2 palabras", "title2": "1-2 palabras (la parte destacada, puede ir vacía)", "badge": "etiqueta corta opcional ≤2 palabras o vacío", "subtitle": "línea inferior corta opcional o vacío"}. title1+title2 juntos = máx 4 palabras. Sin emojis, sin comillas dentro de los valores, sin puntuación final.',
      messages: [{ role: 'user', content: `Guión:\n${String(text).slice(0, 900)}\n\nJSON de la portada:` }],
    })
    const raw = (resp.content?.[0]?.text || '').trim()
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return fallback()
    const o = JSON.parse(m[0])
    const up = (s) => String(s || '').replace(/^["'""]+|["'""]+$/g, '').replace(/[.!?…]+$/, '').toUpperCase().trim()
    const out = { title1: up(o.title1), title2: up(o.title2), badge: up(o.badge), subtitle: up(o.subtitle) }
    if (!out.title1 && !out.title2) return fallback()
    return out
  } catch (e) {
    console.warn('[cover] fields LLM failed:', e?.message ?? e)
    return fallback()
  }
}

// Compat: algunos callers viejos esperan un string de título.
export async function generateCoverTitle(text, anthropicKey) {
  const f = await generateCoverFields(text, anthropicKey)
  return [f.title1, f.title2].filter(Boolean).join(' ')
}

// Auto-fit: el px más grande que entra en maxW.
function fitPx(ctx, text, family, maxW, startPx, minPx = 28) {
  let px = startPx
  while (px > minPx) {
    ctx.font = `${px}px "${family}"`
    if (ctx.measureText(text).width <= maxW) return px
    px -= 4
  }
  return minPx
}

// Texto estilo CapCut: glow opcional + sombra + contorno grueso + relleno.
function capcutText(ctx, x, y, text, fill, { stroke = '#000', strokeW = 14, glow = null } = {}) {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  if (glow) {
    ctx.save()
    ctx.shadowColor = glow
    ctx.shadowBlur = 34
    ctx.lineWidth = strokeW + 6
    ctx.strokeStyle = glow
    for (let i = 0; i < 2; i++) ctx.strokeText(text, x, y)
    ctx.restore()
  }
  // sombra de apoyo
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 8
  ctx.lineWidth = strokeW
  ctx.strokeStyle = stroke
  ctx.strokeText(text, x, y)
  ctx.restore()
  // relleno
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Compone la portada CapCut sobre un frame.
 * @param {object} o
 * @param {string} [o.framePath] frame de fondo YA extraído (preferido).
 * @param {string} [o.videoPath] fallback: extrae un frame del cuerpo del video.
 * @param {string} o.format  '9:16'|'1:1'|'16:9'
 * @param {string} [o.logoPath]
 * @param {string} o.workDir
 * @param {object} o.fields  { title1, title2, badge, subtitle, font, accentColor }
 * @param {string} [o.outName='cover.png']
 * @returns {Promise<string>} ruta del PNG.
 */
export async function generateCover({ framePath, videoPath, format, logoPath, workDir, fields = {}, outName = 'cover.png' }) {
  const { W, H } = coverDims(format)
  const isVertical = H >= W

  // 1) Frame de fondo: usar el provisto, o extraer uno limpio del cuerpo del video.
  let bgPath = framePath && fs.existsSync(framePath) ? framePath : null
  if (!bgPath) {
    bgPath = path.join(workDir, 'cover_frame.jpg')
    let dur = 0
    try {
      const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`)
      dur = parseFloat(stdout) || 0
    } catch { /* ignore */ }
    const safeDur = dur > 0 ? dur : 12
    const t = safeDur > 5 ? Math.min(Math.max(safeDur * 0.35, 2.5), safeDur - 2.0) : Math.max(safeDur * 0.5, 1.0)
    await execAsync(
      `ffmpeg -y -ss ${t.toFixed(2)} -i "${videoPath}" -frames:v 1 ` +
      `-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" -q:v 2 "${bgPath}"`,
      { timeout: 30_000 },
    )
  }

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const frame = await loadImage(bgPath)
  // cover (object-fit:cover) al lienzo
  const sr = frame.width / frame.height, dr = W / H
  let dw = W, dh = H, dx = 0, dy = 0
  if (sr > dr) { dh = H; dw = H * sr; dx = (W - dw) / 2 } else { dw = W; dh = W / sr; dy = (H - dh) / 2 }
  ctx.drawImage(frame, dx, dy, dw, dh)

  // 2) Scrim doble (arriba para el título, abajo para el subtítulo).
  const gTop = ctx.createLinearGradient(0, 0, 0, H * 0.5)
  gTop.addColorStop(0, 'rgba(0,0,0,0.72)'); gTop.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gTop; ctx.fillRect(0, 0, W, H * 0.5)
  const gBot = ctx.createLinearGradient(0, H, 0, H * 0.72)
  gBot.addColorStop(0, 'rgba(0,0,0,0.78)'); gBot.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gBot; ctx.fillRect(0, H * 0.72, W, H * 0.28)

  const accent = (fields.accentColor && /^#[0-9a-fA-F]{6}$/.test(fields.accentColor)) ? fields.accentColor : DEFAULT_ACCENT
  const titleFam = familyFor(fields.font || DEFAULT_FONT)
  const uiFam = familyFor(UI_FONT)
  const safeW = W * 0.9
  const title1 = String(fields.title1 || '').toUpperCase().trim()
  const title2 = String(fields.title2 || '').toUpperCase().trim()
  const badge = String(fields.badge || '').toUpperCase().trim()
  const subtitle = String(fields.subtitle || '').toUpperCase().trim()
  const baseTitlePx = Math.round(W * (isVertical ? 0.19 : 0.13))
  const strokeW = Math.max(8, Math.round(baseTitlePx * 0.085))

  // Offsets de posición (2026-07-18, pedido de Javier: "todo el texto lo pueda
  // mover con el cursor"). El cliente arrastra cada bloque en el editor y el
  // delta (fracción de W/H) se SUMA a la posición default calculada abajo — el
  // flujo/layout en sí NO cambia, solo el punto donde se DIBUJA cada bloque.
  // Sin `fields.positions` (o con dx/dy en 0) el resultado es IDÉNTICO al
  // layout original — cero regresión para portadas ya generadas.
  const pos = (fields.positions && typeof fields.positions === 'object') ? fields.positions : {}
  const offX = (key) => (pos[key]?.dx ? pos[key].dx * W : 0)
  const offY = (key) => (pos[key]?.dy ? pos[key].dy * H : 0)

  // 3) Badge superior (cápsula de color de acento, texto oscuro).
  let y = isVertical ? H * 0.115 : H * 0.12
  if (badge) {
    const bx = W / 2 + offX('badge'), by = y + offY('badge')
    const bpx = Math.round(W * 0.042)
    ctx.font = `${bpx}px "${uiFam}"`
    const tw = ctx.measureText(badge).width
    const padX = bpx * 0.9, padY = bpx * 0.5
    const bw = tw + padX * 2, bh = bpx + padY * 2
    roundRect(ctx, bx - bw / 2, by - bh / 2, bw, bh, bh / 2)
    ctx.fillStyle = accent; ctx.fill()
    ctx.fillStyle = '#101010'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(badge, bx, by + 2)
    y += bh / 2 + baseTitlePx * 0.55
  } else {
    y = isVertical ? H * 0.2 : H * 0.24
  }

  // 4) Título (línea 1 blanca, línea 2 en color de acento). Ambas líneas
  // comparten el MISMO offset 'title' — se mueven juntas como un bloque.
  if (title1) {
    const px = fitPx(ctx, title1, titleFam, safeW, baseTitlePx)
    ctx.font = `${px}px "${titleFam}"`
    capcutText(ctx, W / 2 + offX('title'), y + px / 2 + offY('title'), title1, '#FFFFFF', { strokeW })
    y += px * 1.04
  }
  if (title2) {
    const px = fitPx(ctx, title2, titleFam, safeW, baseTitlePx)
    ctx.font = `${px}px "${titleFam}"`
    capcutText(ctx, W / 2 + offX('title'), y + px / 2 + offY('title'), title2, accent, { strokeW })
    y += px
  }

  // 5) Subtítulo — APILADO debajo del título (zona segura del tercio superior).
  // Antes iba al fondo (H*0.9) y se perdía detrás de la UI del feed (nombre/botones).
  if (subtitle) {
    const spx = Math.round(W * 0.05)
    const fitted = fitPx(ctx, subtitle, uiFam, safeW, spx)
    ctx.font = `${fitted}px "${uiFam}"`
    capcutText(ctx, W / 2 + offX('subtitle'), y + fitted * 0.85 + offY('subtitle'), subtitle, '#FFFFFF', { strokeW: Math.max(6, fitted * 0.09) })
  }

  // 6) Logo arriba a la izquierda.
  if (logoPath) {
    try {
      const logo = await loadImage(logoPath)
      const lw = Math.round(W * 0.13)
      const lh = Math.round(lw * (logo.height / logo.width))
      const m = Math.round(W * 0.035)
      ctx.drawImage(logo, m, m, lw, lh)
    } catch { /* opcional */ }
  }

  const out = path.join(workDir, outName)
  fs.writeFileSync(out, canvas.toBuffer('image/png'))
  return out
}

/**
 * Extrae frames candidatos del FOOTAGE REAL del cliente (los media_* del workDir,
 * ANTES de cualquier ilustración IA) para que la portada use una toma real y el
 * cliente pueda elegir cuál. Si no hay footage (full-AI), cae a frames del output.
 * Devuelve rutas locales cover_frame_0.jpg ... cover_frame_N.jpg (ya al W×H).
 */
export async function extractCoverFrames({ workDir, fallbackVideo, format, max = 6 }) {
  const { W, H } = coverDims(format)
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
  const frames = []
  const grab = async (cmd) => {
    const out = path.join(workDir, `cover_frame_${frames.length}.jpg`)
    try { await execAsync(cmd(out), { timeout: 30_000 }); if (fs.existsSync(out)) frames.push(out) } catch { /* skip */ }
  }
  let files = []
  try { files = fs.readdirSync(workDir) } catch { /* ignore */ }
  const videos = files.filter(f => /^media_\d+\.(mp4|mov|m4v|webm)$/i.test(f)).sort()
  const images = files.filter(f => /^media_\d+\.(jpe?g|png|webp)$/i.test(f)).sort()

  // 1) Un frame del medio de cada clip de video del cliente.
  for (const v of videos) {
    if (frames.length >= max) break
    const src = path.join(workDir, v)
    let dur = 0
    try { const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${src}"`); dur = parseFloat(stdout) || 0 } catch { /* ignore */ }
    const t = dur > 1 ? dur * 0.5 : 0
    await grab((out) => `ffmpeg -y -ss ${t.toFixed(2)} -i "${src}" -frames:v 1 -vf "${vf}" -q:v 2 "${out}"`)
  }
  // 2) Imágenes reales del cliente.
  for (const im of images) {
    if (frames.length >= max) break
    const src = path.join(workDir, im)
    await grab((out) => `ffmpeg -y -i "${src}" -frames:v 1 -vf "${vf}" -q:v 2 "${out}"`)
  }
  // 3) Fallback: frames del output (puede tener overlays, pero es lo que hay).
  if (frames.length === 0 && fallbackVideo) {
    let dur = 0
    try { const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fallbackVideo}"`); dur = parseFloat(stdout) || 0 } catch { /* ignore */ }
    const safe = dur > 0 ? dur : 12
    for (const frac of [0.3, 0.5, 0.7]) {
      if (frames.length >= max) break
      const t = Math.min(Math.max(safe * frac, 2.5), safe - 2)
      await grab((out) => `ffmpeg -y -ss ${t.toFixed(2)} -i "${fallbackVideo}" -frames:v 1 -vf "${vf}" -q:v 2 "${out}"`)
    }
  }
  return frames
}
