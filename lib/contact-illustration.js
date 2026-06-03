// contact-illustration.js — animación de CONTACTO como ILUSTRACIÓN en el estilo
// gráfico elegido por el usuario (reemplaza la tarjeta canvas WS9).
//
// Pedido de Javier (2026-06-03, con ejemplo savoryx_trailer_v5.mp4 seg.21): cuando la
// voz menciona WhatsApp / web / correo, NO va una tarjeta estándar — va una ILUSTRACIÓN
// en la MISMA línea gráfica que el usuario eligió (doodle, neón, acuarela, etc.),
// específica de ese canal (un WhatsApp lindo, una web linda con ícono), con el DATO
// exacto SOBREIMPRESO en texto perfecto (auto-fit, nunca se sale). Muestras aprobadas.
//
// Patrón: genera la ilustración con el mismo motor de imágenes en estilo
// (kie-image.js + styles.js) y le sobreimprime el dato con ffmpeg drawtext (la IA NO
// dibuja el texto — lo deforma). Fallback TOTAL: si falla → null (no se muestra contacto).

import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { generateImageFromPrompt, downloadImageTo } from './kie-image.js'
import { stylePromptBase } from './styles.js'
import { cleanDomain } from './contact-card.js'

const execAsync = promisify(exec)
const fwd = (p) => p.replace(/\\/g, '/')

// Fuente bold para el drawtext del dato (Liberation en el Docker Linux; Arial en Windows local).
let FONTFILE = null
for (const p of [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
]) {
  try { if (fs.existsSync(p)) { FONTFILE = p; break } } catch { /* ignore */ }
}

// Canal normalizado: phone | website | email
export function normalizeContactKind(k) {
  const s = String(k || '').toLowerCase()
  if (s === 'website' || s === 'web') return 'website'
  if (s === 'email' || s === 'correo' || s === 'mail') return 'email'
  return 'phone' // phone | tel | whatsapp | default
}

// Sujeto de la ilustración por canal (la IA lo dibuja en el estilo elegido; el dato va aparte).
const SUBJECT = {
  phone: 'a smartphone showing the green WhatsApp logo with a chat speech bubble, a friendly character pointing at it with a thumbs up, welcoming pose, ONE clear focal subject',
  website: 'a web browser window open on a screen showing a nice website, with a clear globe internet icon, ONE focal subject',
  email: 'a friendly character holding a large envelope with an email symbol and a small @ sign, ONE clear focal subject',
}

const ORIENT = 'vertical portrait composition, full-frame, content upright and readable, NEVER rotated sideways, no 90-degree rotation, simple uncluttered layout with ONE focal subject and generous empty space'

/** Sanea el dato para drawtext (los `:` y comillas rompen el filtro). */
function safeText(s) {
  return String(s || '').replace(/[:'\\%]/g, '').trim()
}

/**
 * generateContactIllustration({ kind, value, style, workDir, apiKey, W, H, index })
 *   → ruta del JPG full-frame (ilustración en estilo + dato sobreimpreso) o null.
 * El dato lleva auto-fit (la fuente se achica para que NUNCA se salga del frame).
 */
export async function generateContactIllustration({ kind, value, style, workDir, apiKey, W, H, index = 0 }) {
  try {
    if (!apiKey) return null
    const channel = normalizeContactKind(kind)
    const subject = SUBJECT[channel] || SUBJECT.phone
    const prompt = `${stylePromptBase(style)}, ${ORIENT}. Subject: ${subject}`

    const { url } = await generateImageFromPrompt(prompt, {
      apiKey, aspectRatio: '9:16', resolution: '1K', outputFormat: 'jpg',
    })
    const raw = path.join(workDir, `contact_${channel}_${index}_raw.jpg`)
    await downloadImageTo(url, raw)

    // Dato exacto + color por canal. WhatsApp = verde (su marca); web/correo = blanco
    // con borde negro (legible sobre fondo claro u oscuro de cualquier estilo).
    const data = channel === 'website' ? cleanDomain(value) : String(value).trim()
    const safe = safeText(data)
    if (!safe) return raw // sin dato legible: al menos la ilustración
    const fontcolor = channel === 'phone' ? '0x25D366' : '0xFFFFFF'
    const bordercolor = channel === 'phone' ? '0xFFFFFF' : '0x000000'

    // Auto-fit: fontsize tal que el texto entre con margen (factor 0.55 = ancho medio Arial bold).
    const maxW = W - 90
    const fontsize = Math.min(56, Math.max(26, Math.floor(maxW / (Math.max(1, safe.length) * 0.55))))
    // ⚠️ El dato va en la franja SUPERIOR (debajo del logo top-right), NO abajo: los subtítulos
    // SIEMPRE van abajo (todos los estilos usan align=2, MarginV 80-240) y tapaban el número
    // (reporte Javier 2026-06-03 "el número quedó tapado por los subtítulos"). Arriba nunca se tapan.
    const yPos = Math.round(H * 0.16)

    const out = path.join(workDir, `contact_${channel}_${index}.jpg`)
    const drawtext = FONTFILE
      ? `,drawtext=fontfile='${fwd(FONTFILE)}':text='${safe}':fontsize=${fontsize}:fontcolor=${fontcolor}:borderw=6:bordercolor=${bordercolor}:x=(w-text_w)/2:y=${yPos}`
      : ''
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${drawtext}`
    await execAsync(`ffmpeg -y -i "${fwd(raw)}" -vf "${vf}" "${fwd(out)}"`, { timeout: 60000 })
    console.log(`[contact-illustration] ${channel} (${safe}) en estilo "${style || 'default'}" → ${path.basename(out)}`)
    return out
  } catch (e) {
    console.warn(`[contact-illustration] failed: ${e?.message ?? e}`)
    return null
  }
}
