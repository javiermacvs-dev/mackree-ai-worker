// LLM-based detection of SFX placement moments.
// Analiza el transcript word-level de Whisper y devuelve timestamps + categorías
// para efectos de sonido, cada uno MOTIVADO por un evento real del contenido.
//
// Filosofía profesional (investigada 2026-05-24, ampliada 2026-07-18 con fuentes de
// sound design: SFX Engine, EseCut, Kukarella, Production Expert, Pixflow, Descript):
//   - MOTIVADO POR EVENTO, no por tiempo: cada SFX marca un evento perceptible
//     (transición narrativa, un dato/cifra/precio, el reveal del resultado, el CTA).
//     Si no hay evento → no hay SFX.
//   - LESS IS MORE: 3-5 acentos en TOTAL por Reel; 0-1 es válido en videos planos.
//     El relleno ("un SFX en cada corte/zoom/texto") es EXACTAMENTE lo que suena
//     amateur y de plantilla — el error #1 a evitar.
//   - VARIEDAD: no repetir el mismo archivo; no caer siempre en el mismo trío de
//     efectos. Reservar el impacto fuerte (boom) para 1-2 momentos (hook/reveal).
//   - La voz SIEMPRE manda: key SFX -12dB (0.25), subtle -16dB (0.16).
//   - Density: min 3s entre efectos (el silencio valoriza el siguiente acento).
//   - Timing offsets: whoosh/swoosh 100ms antes del corte; pop/boom on-frame;
//     ding/sparkle (remate) ~80ms después (el ojo procesa lo visual primero).
//
// Cost per job: ~$0.01 (Sonnet 4-6 — mejor razonamiento de estructura narrativa).

import Anthropic from '@anthropic-ai/sdk'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SFX_DIR = path.join(__dirname, '..', 'sfx')

// ── Professional timing offsets (seconds) per category ──────────────────────
// whoosh/swoosh: empiezan ANTES del corte (~3 frames @30fps ≈ 100ms), el pico cae en el corte.
// pop/click:     EXACTO en el frame (aparición de texto/elemento).
// boom:          EXACTO en el frame (golpe/impacto del reveal).
// ding/sparkle:  ~80ms DESPUÉS (remate: el ojo procesa lo visual, después el audio lo subraya).
const TIMING_OFFSETS = {
  whoosh:  -0.10,
  swoosh:  -0.10,
  boom:     0.00,
  pop:      0.00,
  click:    0.00,
  ding:    +0.08,
  sparkle: +0.05,
}

// ── Volume hierarchy: la voz es el rey (fuentes: Kukarella, Production Expert) ──
// Voz ref = 0dB (loudnorm I=-16). SFX normal -12..-16dB. El impacto puntual algo más.
const VOLUMES = {
  key:    0.25,  // -12dB: ding, boom (momentos de alto impacto)
  subtle: 0.16,  // -16dB: whoosh, swoosh, sparkle, pop, click (atmosférico)
}

const VOLUME_TIER = {
  boom:    'key',
  ding:    'key',
  whoosh:  'subtle',
  swoosh:  'subtle',
  sparkle: 'subtle',
  pop:     'subtle',
  click:   'subtle',
}

const MIN_GAP_SEC = 3.0  // Mínimo entre dos SFX (negative space — less is more)
const MAX_SFX     = 5    // Techo duro de acentos por video (research: 3-5)

// Palabras que suelen marcar un DATO/CTA (candidatas a ding/sparkle/pop). ES + EN.
const CTA_KEYWORDS = [
  'whatsapp', 'gratis', 'free', 'oferta', 'offer', 'descuento', 'discount', 'promo',
  'precio', 'price', 'ahora', 'now', 'hoy', 'today', 'sigue', 'sígue', 'follow',
  'suscri', 'subscribe', 'link', 'bio', 'dólar', 'dolar', 'dollar', 'pesos',
]

// Detecta momentos "ancla" en el transcript: palabras con NÚMERO (cifra, precio,
// medida) o palabras clave de CTA. Le dan al LLM anclas REALES en vez de que
// adivine. No fuerza SFX — son candidatos motivados por un dato concreto.
function findAnchorMoments(words) {
  const anchors = []
  for (const w of words) {
    const raw = (w.word ?? '').trim()
    if (!raw) continue
    const low = raw.toLowerCase()
    const hasNumber = /\d/.test(low)
    const isCta = CTA_KEYWORDS.some((k) => low.includes(k))
    if (hasNumber || isCta) {
      anchors.push({ time: Number((w.start ?? 0).toFixed(2)), word: raw, kind: hasNumber ? 'dato/número' : 'CTA' })
    }
  }
  return anchors
}

function buildSystemPrompt(hints) {
  return `Sos supervisor de diseño sonoro PROFESIONAL para videos verticales cortos (Reels, TikTok, Shorts) de negocios.

Tu trabajo NO es "llenar" el video de efectos. El error #1 del amateur — y lo que hace que un video se sienta de PLANTILLA — es meter un SFX en cada corte, cada zoom y cada texto. Un profesional usa el SILENCIO y reserva los efectos para los 3 a 5 momentos que de verdad importan. Vas a colocar POCOS efectos, cada uno anclado a un evento real.

⛔ REGLA DE ORO:
Cada SFX debe estar MOTIVADO por un EVENTO concreto. NUNCA pongas un efecto "para cumplir", "para distribuir parejo" ni "para llenar el silencio". Si no podés nombrar el evento exacto en el "reason" → ese SFX NO va. Devolver POCOS (o [] en un video plano) es lo correcto y casi siempre lo mejor.

MAPA EVENTO → SONIDO (usalo como guía, no como obligación de usar todos):
- TRANSICIÓN narrativa fuerte (el discurso cambia de sección: de presentar → a mostrar el trabajo; de proceso → a resultado) → whoosh o swoosh.
- APARICIÓN de un dato puntual: una CIFRA, un precio, una medida, el nombre de la marca/material clave → ding (o pop si es más suave).
- CTA / dato de acción ("escribinos", "seguinos", "hoy", una promo) → ding o sparkle.
- REVEAL del resultado final / clímax / el momento WOW (el "quedó increíble", el producto terminado) → boom UNA sola vez (el momento más fuerte de todo el video), o sparkle si es más sutil.
- CIERRE positivo, sensación de "quedó espectacular" → sparkle.

⚠️ VARIEDAD (crítico — el sistema viejo repetía SIEMPRE el mismo trío whoosh+ding+boom y se sentía clonado):
- NO uses el mismo patrón de efectos en todos los videos. Elegí lo que le sirve a ESTE video según sus beats reales.
- NO todos los videos necesitan un boom. Muchos funcionan mejor con 2-3 acentos sutiles y ningún impacto fuerte.
- Variá las categorías: si un video ya lleva un whoosh, el siguiente acento probablemente quiera OTRO tipo (ding, pop, sparkle), no otro whoosh.

CANTIDAD (TECHO, no meta — quedarse corto es BUENO):
- La mayoría de los Reels de 20-40s funcionan con 3 a 5 SFX en TOTAL. Videos planos: 0-1.
- NUNCA más de 1 SFX cada 3 segundos.
- boom: como mucho UNA vez en todo el video. Jamás dos.
- click: casi nunca (micro-detalle, con muchísima moderación).

ANCLAJE (usá los datos que te doy):
- Te paso el transcript con timestamps por palabra Y una lista de "momentos ancla" (palabras con número/precio/medida o de CTA). Los dings/sparkles/pops deben caer en esos momentos reales, no en tiempos inventados.
- Las transiciones (whoosh) van donde el DISCURSO cambia de sección (lo deducís del transcript), no en cualquier lado.

LA VOZ MANDA:
Los SFX se sienten POR DEBAJO de la voz (el sistema baja su volumen). No pongas un SFX tapando una palabra importante — ubicalo en el respiro entre frases o justo en la transición.

PROHIBICIONES:
- NO SFX en los primeros 2.5s (la apertura respira limpia).
- NO SFX en los últimos 1.5s.
- NO dos SFX a menos de 3s entre sí.
- NO boom + boom.
- NO un efecto decorativo sin evento que lo motive.

CATEGORÍAS DISPONIBLES:
${Object.entries(hints).map(([cat, desc]) => `- ${cat}: ${desc}`).join('\n')}

OUTPUT: ARRAY JSON puro. Sin markdown, sin texto fuera del JSON. Si nada justifica un SFX, devolvé [].
Por cada SFX:
- time (number): segundo exacto del evento (sin offsets — el sistema los aplica solo).
- category (string): una de las categorías disponibles.
- type (string): "key" (ding/boom en alto impacto) o "subtle" (el resto).
- reason (string): el evento concreto que lo motiva, específico. Si no hay reason concreto, NO lo incluyas.

Ejemplo válido (Reel 30s, 3 efectos, cada uno anclado a un evento real):
[
  {"time": 9.1, "category": "whoosh", "type": "subtle", "reason": "transicion de presentar el negocio a mostrar la instalacion"},
  {"time": 18.4, "category": "ding", "type": "key", "reason": "menciona el material clave por su nombre (ancla)"},
  {"time": 26.0, "category": "boom", "type": "key", "reason": "reveal del resultado final terminado"}
]

Ejemplo TAMBIÉN válido (video plano, sin eventos fuertes): []`
}

/**
 * detectSFXMoments(words, anthropicKey, totalDur)
 *  → Array<{time, category, type, volume, delay_ms, reason}>
 *
 * Devuelve [] si la key no está, no hay transcript, el modelo falla, o no hay
 * momentos. NUNCA lanza — graceful fallback.
 */
export async function detectSFXMoments(words, anthropicKey, totalDur) {
  if (!anthropicKey) {
    console.warn('[llm-sfx] ANTHROPIC_API_KEY missing — skipped')
    return []
  }
  if (!Array.isArray(words) || words.length === 0) {
    console.warn('[llm-sfx] no words from Whisper — skipped')
    return []
  }
  if (totalDur < 10) {
    console.log(`[llm-sfx] video too short (${totalDur.toFixed(1)}s) — skipped`)
    return []
  }

  let catalog
  try {
    const raw = await readFile(path.join(SFX_DIR, 'catalog.json'), 'utf-8')
    catalog = JSON.parse(raw)
  } catch {
    console.warn('[llm-sfx] sfx/catalog.json not readable — skipped')
    return []
  }

  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')
  const anchors = findAnchorMoments(words)
  const anchorsText = anchors.length
    ? anchors.map((a) => `  ${a.time}s "${a.word}" (${a.kind})`).join('\n')
    : '  (ninguno detectado — probablemente el video no tiene cifras/CTA fuertes)'
  const userMsg =
    `Duración total del video: ${totalDur.toFixed(1)}s.\n\n` +
    `MOMENTOS ANCLA detectados (palabras con número/precio/medida o de CTA — candidatos reales a ding/sparkle/pop):\n${anchorsText}\n\n` +
    `Transcript word-level (para deducir las transiciones narrativas y el reveal):\n${transcript}`

  let rawPlacements = []
  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      system: buildSystemPrompt(catalog.hints),
      messages: [{ role: 'user', content: userMsg }],
    })
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : ''
    // Extracción robusta: aunque el modelo agregue markdown o texto alrededor,
    // tomamos del primer '[' al último ']' (el array). Cae a [] si no hay array.
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end < start) {
      console.warn(`[llm-sfx] no JSON array in response: ${text.slice(0, 200)}`)
      return []
    }
    const parsed = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    rawPlacements = parsed
  } catch (e) {
    console.warn(`[llm-sfx] LLM parse failed: ${e?.message ?? e}`)
    return []
  }

  // ── Validar ────────────────────────────────────────────────────────────────
  const valid = rawPlacements
    .filter(
      (m) =>
        typeof m.time === 'number' &&
        typeof m.category === 'string' &&
        catalog.categories[m.category] !== undefined,
    )
    .filter((m) => m.time >= 2.0 && m.time <= totalDur - 1.5) // saltar intro/outro
    .sort((a, b) => a.time - b.time)

  // ── Enforce MIN_GAP_SEC ─────────────────────────────────────────────────────
  const gapped = []
  let lastTime = -Infinity
  for (const m of valid) {
    if (m.time - lastTime < MIN_GAP_SEC) continue
    gapped.push(m)
    lastTime = m.time
  }

  // ── Boom guard + offsets + volúmenes + techo MAX_SFX ────────────────────────
  const final = []
  let lastBoomTime = -Infinity
  for (const m of gapped) {
    if (final.length >= MAX_SFX) break   // techo duro de acentos por video
    if (m.category === 'boom' && m.time - lastBoomTime < 5.0) {
      console.log(`[llm-sfx] skip boom at ${m.time.toFixed(2)}s — too close to previous boom`)
      continue
    }
    if (m.category === 'boom') lastBoomTime = m.time

    const offset = TIMING_OFFSETS[m.category] ?? 0
    const adjustedTime = Math.max(0, m.time + offset)
    const delayMs = Math.round(adjustedTime * 1000)
    const volTier = VOLUME_TIER[m.category] ?? 'subtle'
    // Gain jitter pequeño (±8%) para que instancias del mismo tipo no suenen
    // idénticas entre videos. La voz sigue mandando (volúmenes bajos).
    const jitter = 0.92 + Math.random() * 0.16
    const volume = Number((VOLUMES[volTier] * jitter).toFixed(3))

    final.push({
      time: adjustedTime,
      category: m.category,
      type: m.type ?? 'subtle',
      volume,
      delay_ms: delayMs,
      reason: typeof m.reason === 'string' ? m.reason : '',
    })
  }

  console.log(
    `[llm-sfx] ${final.length} SFX placements (raw=${rawPlacements.length} valid=${valid.length} after_gap=${gapped.length} final=${final.length}, ${anchors.length} anchors)`,
  )
  for (const f of final) {
    console.log(`[llm-sfx]   ${f.time.toFixed(2)}s ${f.category} (${f.type}) vol=${f.volume} — ${f.reason || 'SIN REASON'}`)
  }
  return final
}

/**
 * pickVariedSFXFile(category, catalog, used)
 *  → ruta absoluta | null
 *
 * Elige un archivo de la categoría EVITANDO repetir los ya usados en este render
 * (`used` = Set de rutas). Si ya se usaron todos los de la categoría, resetea esa
 * categoría (permite reusar) pero prefiere siempre uno no-usado. Rompe el "siempre
 * los mismos" dentro de un mismo video.
 */
export function pickVariedSFXFile(category, catalog, used) {
  const files = catalog?.categories?.[category]
  if (!files || files.length === 0) return null
  const paths = files.map((f) => path.join(SFX_DIR, category, f))
  const fresh = paths.filter((p) => !used || !used.has(p))
  const pool = fresh.length > 0 ? fresh : paths
  const chosen = pool[Math.floor(Math.random() * pool.length)]
  if (used) used.add(chosen)
  return chosen
}

// Compat: alias del nombre viejo (por si algún caller externo lo importa).
export function pickRandomSFXFile(category, catalog) {
  return pickVariedSFXFile(category, catalog, null)
}
