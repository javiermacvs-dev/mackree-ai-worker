// WS13 — Títulos de impacto (kinetic text). DISTINTO de los subtítulos:
//  - Subtítulos = TODAS las palabras (karaoke), abajo, continuo, accesibilidad.
//  - Títulos de impacto = SOLO frases clave (1 a varias palabras), grandes, arriba-centro,
//    animadas ("pop"), en los momentos de mayor fuerza de la narración. Sirven para RETENCIÓN.
//
// Metodología El Cursales (R18 "títulos centrados en personas", R12 "plantar semilla",
// R15 "curiosidad"): el título engancha mejor cuando remarca la SITUACIÓN/EMOCIÓN/RESULTADO
// que vive el espectador, no el producto. Elegimos las frases de mayor impacto del guión.
//
// Coste por job: ~$0.01 (Haiku 4.5). Fallback TOTAL: ante cualquier fallo devuelve [] →
// el render sigue sin títulos (nunca rompe el video). Misma filosofía que detectKeyMoments.

// Respaldo OpenAI: Anthropic sin saldo dejaba este modulo mudo (2026-08-31).
// LLMClient es drop-in de Anthropic — misma interfaz .messages.create().
import { LLMClient } from './llm-fallback.js'

function buildSystemPrompt(maxTitles) {
  const langLine =
    'Los títulos van en el MISMO idioma que la transcripción de abajo (NO traduzcas: si la voz está en inglés, los títulos en inglés; si está en español, en español).'
  return `Sos editor de video de formato corto (Reels/TikTok/Shorts), experto en RETENCIÓN.
Tu tarea: elegir las FRASES DE IMPACTO que aparecerán como TÍTULOS GRANDES animados en pantalla
(arriba-centro), encima del video, en el momento exacto en que se dicen. NO son los subtítulos
(esos son aparte, todas las palabras abajo). Son solo los GOLPES de la narración.

Recibís la transcripción word-level (con timestamps en segundos) de la voz.

QUÉ ELEGIR (máximo ${maxTitles}):
1. EL GANCHO de los primeros segundos (la frase que detiene el scroll). Casi siempre va uno acá.
2. El DATO/RESULTADO sorprendente o el contraste fuerte ("imposible no verlo", "en 5 horas").
3. El BENEFICIO o la EMOCIÓN que vive el cliente/espectador (enfocado en la PERSONA, no en specs).
4. El REMATE / llamado a la acción final si es potente.

REGLAS DE LOS TÍTULOS:
- CORTOS: 1 a 4 palabras (máximo 5). Son un golpe visual, no una oración. Si la frase es larga,
  quedate con el NÚCLEO ("Imposible no verlo", "5 horas", "Tu flota a juego").
- VERBATIM o casi: usá palabras que REALMENTE se dicen en ese tramo, para que el título caiga
  sincronizado con la voz. Está bien recortar la frase a su núcleo.
- DISTRIBUIDOS: no todos juntos. Dejá al menos ~5s entre un título y el siguiente.
- NO repitas el mismo título dos veces.
- NUNCA un número de teléfono, URL, correo ni arroba como título.
- MENOS es más: 2-3 títulos BIEN elegidos > 8 de relleno. Si la narración no tiene golpes
  claros, devolvé pocos (o []). Forzar títulos genéricos arruina el efecto.

${langLine}

OUTPUT: ARRAY JSON puro (sin markdown). Por cada título:
- text (string): la frase corta de impacto (1-5 palabras). Sin comillas, sin emojis.
- startSec (number): segundo donde la voz EMPIEZA a decir esa frase (de los timestamps).
- endSec (number): segundo donde termina de decirse (típico startSec + 1.5 a 3s).

Ejemplo (narración sobre el wrap de un food truck):
[
  {"text": "5 horas", "startSec": 2.1, "endSec": 4.0},
  {"text": "Imposible no verlo", "startSec": 21.5, "endSec": 24.0},
  {"text": "Tu marca rodando", "startSec": 38.0, "endSec": 40.5}
]`
}

/**
 * detectImpactTitles(words, anthropicKey, opts?) → Array<{ text, startSec, endSec }>
 *  - words: Array de { word, start, end } de Whisper (timestamps en segundos)
 *  - anthropicKey: ANTHROPIC_API_KEY del worker
 *  - opts.maxTitles: tope de títulos (default según duración)
 *  - opts.script / opts.description: contexto del tema (mejora la elección)
 *  - opts.lang: 'es' | 'en' (idioma de la narración)
 * Devuelve [] si falta la key, no hay transcripción, el modelo falla o no hay nada de impacto.
 */
export async function detectImpactTitles(words, anthropicKey, opts = {}) {
  if (!anthropicKey) {
    console.warn('[impact-titles] ANTHROPIC_API_KEY missing — skipped')
    return []
  }
  if (!Array.isArray(words) || words.length === 0) {
    console.warn('[impact-titles] no words from Whisper — skipped')
    return []
  }

  const totalDur = words[words.length - 1]?.end ?? 0
  if (totalDur < 6) {
    console.log(`[impact-titles] video too short (${totalDur}s) — skipped`)
    return []
  }

  // Densidad por duración: pocos, bien puestos (MENOS es más).
  const byDur = totalDur < 20 ? 3 : totalDur < 40 ? 4 : totalDur < 70 ? 6 : 8
  const maxTitles = Math.max(2, Math.min(8, opts.maxTitles || byDur))

  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')
  const extraCtx = []
  if (opts.description) extraCtx.push(`Descripción del proyecto: ${String(opts.description).slice(0, 400)}`)
  if (opts.script) extraCtx.push(`Guión narrado: ${String(opts.script).slice(0, 700)}`)
  const ctxBlock = extraCtx.length ? `CONTEXTO:\n${extraCtx.join('\n')}\n\n` : ''
  const userMsg = `${ctxBlock}Duración total: ${totalDur.toFixed(1)}s. Máximo ${maxTitles} títulos.\n\nTranscript word-level:\n${transcript}`

  try {
    const client = new LLMClient({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: buildSystemPrompt(maxTitles),
      messages: [{ role: 'user', content: userMsg }],
    })
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : ''
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []

    // Validar + normalizar + de-solapar.
    const seen = new Set()
    let lastEnd = -999
    const valid = []
    for (const t of parsed) {
      if (typeof t.text !== 'string') continue
      const raw = t.text.trim().replace(/\s+/g, ' ')
      if (!raw) continue
      const wordCount = raw.split(' ').length
      if (wordCount > 6) continue // título demasiado largo → descartar
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      let start = typeof t.startSec === 'number' ? t.startSec : null
      let end = typeof t.endSec === 'number' ? t.endSec : null
      if (start == null) continue
      if (end == null || end <= start) end = start + 2.0
      // Acotar a la línea de tiempo del cuerpo (los títulos pueden ir desde t=0 — el HOOK
      // es el más importante; a diferencia de las ilustraciones IA, acá SÍ lo queremos temprano).
      start = Math.max(0, Math.min(start, Math.max(0, totalDur - 0.5)))
      end = Math.min(Math.max(end, start + 1.0), totalDur)
      if (end - start < 0.8) end = Math.min(start + 1.6, totalDur)
      if (start < lastEnd + 0.3) continue // evitar solape/pegado con el anterior
      seen.add(key)
      lastEnd = end
      valid.push({ text: raw, startSec: start, endSec: end })
      if (valid.length >= maxTitles) break
    }

    console.log(`[impact-titles] detected ${valid.length} impact titles (of ${parsed.length} returned)`)
    return valid
  } catch (e) {
    console.warn(`[impact-titles] failed: ${e?.message ?? e}`)
    return []
  }
}

// Escapa caracteres que romperían el ASS (llaves de override y backslash).
function escapeASS(s) {
  return String(s).replace(/\\/g, '').replace(/[{}]/g, '')
}

/**
 * buildTitlesASS(titles, { W, H }) → string ASS
 *  Capa de títulos de impacto: Impact GRANDE amarillo de marca (#FFF200) + borde negro grueso,
 *  arriba-centro (\an8, tercio superior — los subtítulos van abajo y SIEMPRE encima, #25),
 *  con animación "pop" (escala 70→110→100 + fade). Se quema DEBAJO del ASS de subtítulos.
 *  Devuelve '' si no hay títulos (el caller omite la capa).
 */
export function buildTitlesASS(titles, dims = {}) {
  const W = dims.W || 1080
  const H = dims.H || 1920
  if (!Array.isArray(titles) || titles.length === 0) return ''

  // Tamaño grande relativo al lado menor → consistente en 9:16 / 1:1 / 16:9.
  const size = Math.round(Math.min(W, H) * 0.092)
  const ol = Math.max(5, Math.round(size * 0.08)) // borde negro grueso
  const sh = Math.max(2, Math.round(size * 0.03))
  const mL = Math.round(W * 0.06)
  const mR = Math.round(W * 0.06)
  const mv = Math.round(H * 0.14) // distancia desde ARRIBA (an8), debajo del logo top-right

  // Amarillo de marca #FFF200 = ASS &H0000F2FF (AABBGGRR). Borde negro. Bold.
  const styleLine = `Style: Title,Impact,${size},&H0000F2FF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${ol},${sh},8,${mL},${mR},${mv},1`

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const lines = [header]
  for (const t of titles) {
    const txt = escapeASS(t.text).toUpperCase()
    if (!txt) continue
    // Animación "pop": entra al 70%, sobrepasa a 110% y se asienta a 100% + fade in/out.
    const anim = '{\\fscx70\\fscy70\\t(0,120,\\fscx110\\fscy110)\\t(120,260,\\fscx100\\fscy100)\\fad(90,160)}'
    lines.push(`Dialogue: 0,${sToASSt(t.startSec)},${sToASSt(t.endSec)},Title,,0,0,0,,${anim}${txt}`)
  }
  return lines.join('\n')
}

function sToASSt(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.round((s % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
