// contact-card.js — genera la tarjeta de contacto (WS9) como PNG transparente,
// adaptada a la PALETA del estilo visual elegido (Nivel A, aprobado por Javier 2026-06-02).
// El worker la compone como overlay animado sincronizado con la mención de contacto.
// Diseño portado 1:1 del mockup PIL aprobado (EDIT_VIDEO/tmp_contacto/mock_contacto.py).
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WA_ICON = path.join(__dirname, '..', 'assets', 'contact', 'whatsapp.png')

// Registrar una fuente bold bajo un family fijo (Liberation en el Docker Linux,
// Arial en Windows para pruebas locales). Si ninguna existe, cae a sans-serif del sistema.
let FONT = 'sans-serif'
for (const p of [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
]) {
  try { if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, 'ContactSans'); FONT = 'ContactSans'; break } } catch { /* ignore */ }
}

// Paleta de la tarjeta por estilo visual (cubre los 14; default neutro claro).
// WhatsApp es SIEMPRE verde (su color de marca) → su ícono no cambia por estilo.
const PALETTES = {
  auto:       { card: '#FBF7EF', accent: '#5F7A6B', text: '#2E2A24', border: null },     // Estilo Chixy
  doodle:     { card: '#FFFFFF', accent: '#111111', text: '#111111', border: '#111111' },
  whiteboard: { card: '#FFFFFF', accent: '#1E40AF', text: '#1A1A1A', border: '#1E40AF' },
  flat:       { card: '#FFFFFF', accent: '#4F46E5', text: '#1E293B', border: null },
  isometric:  { card: '#F8FAFC', accent: '#0EA5E9', text: '#1E293B', border: null },
  claymation: { card: '#FFF7F2', accent: '#E8956F', text: '#4A3B33', border: null },
  watercolor: { card: '#FBF8F3', accent: '#9A7B5C', text: '#4A3F32', border: null },
  comic:      { card: '#FFFFFF', accent: '#E11D48', text: '#111111', border: '#111111' },
  lineart:    { card: '#FFFFFF', accent: '#6B7280', text: '#1A1A1A', border: '#1A1A1A' },
  render3d:   { card: '#FFFFFF', accent: '#7C3AED', text: '#1E293B', border: null },
  neon:       { card: '#121A2B', accent: '#22D3EE', text: '#EAF6FB', border: '#22D3EE' },
  cinematic:  { card: '#1A1714', accent: '#D4A24E', text: '#F5EFE6', border: null },
  papercut:   { card: '#FBF6EE', accent: '#7BA05B', text: '#44403A', border: null },
  sticker:    { card: '#FFFFFF', accent: '#F472B6', text: '#111111', border: '#F472B6' },
}
const DEFAULT_PAL = { card: '#FFFFFF', accent: '#4F46E5', text: '#1E293B', border: null }

/** Limpia una URL para mostrarla: sin protocolo, sin www, sin barra final. */
export function cleanDomain(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
}

/** Reduce el tamaño de fuente hasta que el texto quepa en maxW (auto-fit, nunca se sale). */
function fitFont(ctx, text, maxW, startPx, loPx = 22) {
  let px = startPx
  while (px > loPx) {
    ctx.font = `bold ${px}px ${FONT}`
    if (ctx.measureText(text).width <= maxW) return px
    px -= 2
  }
  return loPx
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Globo web dibujado con paths (color del acento del estilo).
function drawGlobe(ctx, cx, cy, size, color) {
  const r = size / 2
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, size * 0.05)
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2); ctx.stroke()           // contorno
  ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.40, r * 0.92, 0, 0, Math.PI * 2); ctx.stroke() // meridiano
  ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.92); ctx.lineTo(cx, cy + r * 0.92); ctx.stroke() // eje
  ctx.beginPath(); ctx.moveTo(cx - r * 0.92, cy); ctx.lineTo(cx + r * 0.92, cy); ctx.stroke() // ecuador
  ctx.beginPath(); ctx.ellipse(cx, cy - r * 0.30, r * 0.78, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke() // paralelo sup
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.30, r * 0.78, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke() // paralelo inf
  ctx.restore()
}

// Ícono de sobre (correo) con paths.
function drawEnvelope(ctx, x, y, size, color) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, size * 0.06)
  const w = size, h = size * 0.74, oy = y + (size - h) / 2
  roundRectPath(ctx, x, oy, w, h, size * 0.10); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(x + size * 0.06, oy + size * 0.10)
  ctx.lineTo(x + w / 2, oy + h * 0.58); ctx.lineTo(x + w - size * 0.06, oy + size * 0.10); ctx.stroke()
  ctx.restore()
}

/**
 * Genera la tarjeta de contacto y la escribe en outPath (PNG con alpha).
 * @param {{contacts:Array<{kind:'phone'|'email'|'web',value:string}>, style:string, outPath:string, width?:number}} opts
 * @returns {Promise<{width:number,height:number,path:string}>}
 */
export async function renderContactCard({ contacts, style, outPath, width = 860 }) {
  const rows = (contacts || []).filter((c) => c && c.value && String(c.value).trim()).slice(0, 3)
  if (rows.length === 0) return null
  const pal = PALETTES[style] || DEFAULT_PAL

  const PAD = 46
  const ICON = 92
  const ROW_GAP = 30
  const GAP = 30                       // ícono ↔ texto
  const cardW = width
  const cardH = PAD * 2 + rows.length * ICON + (rows.length - 1) * ROW_GAP
  const MARGIN = 26                    // aire para la sombra
  const W = cardW + MARGIN * 2
  const H = cardH + MARGIN * 2

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const cx0 = MARGIN, cy0 = MARGIN

  // sombra suave + caja
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.28)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 10
  roundRectPath(ctx, cx0, cy0, cardW, cardH, 40)
  ctx.fillStyle = pal.card
  ctx.fill()
  ctx.restore()
  if (pal.border) {
    roundRectPath(ctx, cx0, cy0, cardW, cardH, 40)
    ctx.strokeStyle = pal.border
    ctx.lineWidth = style === 'doodle' || style === 'comic' || style === 'lineart' ? 4 : 3
    ctx.stroke()
  }

  const wa = await loadImage(WA_ICON).catch(() => null)
  const textX = cx0 + PAD + ICON + GAP
  const textMaxW = (cx0 + cardW - PAD) - textX

  let ry = cy0 + PAD
  for (const c of rows) {
    const iconCx = cx0 + PAD + ICON / 2
    const iconCy = ry + ICON / 2
    const kind = c.kind === 'website' ? 'web'
      : (c.kind === 'correo' || c.kind === 'mail') ? 'email'
      : (c.kind === 'tel' || c.kind === 'whatsapp') ? 'phone'
      : c.kind
    let text = ''
    let textColor = pal.text
    if (kind === 'phone') {
      if (wa) ctx.drawImage(wa, cx0 + PAD, ry, ICON, ICON)
      text = String(c.value).trim()                            // número tal cual
      textColor = pal.text
    } else if (kind === 'web') {
      drawGlobe(ctx, iconCx, iconCy, ICON, pal.accent)
      text = cleanDomain(c.value)
      textColor = pal.accent
    } else { // email
      drawEnvelope(ctx, cx0 + PAD, ry, ICON, pal.accent)
      text = String(c.value).trim()
      textColor = pal.accent
    }
    const px = fitFont(ctx, text, textMaxW, c.kind === 'phone' ? 56 : 42)
    ctx.font = `bold ${px}px ${FONT}`
    ctx.fillStyle = textColor
    ctx.textBaseline = 'middle'
    ctx.fillText(text, textX, iconCy + 2)
    ry += ICON + ROW_GAP
  }

  const buf = canvas.toBuffer('image/png')
  await fs.promises.writeFile(outPath, buf)
  return { width: W, height: H, path: outPath }
}
