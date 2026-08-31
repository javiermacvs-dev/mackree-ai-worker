// Respaldo OpenAI para las llamadas a Anthropic del WORKER (2026-08-31).
//
// Contexto: la cuenta de Anthropic está sin saldo desde el 2026-08-14 y
// devuelve 400 "credit balance is too low" en TODAS las llamadas. El SaaS ya
// tenía su respaldo (src/lib/llm-fallback.ts, commit 88c0d25), pero el worker
// NO — y sus 7 módulos LLM "degradan con gracia", es decir: se saltan en
// silencio. Consecuencia real, invisible en los logs para el cliente:
//   · NO salen los TÍTULOS DE IMPACTO (impact-titles.js)   ← lo que reportó Javier
//   · NO salen las ILUSTRACIONES en momentos clave (llm-moments.js)
//   · NO salen los SFX inteligentes (llm-sfx.js)
//   · NO se recortan retakes (llmTrim.js), ni se ordenan recursos por narración
//     (llm-resource-sync.js), ni se detecta el tema real (llm-theme-context.js)
//   · La PORTADA cae a su texto genérico (cover.js)
// El video se completaba igual, por eso nadie vio un error.
//
// Este helper es un DROP-IN de `new Anthropic({apiKey})`: expone la misma
// interfaz `.messages.create(params)` y devuelve la respuesta en formato
// Anthropic (`{ content: [{ type:'text', text }] }`), así los 7 módulos no
// cambian ni una línea de su lógica de parseo. Intenta Anthropic PRIMERO; si
// falla por cualquier causa, repite contra OpenAI. Cuando Anthropic vuelva a
// tener saldo el respaldo deja de activarse solo — no hay que revertir nada.
//
// Traduce también los bloques de IMAGEN (Vision) que usan llm-theme-context.js
// y llm-resource-sync.js: `{type:'image', source:{type:'base64', media_type, data}}`
// → `{type:'image_url', image_url:{url:'data:<media_type>;base64,<data>'}}`.

import Anthropic from '@anthropic-ai/sdk'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

// Equivalencias de capacidad para el respaldo.
const MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'gpt-4o-mini',
  'claude-sonnet-4-6': 'gpt-4o',
}
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

function systemToString(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
  }
  return String(system)
}

// Un bloque de contenido Anthropic → su equivalente OpenAI (o null si no aplica).
function blockToOpenAI(c) {
  if (typeof c === 'string') return { type: 'text', text: c }
  if (!c || typeof c !== 'object') return null
  if (c.type === 'text' && typeof c.text === 'string') return { type: 'text', text: c.text }
  if (c.type === 'image' && c.source?.type === 'base64' && c.source?.data) {
    const mt = c.source.media_type || 'image/jpeg'
    return { type: 'image_url', image_url: { url: `data:${mt};base64,${c.source.data}` } }
  }
  return null
}

function messagesToOpenAI(messages) {
  return (messages ?? []).map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    const parts = (m.content ?? []).map(blockToOpenAI).filter(Boolean)
    // Si es solo texto, mandarlo plano (más compatible con modelos sin visión).
    const soloTexto = parts.every((p) => p.type === 'text')
    return {
      role: m.role,
      content: soloTexto ? parts.map((p) => p.text).join('\n') : parts,
    }
  })
}

async function callOpenAI(params, apiKey) {
  const sys = systemToString(params.system)
  const body = {
    model: MODEL_MAP[params.model] ?? DEFAULT_OPENAI_MODEL,
    max_tokens: params.max_tokens,
    messages: [
      ...(sys ? [{ role: 'system', content: sys }] : []),
      ...messagesToOpenAI(params.messages),
    ],
  }
  if (typeof params.temperature === 'number') body.temperature = params.temperature

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`openai ${res.status}: ${detail.slice(0, 200)}`)
  }
  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  // Devolvemos la MISMA forma que Anthropic para no tocar a los llamadores.
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _via: 'openai' }
}

/**
 * Drop-in de `new Anthropic({ apiKey })` con respaldo OpenAI.
 * Uso idéntico: `new LLMClient({ apiKey }).messages.create({ model, max_tokens, system, messages })`
 */
export class LLMClient {
  constructor(opts = {}) {
    const anthropicKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
    const client = anthropicKey
      ? new Anthropic({ apiKey: anthropicKey, maxRetries: opts.maxRetries ?? 2 })
      : null

    this.messages = {
      create: async (params) => {
        let primerError = null
        if (client) {
          try {
            return await client.messages.create(params)
          } catch (err) {
            primerError = err
          }
        }
        const openaiKey = process.env.OPENAI_API_KEY
        if (!openaiKey) throw primerError ?? new Error('sin ANTHROPIC_API_KEY ni OPENAI_API_KEY')
        const motivo = primerError instanceof Error ? primerError.message.slice(0, 160) : 'sin key Anthropic'
        console.warn(`[llm-fallback] Anthropic falló → respaldo OpenAI (${params.model}): ${motivo}`)
        return await callOpenAI(params, openaiKey)
      },
    }
  }
}

export default LLMClient
