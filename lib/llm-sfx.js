// LLM-based detection of SFX placement moments.
// Analyzes Whisper word-level transcript and returns timestamps + categories
// for sound effects synchronized with video animations (zoom, cuts, reveals, etc.)
//
// Uses professional SFX mixing guidelines:
//   - Volume hierarchy: Voice 0dB ref → Key SFX -12dB (0.25) → Subtle SFX -16dB (0.16)
//   - Density: max 1 SFX every 2s, "negative space" between effects
//   - Timing offsets: whoosh/swoosh 100ms early (before visual cut),
//                     boom/ding exactly on frame, sparkle 50ms late
//   - Orchestra rule: max 1 low (boom) + 1 mid (whoosh/swoosh) + 1 high per simultaneous
//   - Forbidden combos: Boom+Boom within 5s, Pop+Click simultaneously
//
// Cost per job: ~$0.005 (Haiku 4.5, ~800 tokens in, ~300 tokens out)

import Anthropic from '@anthropic-ai/sdk'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SFX_DIR = path.join(__dirname, '..', 'sfx')

// ── Professional timing offsets (seconds) per category ──────────────────────
// whoosh/swoosh: fire BEFORE the visual cut (3 frames @ 30fps ≈ 100ms early)
// boom/ding:     EXACTLY on the frame (0ms offset)
// sparkle:       1-2 frames AFTER the visual (+50ms — "magic lands")
// pop/click:     exactly on the frame
const TIMING_OFFSETS = {
  whoosh:  -0.10,
  swoosh:  -0.10,
  boom:     0.00,
  ding:     0.00,
  sparkle: +0.05,
  pop:      0.00,
  click:    0.00,
}

// ── Volume hierarchy: professional SFX mixing (EBU / Rode / Izotope guidelines) ──
// Voice reference = 0dB. Key SFX = -12dB (×0.25). Subtle SFX = -16dB (×0.16)
const VOLUMES = {
  key:    0.25,  // -12dB: boom, ding (high-impact moments)
  subtle: 0.16,  // -16dB: whoosh, swoosh, sparkle, pop, click (atmospheric)
}

// Category → volume tier
const VOLUME_TIER = {
  boom:    'key',
  ding:    'key',
  whoosh:  'subtle',
  swoosh:  'subtle',
  sparkle: 'subtle',
  pop:     'subtle',
  click:   'subtle',
}

const MIN_GAP_SEC = 2.0  // Minimum seconds between any two SFX

function buildSystemPrompt(hints) {
  return `Sos supervisor de diseño sonoro para videos de redes sociales (Reels, TikToks, Shorts).
Analizás transcripciones Whisper word-level y colocás efectos de sonido (SFX) sincronizados con los momentos clave del audio y video.

CATEGORÍAS DISPONIBLES:
${Object.entries(hints).map(([cat, desc]) => `- ${cat}: ${desc}`).join('\n')}

REGLAS PROFESIONALES DE COLOCACIÓN:
1. DENSIDAD: máximo 1 SFX cada 2-3 segundos. Dejar "negative space" entre efectos — el silencio valoriza el siguiente SFX.
2. UBICACIÓN (cuándo colocar cada categoría):
   - whoosh/swoosh: en transiciones rápidas, cambios de tema, zoom in/out → el SFX va justo ANTES del corte (el sistema ajusta -100ms automáticamente)
   - boom: en impactos fuertes, reveals finales, anuncios dramáticos, datos impactantes
   - ding: en palabras clave importantes, números, beneficios, CTA ("contactate", "escribinos", "WhatsApp")
   - sparkle: en momentos de brillo/wow, presentación del resultado final, cierre positivo
   - pop: cuando aparece un elemento visual clave, dato, cifra, marca
   - click: sutil, solo para micro-interacciones UI — usar con mucha moderación
3. REGLA ORQUESTA: no más de 1 bajo (boom) + 1 medio (whoosh/swoosh) + 1 alto (sparkle/ding/pop/click) simultáneos.
4. PROHIBICIONES ABSOLUTAS:
   - NO boom+boom dentro de 5s entre sí
   - NO pop+click al mismo tiempo
   - NO SFX en los primeros 2s (saludo/apertura del video)
   - NO SFX en los últimos 1.5s (cierre/CTA final)
   - NO más de 1 SFX cada 2s
5. DISTRIBUCIÓN: los SFX deben estar distribuidos a lo largo de todo el video, no amontonados.
   - Video <20s → máximo 2-3 SFX
   - 20-40s → 3-5 SFX
   - 40-60s → 5-7 SFX
   - >60s → 7-10 SFX
6. TIPO: "key" para momentos de alto impacto (boom, ding en datos importantes), "subtle" para el resto.
   El sistema asigna volumen: key=-12dB, subtle=-16dB (la voz SIEMPRE gana).

OUTPUT: ARRAY JSON puro. Sin markdown. Sin explicaciones. Si el video es muy corto (<10s) o nada destaca, devolvé [].
Por cada SFX:
- time (number): segundo exacto donde disparar (sin considerar offsets — el sistema los aplica solo)
- category (string): una de las 7 categorías disponibles
- type (string): "key" o "subtle"

Ejemplo válido:
[
  {"time": 3.2, "category": "whoosh", "type": "subtle"},
  {"time": 6.8, "category": "ding", "type": "key"},
  {"time": 14.5, "category": "boom", "type": "key"},
  {"time": 22.1, "category": "sparkle", "type": "subtle"}
]`
}

/**
 * detectSFXMoments(words, anthropicKey, totalDur)
 *  → Array<{time, category, type, volume, delay_ms}>
 *
 *  - words:        Array de { word, start, end } de Whisper
 *  - anthropicKey: ANTHROPIC_API_KEY del worker
 *  - totalDur:     duración total del video en segundos
 *
 * Devuelve [] si la key no está, no hay transcript, el modelo falla, o no hay momentos.
 * NUNCA lanza excepción — graceful fallback.
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

  // Load catalog for hints (must exist in Docker image)
  let catalog
  try {
    const raw = await readFile(path.join(SFX_DIR, 'catalog.json'), 'utf-8')
    catalog = JSON.parse(raw)
  } catch (e) {
    console.warn('[llm-sfx] sfx/catalog.json not readable — skipped')
    return []
  }

  const transcript = words.map((w) => `[${(w.start ?? 0).toFixed(2)}s] ${w.word}`).join(' ')
  const userMsg = `Duración total del video: ${totalDur.toFixed(1)}s.\n\nTranscript word-level:\n${transcript}`

  let rawPlacements = []
  try {
    const client = new Anthropic({ apiKey: anthropicKey })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: buildSystemPrompt(catalog.hints),
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
    rawPlacements = parsed
  } catch (e) {
    console.warn(`[llm-sfx] LLM call failed: ${e?.message ?? e}`)
    return []
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  const valid = rawPlacements
    .filter(
      (m) =>
        typeof m.time === 'number' &&
        typeof m.category === 'string' &&
        catalog.categories[m.category] !== undefined,
    )
    .filter((m) => m.time >= 2.0 && m.time <= totalDur - 1.5) // skip intro/outro
    .sort((a, b) => a.time - b.time)

  // ── Enforce MIN_GAP_SEC between consecutive SFX ───────────────────────────
  const gapped = []
  let lastTime = -Infinity
  for (const m of valid) {
    if (m.time - lastTime < MIN_GAP_SEC) continue
    gapped.push(m)
    lastTime = m.time
  }

  // ── Enforce Boom+Boom within 5s + apply timing offsets + volumes ──────────
  const final = []
  let lastBoomTime = -Infinity
  for (const m of gapped) {
    if (m.category === 'boom' && m.time - lastBoomTime < 5.0) {
      console.log(`[llm-sfx] skip boom at ${m.time.toFixed(2)}s — too close to previous boom`)
      continue
    }
    if (m.category === 'boom') lastBoomTime = m.time

    const offset = TIMING_OFFSETS[m.category] ?? 0
    const adjustedTime = Math.max(0, m.time + offset)
    const delayMs = Math.round(adjustedTime * 1000)
    const volTier = VOLUME_TIER[m.category] ?? 'subtle'
    const volume = VOLUMES[volTier]

    final.push({
      time: adjustedTime,
      category: m.category,
      type: m.type ?? 'subtle',
      volume,
      delay_ms: delayMs,
    })
  }

  console.log(
    `[llm-sfx] ${final.length} SFX placements (raw=${rawPlacements.length} valid=${valid.length} after_gap=${gapped.length} final=${final.length})`,
  )
  return final
}

/**
 * pickRandomSFXFile(category, catalog) → absolute path string | null
 */
export function pickRandomSFXFile(category, catalog) {
  const files = catalog?.categories?.[category]
  if (!files || files.length === 0) return null
  const chosen = files[Math.floor(Math.random() * files.length)]
  return path.join(SFX_DIR, category, chosen)
}
