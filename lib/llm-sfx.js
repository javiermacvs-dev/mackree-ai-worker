// LLM-based detection of SFX placement moments.
// Analyzes Whisper word-level transcript and returns timestamps + categories
// for sound effects, each MOTIVATED by a real content event (never filler).
//
// Filosofía profesional (investigada 2026-05-24, fuentes en CLAUDE.md "Catálogo SFX"):
//   - MOTIVADO POR EVENTO, no por tiempo: cada SFX marca una transición narrativa,
//     un dato/cifra clave, o el reveal del resultado. Si no hay evento → no hay SFX.
//   - LESS IS MORE: 2-4 SFX por Reel de 30s es lo normal; 0-1 es válido. Mejor
//     quedarse corto que rellenar. El relleno es lo que suena amateur ("por cumplir").
//   - La voz SIEMPRE manda: Key SFX -12dB (0.25), Subtle -16dB (0.16).
//   - Density: min 3s entre efectos ("negative space" valoriza el siguiente).
//   - Timing offsets: whoosh/swoosh 100ms early, boom/ding on-frame, sparkle 50ms late.
//   - boom: máximo UNA vez por video (el reveal más fuerte).
//
// Cost per job: ~$0.005 (Haiku 4.5)

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

const MIN_GAP_SEC = 3.0  // Minimum seconds between any two SFX (negative space — less is more)

function buildSystemPrompt(hints) {
  return `Sos supervisor de diseño sonoro PROFESIONAL para videos cortos (Reels, TikTok, Shorts).
Tu trabajo NO es "llenar" el video de efectos. Un editor amateur mete SFX por todos lados; un profesional usa el silencio y solo marca los momentos que de verdad importan. Vas a colocar MUY POCOS efectos, cada uno justificado por un evento real.

⛔ REGLA DE ORO (la más importante de todas):
Cada SFX debe estar MOTIVADO por un EVENTO concreto del contenido. NUNCA pongas un efecto "para cumplir", "para distribuir parejo" o "para llenar el silencio". Si un momento no tiene un motivo claro → NO lleva SFX. Es totalmente válido (y casi siempre mejor) devolver POCOS efectos, o incluso NINGUNO. Un SFX de relleno suena amateur y arruina el video.

QUÉ CUENTA COMO "EVENTO" QUE JUSTIFICA UN SFX:
- TRANSICIÓN narrativa fuerte: el discurso cambia de tema/sección (ej. pasa de presentar el problema a mostrar la solución, o de hablar a mostrar el trabajo). → whoosh / swoosh
- DATO concreto que se quiere subrayar: una cifra, un número, un precio, un beneficio puntual, el nombre de la marca/material clave. → ding / pop
- REVEAL del resultado final / clímax / el momento WOW (el "antes vs después", el producto terminado, la gran presentación). → boom (UNA sola vez, en el momento más fuerte) o sparkle
- CIERRE positivo, la sensación de "quedó increíble". → sparkle

CÓMO DECIDIR (proceso obligatorio, en orden):
1. Leé el transcript e identificá la ESTRUCTURA del video: apertura → desarrollo/proceso → dato o beneficio clave → reveal del resultado → cierre/CTA.
2. Marcá SOLO los momentos (entre 1 y 4) donde de verdad PASA algo que un sonido REFORZARÍA.
3. Para cada candidato escribí su "reason" (el evento exacto que lo motiva). Si no podés escribir un reason específico y concreto → ese SFX NO va.
4. Ante la duda, NO lo pongas. Menos es más.

CANTIDAD (esto es un TECHO, no una meta — quedarse corto es BUENO):
- La mayoría de los Reels de 20-40s funcionan con 2 a 4 SFX en TOTAL.
- Si el video es plano (sin reveal ni datos fuertes), 0-1 SFX es lo correcto.
- NUNCA más de 1 SFX cada 3 segundos.
- boom: como mucho UNA vez en todo el video (el reveal más fuerte). Jamás dos.
- click: casi nunca. Solo micro-detalle, con muchísima moderación.

LA VOZ MANDA:
Los SFX se "sienten" por debajo de la voz, nunca compiten con ella (el sistema baja su volumen: key=-12dB, subtle=-16dB). No coloques un SFX justo encima de una palabra importante tapándola — ponelo en el respiro entre frases o en el corte.

PROHIBICIONES:
- NO SFX en los primeros 2.5s (la apertura/saludo respira limpio).
- NO SFX en los últimos 1.5s.
- NO dos SFX a menos de 3s entre sí.
- NO boom + boom.
- NO pop + click juntos.
- NO un efecto "decorativo" que no tenga un evento que lo motive.

CATEGORÍAS DISPONIBLES:
${Object.entries(hints).map(([cat, desc]) => `- ${cat}: ${desc}`).join('\n')}

OUTPUT: ARRAY JSON puro. Sin markdown, sin texto fuera del JSON. Si nada justifica un SFX, devolvé [].
Por cada SFX:
- time (number): segundo exacto del evento (sin offsets — el sistema los aplica solo).
- category (string): una de las categorías disponibles.
- type (string): "key" (boom/ding en alto impacto) o "subtle" (el resto).
- reason (string): el evento concreto que lo motiva, en pocas palabras. Si no hay un reason concreto, NO incluyas el SFX.

Ejemplo válido (Reel de 30s — 3 efectos, todos motivados por un evento real):
[
  {"time": 8.4, "category": "whoosh", "type": "subtle", "reason": "transicion de presentar el vehiculo a mostrar la instalacion"},
  {"time": 17.2, "category": "ding", "type": "key", "reason": "menciona el material clave por su nombre"},
  {"time": 25.0, "category": "boom", "type": "key", "reason": "reveal del resultado final terminado"}
]

Ejemplo TAMBIÉN válido (video plano, sin eventos fuertes): []`
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
      reason: typeof m.reason === 'string' ? m.reason : '',
    })
  }

  console.log(
    `[llm-sfx] ${final.length} SFX placements (raw=${rawPlacements.length} valid=${valid.length} after_gap=${gapped.length} final=${final.length})`,
  )
  // Trazabilidad: log del motivo de cada SFX. Si alguno sale "sin reason" o con
  // motivo flojo → señal de relleno; endurecer el prompt o filtrar por reason.
  for (const f of final) {
    console.log(`[llm-sfx]   ${f.time.toFixed(2)}s ${f.category} (${f.type}) — ${f.reason || 'SIN REASON'}`)
  }
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
