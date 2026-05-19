# CLAUDE.md — mackree-ai-worker

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Worker FFmpeg productivo para MackreeAI.** Corre en Docker en Easypanel (`worker-mackree-ai.kqlrkv.easypanel.host`). Recibe `POST /render {jobId, userId}` desde el Vercel del SaaS, baja assets de Supabase Storage, renderiza con FFmpeg + Whisper + ASS captions, sube `output.mp4` y dispara callback. Arquitectura general en `README.md`.

---

## 🧠 FILOSOFÍA DEL PRODUCTO — INAMOVIBLE (Javier 2026-05-19)

**Regla cero del producto MackreeAI:**

> **TODO lo técnico / de calidad / de edición profesional = INAMOVIBLE EN BACKEND. El cliente NO tiene toggle, NO ve la opción, NO puede desactivarlo. Se aplica automático a TODO render.**
>
> **Solo lo que es PREFERENCIA ESTÉTICA PERSONAL queda como elección del cliente** (música, empresa, descripción del video — porque son su gusto / contenido, no calidad técnica).

**Implicancia técnica:** las reglas técnicas viven en el código del worker (este repo) como hard-coded values. NUNCA como flags del `manifest` opt-in/opt-out. Si un cliente quiere desactivar algo técnico (ej. "no quiero captions") → la respuesta es "usá otra app". Es regla de marca del producto, no preferencia.

**Lista actualizada al 2026-05-19 madrugada (v26):**

### INAMOVIBLES (cliente NO ve, siempre on)
1. Reducción ruido audio (`afftdn=nr=50 + highpass=100`) — v20+
2. Normalización dinámica `dynaudnorm` — v20+
3. Loudnorm EBU R128 + alimiter voz protagonista — v20+
4. Silence trim per-clip pre-Whisper (`0.30/-25/0.05`) — v25
5. **Word-gap cuts via Whisper (gaps > 0.4s)** — v26 (reemplaza dB para clips ruidosos)
6. Muletillas diccionario ES/EN (eh/uhm/este/etc.) — v20+
7. Vocales prolongadas ("Eeeeeh", "Iiiii") con thresholds 0.4/0.5/0.6s — v20 INAMOVIBLE específico
8. Trabazones `isStutter` ("m-mucho", "es-estamos") — v20+
9. Clip-bridge repetitions (palabras repetidas entre clips) — v20 INAMOVIBLE específico
10. LLM false-starts/retakes (Claude Sonnet detecta tomas falsas) — v20+
11. **Captions ASS karaoke** (toggle removido del SaaS) — v24
12. **Logo top-right 240px** — v24
13. Imágenes IA fullscreen 3s (Claude Haiku + nano-banana) — v22+
14. Estabilización deshake + unsharp + color eq — v4+

### Cliente ELIGE (preferencia estética)
- **Música** (12 géneros o "Sin música") — su gusto
- **Empresa** (cuando haya multi-empresa Creator/Pro) — qué brand usar
- **Descripción del video** (es su INPUT, no técnico)

### Próxima inamovible (sesión SFX)
- **SFX sincronizados** (whoosh/ding/boom/etc. en momentos clave del transcript) — LLM decide cuándo, cliente no ve la opción

**REGLA OPERATIVA INAMOVIBLE para sesiones futuras:**

Cuando Javier pida un cambio nuevo, preguntate: **¿es técnico/calidad o estético/preferencia?**
- Técnico/calidad → **INAMOVIBLE backend.** Agregalo al código del worker hard-coded. NO crear toggle en el SaaS. Documentarlo acá como inamovible.
- Estético/preferencia → **opción en el SaaS** (dropdown/toggle/input). Worker recibe el valor en el `manifest`.

Si dudás → asumí técnico/inamovible. Es más fácil agregar toggle después que quitarlo (cada toggle que se quita rompe UX de clientes existentes).

---

## ⛔ DECISIONES INAMOVIBLES — protegidas entre sesiones

> Estas decisiones **JAMÁS se reabren ni se revierten sin pedido explícito de Javier.** Si una nueva sesión de Claude está por modificar alguna de estas líneas → **DETENERSE y leer este archivo primero.** El problema operativo que motivó esta sección: en sesiones previas se perdieron ajustes aprobados al cerrar/abrir sesión, lo que provocó retrocesos (Javier: "hacemos 3 pasos adelante y volvemos 2, perdemos tiempo y crédito").

### 1. Denoise del audio — `afftdn` solo SUBE, jamás baja

**Trayectoria histórica (git log):**

| Commit | Cambio | Razón |
|---|---|---|
| `3ea040c` (2026-05-17) | `nr=10` | inicial |
| `9e06e68` | `nr=10 → nr=25` | observabilidad captions |
| `abecc30` | `nr=25 → nr=35` | "Javier pide ruido aún menor" |
| **2026-05-18** | **`nr=35 → nr=50` + `highpass=f=100`** | **"se escucha mucho ruido demasiado"** |

**Regla operativa:** cualquier sesión futura que considere ajustar el denoise — solo en dirección de **MÁS** reducción de ruido (siguiente escalón: `nr=60`, después `arnndn` con modelo `.rnnn`). **NUNCA bajar `nr`.** Esto está cableado en `lib/render.js` línea ~669 con un comentario que apunta acá.

### 2. Muletillas vocales prolongadas — TODA la lista es INAMOVIBLE

**Trasfondo (Javier 2026-05-18):** "Cada persona es diferente, en mi caso yo digo mucho EEeeeeh y Iiiiii. Pueden haber otros que usen Aaaa o vocales completas. Sé agresivo e inamovible con esto." Investigado en web (RAE / Wikipedia speech disfluency / Babbel) — la lista debe cubrir TODO el rango de vocales prolongadas + combinaciones con M/H.

**Tres mecanismos de detección — los tres protegidos:**

#### 2.1. Diccionario simple `FILLER_ES` + `FILLER_EN`

**Cubre las variantes prolongadas explícitas** (más rápido que regex). NO quitar ninguna de la sección "Vocales prolongadas" aunque alguien pida "menos agresividad" en otra sección. Si se baja agresividad, se hace en:
- Frases multi-palabra (`FILLER_PHRASES`) — ajustable
- Muletillas léxicas ambiguas (`pues`, `nada`, `literalmente`, etc.) — ya quitadas, no devolver
- Silence trim (sección 4 abajo) — ajustable

**Lista cubierta (no eliminar):** `eh/ehh/ehhh/eeee/eeeh`, `ah/ahh/aaaa/aaah`, `iii/iiii/iiiiii`, `oh/ohh/ooo/ooooh`, `uh/uhh/uuu`, `mm/mmm/mmmm/hmm/hmmm/mhm`, `uhm/um/umm/ummm/em`, `er/err/erm`.

#### 2.2. `isSustainedSound()` — regex `^[aeiouhy]+$` + repetición de char

Captura cualquier vocal prolongada con repetición de letra (length>=2). **`y` está incluido a propósito** para casos como "yyyy" (muletilla típica de algunas personas en español). **NO quitar `y` del regex.**

#### 2.3. `isProlongedShortWord()` — threshold por duración temporal

**Valores inamovibles:**
```javascript
const threshold = 0.3 + t.length * 0.1  // 0.4 / 0.5 / 0.6 segundos
```

Captura cuando Whisper colapsa "Eeeeeh" a "e" (1 char) o "eh" (2 chars) pero la duración delata la prolongación. **Confirmado funcionando** en render `f1203785` (2026-05-18). **NO suavizar este threshold.**

**Regla operativa global:** cuando Javier pida "menos agresividad de cortes", la decisión por defecto es **NO tocar nada de esta sección 2** y modificar SOLO silence trim (sección 4) + frases multi-palabra. Solo tocar muletillas vocales si Javier lo pide **explícitamente y nombrando alguna específica.**

### 3. Palabra-puente entre clips — `detectClipBridgeRepetitions` NO se toca

**Función protegida:** `lib/fillerWords.js` → `detectClipBridgeRepetitions()` con constantes `MIN_LEN=4, MAX_GAP=2.5, INTRO_GUARD=3.0`.

**Por qué (explicado por Javier 2026-05-18):** cuando un clip termina con una palabra X y el siguiente empieza con X, es una **técnica de continuidad** que Javier usa al grabar. En postproducción se elimina **una de las dos** ocurrencias (la que mejor suene, mejor armonía, mejor continuidad) para evitar la redundancia. El detector ya lo hace marcando la SEGUNDA ocurrencia para corte.

**Resultado esperado:** la palabra-puente debe aparecer **una sola vez** en el video final. Si aparece dos veces = bug del detector (NO de la regla).

### 4. Silence cuts — **v26 WORD-GAP based INAMOVIBLE (reemplaza silencedetect dB-based)**

**Por qué cambiamos de dB-based a word-gap based (2026-05-19 madrugada):**

Tras 2 renders consecutivos (v24 con 0.55/-32/0.12, v25 con 0.30/-25/0.05), ambos reportaron `silence_removed_sec: 0` aunque Javier confirmó AUDIBLEMENTE que hay silencios largos. Causa raíz: clips de cámara/celular tienen ambient noise (rumble, AC, viento) tan alto que NINGÚN umbral dB razonable los clasifica como silencio. Si subiéramos a `-20` o `-15 dB`, empezaría a cortar partes de voz suave. El approach dB-based es estructuralmente insuficiente para clips reales.

**Solución v26 (INAMOVIBLE):** usar timestamps word-level de Whisper para detectar pausas semánticas.

**Cómo funciona** (`lib/wordGaps.js`):
- Whisper ya transcribe word-by-word con `start`/`end` por palabra
- Entre cada par de palabras consecutivas: `gap = word[i+1].start - word[i].end`
- Si `gap > 0.4s` → pausa real (no depende del ruido ambiente)
- Cortar con padding 0.10s a cada lado (preserva respiración inmediata)
- Intro guard 2.5s (preserva saludo/apertura) + outro guard 1.5s (preserva cierre)

**Integrado en `applyContentTrim`** junto a las otras 3 detecciones (filler dictionary + clip-bridge + LLM false-starts). Todo se mergea en `allRanges` y se corta de una vez.

**Por qué SÍ funciona donde dB falla:**
- Whisper sabe DÓNDE hay palabras (semántica) — no le importa el ruido de fondo
- Si Javier se queda callado pensando → NO hay palabras → gap detectado → cortar
- Si la cámara tiene rumble de fondo todo el tiempo → Whisper lo ignora (no es palabra), gap igual se detecta

**Valores INAMOVIBLES v26:**
```javascript
detectWordGaps(words, {
  minGapSec: 0.4,        // cualquier gap > 0.4s entre palabras = pausa real
  padding: 0.10,         // deja 0.10s de aire a cada lado del corte
  introGuardSec: 2.5,    // NO cortar gaps que terminen antes de 2.5s
  outroGuardSec: 1.5,    // NO cortar gaps que empiecen después de totalDur-1.5s
})
```

**Trayectoria histórica del silence trim:**
| Versión | Approach | Resultado |
|---|---|---|
| v8 | `silencedetect` dB 0.80/-30 | Inicial conservador |
| v14 | `silencedetect` dB 0.35/-28 (super-agresivo) | Funcionó en algunos clips |
| v24 | `silencedetect` dB 0.55/-32 (suavizado) | `silence_removed_sec: 0` en clip real |
| v25 | `silencedetect` dB 0.30/-25 (mega-agresivo) | `silence_removed_sec: 0` IGUAL (ambient noise mata) |
| **v26** | **Whisper word-gaps > 0.4s** | **INAMOVIBLE — funciona con ambient noise** |

**Nota:** el `trimSilences` per-clip ANTES de Whisper sigue activo (cortes baseline dB con umbrales v25 mega-agresivo 0.30/-25/0.05). Sirve como primera capa para clips MUY ruidosos donde igual hay tramos quietos detectables. Pero el corte REAL viene de `wordGaps` después de Whisper. **Doble protección.**

**Regla operativa INAMOVIBLE:** NO volver al approach dB puro. Si en el futuro alguien quiere "subir agresividad", el dial es `minGapSec` (bajar a 0.30s = más agresivo, subir a 0.55s = más conservador) o `padding` (bajar a 0.05s = más punchy). NO tocar los thresholds dB del trimSilences pre-Whisper.

---

### 4b. Silence trim PER-CLIP pre-Whisper — capa baseline (v25 valores se mantienen)

**Valores INAMOVIBLES 2026-05-19 v25** en `lib/render.js` (sección `wantSilenceTrim` ~línea 598):
```javascript
trimSilences(item.filePath, workDir, label, {
  minSilenceDur: 0.30,   // cualquier pausa > 0.3s se corta (Reels/high-energy)
  noiseDb: -25,           // captura silencios 'ruidosos' (rumble cámara, fan, etc.)
  padding: 0.05,          // corte casi sin aire, ritmo punchy
})
```

**Trayectoria histórica:**
| Versión | minSilenceDur | noiseDb | padding | Resultado |
|---|---|---|---|---|
| v8 | 0.80 | -30 | 0.10 | Inicial conservador |
| v14 | 0.35 | -28 | 0.05 | "Super agresivo" |
| v24 | 0.55 | -32 | 0.12 | Suavizado por pedido Javier ("10→7") |
| **v25** | **0.30** | **-25** | **0.05** | **MEGA-AGRESIVO basado en fuentes expertas (Rendi + Descript)** |

**Por qué v24 falló** (Javier 2026-05-19 madrugada): render real reportó `silence_removed_sec: 0` con clip que TENÍA silencios audibles. Causa: `-32 dB` es umbral de podcast (ambiente muy quieto); en Reels con cámara real hay rumble continuo que supera -32 dB y por eso "nada califica como silencio". Subir a `-25 dB` captura los silencios "ruidosos" reales.

**Fuentes expertas consultadas:**
- [Rendi.dev FFmpeg Silence Detection API](https://docs.rendi.dev/silence-detection-removal): para speech `noise=-25 dB`, `d=0.3s`
- [Descript Silence Remover docs](https://www.descript.com/tools/silence-remover): high-energy YouTube/Reels usa thresholds 0.3-0.5s
- Tabla por tipo de contenido: Reels=0.3s · Educational=0.5-0.8s · Podcast=0.8-1.0s · Tutorial=preservar pausas

**Regla operativa INAMOVIBLE:** **NO suavizar estos valores** salvo pedido explícito de Javier nombrando el caso de uso específico (ej. "para Mac Gyver tutoriales largos quiero 0.5s en lugar de 0.3s"). Default v25 es Reels/high-energy. Si llegan otros tipos de cliente, agregar un parametro `manifest.contentType: 'reel' | 'tutorial' | 'podcast'` y switchear umbrales — NO modificar default.

### 5. Voz y música — reglas del editor de video manual aplican acá también

- **Voz protagonista:** `volume=1.3 + alimiter=limit=0.95` (regla #2 del editor manual, validada).
- **Música según tipo:** commercial=0.06, personal=0.12 (regla #3 — cableada en `render.js` línea ~696: `musicVol = isCommercial ? 0.06 : 0.12`).
- **No cambiar estos valores** salvo pedido explícito.

### 6. Logo top-right — siempre visible si el manifest lo trae, tamaño 240px INAMOVIBLE

Cableado en `lib/render.js` ~líneas 517 (renderCreate) y 752 (renderEdit). **`scale=240:-1`** + `overlay=W-w-30:30`. Si Javier sube logo en su brand identity, debe aparecer.

**Trayectoria del tamaño del logo:**
- v1-v23: `scale=140:-1` (~13% del frame 1080px). Javier dijo "muy chico".
- **v24 (2026-05-19): `scale=240:-1` (~22% del frame)** — branding visible, comparable a watermarks de Reels comerciales.

**NO bajar de 240px** salvo pedido explícito de Javier. Si en futuro pide más grande (280, 300), solo subir.

### 7. Captions ASS karaoke — INAMOVIBLE siempre on

Cableado en `lib/render.js` líneas 545 (renderCreate) y 778 (renderEdit). **`const wantCaptions = true`** (ignora `manifest.captions`).

**Regla del producto (Javier 2026-05-19):** "es regla de marca del producto". Todo render lleva captions burned-in con ASS karaoke (Whisper word-level timestamps, color verde limón `#80FF00` con palabra activa). El cliente NO tiene toggle para desactivar.

El toggle Captions fue **removido del dashboard SaaS** en commit del 2026-05-19 (ver `mackree-ai/`). El worker ya ignora el valor del manifest aunque el SaaS lo siga mandando por compat.

---

## ⚠️ Errores documentados — NO repetir

1. **No tener queue en `server.js`** (referencia: error #15 del editor de video). Disparar 2 `POST /render` en paralelo (sea por el usuario o por retry del front Vercel) puede sobrecargar el contenedor. **Pendiente arreglar:** agregar semaphore de 1 render concurrente. Hasta que se haga, regla operativa: nunca asumir que hay queue.

2. **Perder ajustes entre sesiones** (incidente 2026-05-18). Javier reportó que ajustes aprobados de denoise se "perdieron" al cambiar de sesión. Causa probable: cambios locales que nunca se commitearon, o que se sobrescribieron por un commit posterior. **Fix de proceso:** este archivo `CLAUDE.md` es la fuente de verdad de decisiones aprobadas — cualquier sesión nueva debe leerlo ANTES de tocar `render.js` o `fillerWords.js`.

3. **Hacer 2 cambios a la vez sin confirmar.** Cuando Javier pide ajustar X, Claude no debe asumir que también quiere ajustar Y aunque parezca relacionado. Ejemplo del 2026-05-18: pidió bajar agresividad de cortes y casi suavicé también `isProlongedShortWord` — eso habría roto el corte de sus "Eeeeeh" personales. Corregido por Javier en el momento.

4. **Confundir "PUENTE" con xfade visual.** En este worker no hay xfade entre clips (la concat usa corte duro). Cuando Javier dice "palabra puente" se refiere a la **técnica de continuidad lingüística** descrita en sección 3 arriba, no a una transición visual. Documentado para futura sesión.

5. **Asumir que el usuario disparó 2 renders cuando ve 2 rows en DB.** (Incidente 2026-05-18.) Si aparecen 2 jobs muy seguidos con mismo `user_id` pueden venir de retry automático del front-end o doble insert del handler — NO acusar al usuario sin evidencia. Investigar siempre la causa real.

6. **Asumir que un push a GitHub = deploy live en Easypanel.** (Incidente 2026-05-18 ~21:15 UTC.) Los pasos GitHub-push → Easypanel-build → contenedor-restart **NO son atómicos**. Es posible que:
   - El webhook de GitHub entregue OK (status 200) → ✅
   - Easypanel compile la nueva imagen Docker exitosamente → ✅
   - **Pero el contenedor activo NO se reinicie** y siga sirviendo la imagen vieja → ❌
   
   Síntoma: `/health` sigue reportando la `BUILD_VERSION` vieja indefinidamente. Confusión típica del operador (Javier): mira "Implementaciones" en Easypanel → ve OK verde → asume que v_nueva está live → dispara render → el render sale con v_vieja.
   
   **Confirmación 100% confiable de versión activa:**
   ```bash
   curl -sS https://worker-mackree-ai.kqlrkv.easypanel.host/health
   # campo "version" = lo que realmente está corriendo
   ```
   
   **Fix manual:** Easypanel → servicio worker → botón **"Reiniciar"** (↻) o "Detener" + "Iniciar". Eso fuerza pick-up de la imagen Docker más reciente.
   
   **Mejora futura:** después de cada push relevante, verificar `/health` reporte la `BUILD_VERSION` esperada antes de declarar deploy "completado". No confiar solo en el status del webhook ni en el indicador verde de Easypanel.

---

## Proceso obligatorio antes de tocar `render.js` o `fillerWords.js`

1. **Leer este archivo completo.** Cada sección "INAMOVIBLE" es no negociable.
2. **Leer `git log -p -- lib/render.js | head -200`** para entender la trayectoria reciente de los parámetros.
3. **Si vas a cambiar un valor numérico, justificarlo:** ¿hacia dónde se mueve históricamente este parámetro? ¿Estás respetando la dirección establecida?
4. **Cuando Javier aprueba un cambio:** committearlo de inmediato. NO dejar cambios sin commit entre sesiones.
5. **Cuando un render queda aprobado:** documentar acá el `jobId`, qué parámetros se usaron, qué quedó bien, qué quedó por mejorar.

---

## Renders aprobados de referencia (no borrar)

| Render | jobId | Cuándo | Versión worker | Aprobación |
|---|---|---|---|---|
| 1 | `f1203785-20f8-4cf4-bac4-040cecffb28a` | 2026-05-18 20:47-20:57 UTC (9:36 min) | `v19-perf-parallel-whisper` | Aprobado inicial. |
| 2 | `e19068f1-ae91-40bf-a3ec-80454dc27fc1` | 2026-05-18 21:31-21:41 UTC (9:51 min) | `v19-perf-parallel-whisper` | Aprobado. |
| 3 | `85e66fb3-cff6-4319-8acb-b32b81b724c9` | 2026-05-18 21:55-22:05 UTC (9:55 min) | `v19-perf-parallel-whisper` | "Me fascinó, aprobado" — Javier creía v20 pero contenedor seguía v19. |
| 4 | `0ebeb265-3872-41b9-98fd-aa25e2b30901` | 2026-05-18 23:32-23:42 UTC (9:46 min) | **`v20-quieter-audio-softer-cuts`** ✅ | **APROBADO INAMOVIBLE** (Javier 23:46 UTC). Disparado por API directa al worker reutilizando assets del render #3. Trim stats idénticos a v19, diferencia audible en denoise audio. |
| 5 | `f0c52034-b303-4639-a134-5e05c6bf1c97` | 2026-05-19 ~01:16 UTC | `v23-music-12-genres-pro-prompts` | Primer render con stack completo v23. `music:'none'` → Suno NO se ejecuta. Pass 3 imágenes IA SÍ se intenta. Disparado desde dashboard ya rediseñado con dropdowns. |

**Estado al 2026-05-19 madrugada:** **v23 es el comportamiento LIVE del worker.** Incluye v20 (audio + cortes inamovibles) + v21 (música Suno V5 automática) + v22 (imágenes IA automáticas) + v23 (12 géneros de música con prompts pro).

### Valores inamovibles del audio + cortes (v20, no cambiar)
`afftdn=nr=50 + highpass=f=100`, silence-trim `0.55/-32/0.12`, diccionario muletillas expandido (vocales prolongadas + sin ambiguas como pues/nada/literalmente), `isSustainedSound` con `y`, `isProlongedShortWord` thresholds `0.4/0.5/0.6s` (sin tocar), `detectClipBridgeRepetitions` sin tocar. **NO retroceder.** Cualquier sesión futura que considere modificar estos valores requiere pedido explícito de Javier.

### Nuevos módulos 2026-05-18 noche → 2026-05-19 madrugada

| Módulo | Qué hace | Trigger |
|---|---|---|
| `lib/kie-music.js` | Genera música de fondo con Kie Suno V5 instrumental. 12 géneros con prompts pro: urban, acoustic, cinematic, latin, electronic, corporate, rock, lofi, epic, funk, pop. Polling cada 5s, timeout 5min. Fallback graceful sin música. | `manifest.music !== 'none'` + no hay `music.mp3` subido + `KIE_AI_API_KEY` presente |
| `lib/kie-image.js` | Genera imágenes IA con Kie nano-banana-2 (Gemini 3.1 Flash, 4K, 9:16). `generateImagesForMomentsParallel` para batch. Polling cada 3s, timeout 2min/imagen. | Llamado por pass 3 (ver abajo) |
| `lib/llm-moments.js` | Claude Haiku 4.5 analiza transcript word-level de Whisper y devuelve hasta 5 momentos clave + prompts visuales en inglés para nano-banana. ~$0.01/render. | Pass 3 |
| Pass 3 nuevo en `lib/render.js` | Después del pass 2 (captions): detectar momentos LLM → generar N imágenes Kie en paralelo → overlay fullscreen 9:16 alpha=0.85 durante 3s con corte duro. Fallback graceful. | `style === 'commercial'` + `words.length > 0` + `ANTHROPIC_API_KEY` + `KIE_AI_API_KEY` + `manifest.aiImages !== 'off'` |

### TODO arquitectural pendiente (multi-empresa)

El trigger del pass 3 está hard-coded a `style === 'commercial'` por compat con el render aprobado v20. Pero el dashboard del SaaS ya NO muestra el toggle commercial/personal (commit `dac4f84` + fix build `210a8c7` 2026-05-19) — fue reemplazado por dropdown "Empresa" que carga `brand_identities` del user. Internamente el SaaS sigue mandando `style:'commercial'` siempre. **Cuando el backend del SaaS implemente multi-empresa real** (tier Creator/Pro = N brands por user, hoy solo 1), el trigger del worker debe cambiar a `Boolean(manifest.selectedCompany)` y el prompt del LLM debe incluir contexto de la empresa elegida (industria, brand colors, productos). Esto es trabajo del SaaS (mackree-ai/), no del worker.

### Costo aproximado por render con todas las features

| Pieza | Cost | Cuándo se ejecuta |
|---|---|---|
| FFmpeg base + Whisper + ASS captions | $0 (incluido en compute Easypanel) | Siempre |
| Kie Suno V5 (música, ~3 min audio) | ~$0.05-0.10 | Si `music !== 'none'` |
| Claude Haiku 4.5 (LLM moments) | ~$0.01 | Si `commercial + words` |
| Kie nano-banana-2 ×5 imágenes | ~$0.20 ($0.04 c/u) | Si `commercial + words` |
| **Total render con TODO activado** | **~$0.26-0.31** | — |

### Catálogo SFX (commit `2b21052`, 2026-05-19)

40 SFX gratis de uso comercial (Pixabay + Freesound) organizados en `sfx/<categoria>/`:

| Categoría | Cantidad | Uso típico |
|---|---|---|
| `whoosh/` | 11 | Transición rápida, corte de escena |
| `ding/` | 4 | Énfasis en palabra clave, número, dato |
| `swoosh/` | 4 | Zoom in/out, movimiento de cámara |
| `boom/` | 6 | Impacto, reveal final, riser |
| `pop/` | 6 | Aparición de texto/imagen |
| `sparkle/` | 5 | Destello, momento wow |
| `click/` | 4 | UI sutil (usar con moderación) |

**Catálogo:** `sfx/catalog.json` con `{categories, hints}` para el LLM. Total 4.6 MB en Docker image (despreciable).

**Estado:** archivos disponibles en el contenedor pero **NO integrados al render todavía**. Próxima sesión: `lib/llm-sfx.js` (LLM elige timestamps + categorías) + `amix` en pass 3 con SFX como inputs extra. Bump a v25 cuando se haga.

---

## Stack rápido

| Capa | Detalle |
|---|---|
| Runtime | Node 22, Express, FFmpeg (Docker) |
| Pipeline | `downloadJobAssets` → `renderJob` (create o edit mode) → `uploadOutput` → `postCallback` |
| Audio chain (edit mode) | `aresample=44100 → highpass=100 → afftdn=nr=50 → dynaudnorm → format` por clip; después concat → `loudnorm I=-16:LRA=11:TP=-1.5` → mix con música → `alimiter=limit=0.95` |
| Video chain (edit mode) | `setpts → scale → crop → fps → setsar → deshake (si motion>1) → unsharp → eq → format` |
| Captions | Whisper word-level → ASS karaoke con `Impact 76px`, color verde limón `&H0000FF80` |
| Build version | leer `BUILD_VERSION` en `server.js` (actual: `v19-perf-parallel-whisper`) |

---

## Deploy

Cambios al código → `git push origin main` → Easypanel auto-rebuild (~3-5 min) → `/health` debe mostrar el `version` nuevo.

Verificar deploy con:
```bash
curl https://worker-mackree-ai.kqlrkv.easypanel.host/health
# Debe responder {"ok":true,"version":"v19-...","ts":"..."}
```

Si `version` no cambió tras 5 min → forzar redeploy manual desde el panel de Easypanel.
