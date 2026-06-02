# CLAUDE.md — mackree-ai-worker

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Worker FFmpeg productivo para Chixy.** Corre en Docker en Easypanel (`worker-mackree-ai.kqlrkv.easypanel.host`). Recibe `POST /render {jobId, userId}` desde el Vercel del SaaS, baja assets de Supabase Storage, renderiza con FFmpeg + Whisper + ASS captions, sube `output.mp4` y dispara callback. Arquitectura general en `README.md`.

---

## 🧠 FILOSOFÍA DEL PRODUCTO — INAMOVIBLE (Javier 2026-05-19)

**Regla cero del producto Chixy:**

> **TODO lo técnico / de calidad / de edición profesional = INAMOVIBLE EN BACKEND. El cliente NO tiene toggle, NO ve la opción, NO puede desactivarlo. Se aplica automático a TODO render.**
>
> **Solo lo que es PREFERENCIA ESTÉTICA PERSONAL queda como elección del cliente** (música, empresa, descripción del video — porque son su gusto / contenido, no calidad técnica).

**Implicancia técnica:** las reglas técnicas viven en el código del worker (este repo) como hard-coded values. NUNCA como flags del `manifest` opt-in/opt-out. Si un cliente quiere desactivar algo técnico (ej. "no quiero captions") → la respuesta es "usá otra app". Es regla de marca del producto, no preferencia.

**Lista actualizada al 2026-05-22 (v31):**

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
15. **SFX sincronizados AI-driven** (whoosh/ding/boom/pop/sparkle/swoosh/click en momentos clave del transcript) — **v31** ✅ Claude Haiku analiza el transcript Whisper y decide autónomamente qué efectos colocar, cuándo y a qué volumen. Reglas profesionales hard-coded: jerarquía de volumen (key -12dB / subtle -16dB), densidad máx 1 SFX/**3s**, guards boom+boom <5s, timing offsets por categoría, regla de orquesta. **Regla reescrita 2026-05-24** (Javier: "los pone por cumplir, sin sentido"): **MOTIVADO POR EVENTO, NO por cuotas de duración** — se eliminaron las cuotas tipo "20-40s → 3-5 SFX" (incentivaban relleno). Cada SFX exige un evento real (transición narrativa, dato/cifra, reveal del resultado); sin evento concreto → no va; 0-2 SFX bien puestos > relleno; `boom` máx 1/video; cada SFX declara un `reason` que queda en los logs para auditar. Cliente NO ve la opción, desactivable SOLO con `manifest.sfx: 'off'`.
16. **Timelapse REAL del footage (create mode)** — **v32** ✅ En el flujo de voz en off (`renderCreate`), cada clip de video se acelera para que el clip COMPLETO entre en su slot de narración (`segDur = voiceDur / nMedia`), en vez de mostrar solo los primeros `segDur` segundos. `speed = min(60, max(1, origDur/segDur))` vía `setpts=(PTS-STARTPTS)/speed` antes de `trim`. Un clip más corto que su slot (p.ej. el "reveal" final) se queda a 1x automáticamente. **SOLO en create mode** (clip mudo, la voz manda); **NUNCA en edit mode** (acelerar rompería la voz de la persona + captions Whisper + cortes word-gap). Cableado en `lib/render.js` rama de video de `renderCreate` (~línea 451). Fallback: si no se puede medir la duración → 1x (comportamiento previo).
18. **Transiciones automáticas (xfade cross-dissolve 0.35s)** — **v37** ✅ Entre segmentos en `renderCreate` (flujo voz en off). Para que el video dure igual que la voz pese al solapamiento, cada segmento se alarga a `segDurEff = (voiceDur+(N-1)*D)/N`; el fold de xfade (`offset(k)=k*(segDurEff−D)`) devuelve el total a `voiceDur` exacto. **Fallback a corte duro** si xfade falla o si los segmentos son muy cortos (`canXfade = N≥2 && segDurEff>D+0.1`), y opt-out técnico `manifest.transitions:'off'`. Validado con ffmpeg local (recipe + offsets + grafo combinado Ken Burns+timelapse+xfade). Pendiente: portar a edit mode (requiere xfade+acrossfade de audio + ajuste de offsets de captions). Cableado en `lib/render.js` `renderCreate` (`buildCmd`/`xfadeCombine`/`concatCombine`).
17. **Ken Burns (zoom/pan) en imágenes** — **v35** ✅ Las imágenes/doodles NUNCA salen estáticas: cada segmento de imagen lleva movimiento sutil (zoom-in lento 1.0→1.12, o pan horizontal izq/der), rotando por índice para dar variedad (estilo Santiago). Helper `imageMotionChain(src, out, segDur, variant)` en `lib/render.js` (~línea 425) con `zoompan` + pre-escala 2x para suavizar. Hoy aplica a los segmentos de imagen de `renderCreate`. Pendiente: extender a edit mode y a los overlays de imágenes IA del pass 3. La SELECCIÓN automática del efecto por IA (B3) llegará con `lib/llm-editing-effects.js`; por ahora rota determinísticamente.
19. **Corrección AUTOMÁTICA de nombres de marca en subtítulos** — **v39** ✅ Whisper escucha mal los nombres propios (ej. "Mac Gyver" → "gaiber"). `burnCaptions`/`buildASS` aplican `manifest.captionReplacements` (pares {from,to}, match palabra completa case-insensitive, `to` multi-palabra) a las words ANTES de armar el ASS (`applyCaptionReplacements` en `lib/render.js`). Las correcciones vienen de DOS fuentes que se suman: (a) **por-empresa, automáticas** — `saas.brand_identities.caption_corrections` (jsonb), el render route las inyecta en TODOS los videos de esa empresa (Mac Gyver ya sembrado: gaiber/gaibor/guiber/...→"Mac Gyver"); (b) **puntuales de MACtin** (ver abajo). **Regla:** los nombres de marca DEBEN salir bien escritos sin que el cliente los corrija. Si aparece una mala transcripción nueva, agregarla a `caption_corrections` de la marca (no parchear código).
20. **CTA de contacto animado (correo/teléfono/web)** — **v40 → generalizado v52** ✅ Cuando el video menciona el contacto, `burnCaptions` inserta badges verdes animados (caja #25D366 = `&H0066D325`, texto blanco, fade + slide-up) en el momento de la mención (fallback: cerca del cierre). **v52 (2026-06-01):** generalizado de 1 badge (solo WhatsApp) a **hasta 3 badges apilados** (teléfono/correo/web) según `manifest.contacts` = `[{kind,value}]` — los que el cliente marcó en el **checklist** del brief y la empresa tiene cargados (el SaaS arma el array en `api/generate/render`). `buildASS(words, styleKey, contactCtas)` + `burnCaptions({..., contacts})` + helper `formatContactCta` (phone→"WhatsApp N", web sin http://, email tal cual). **Back-compat total:** si no viene `contacts`, cae a `whatsappNumber` (= solo teléfono, comportamiento previo). Sin datos / sin checklist → no se muestra. Es preferencia del cliente CUÁLES salir (checklist), pero el badge en sí es regla de marca. DB: `video_jobs.contact_to_show` (qué mostrar) + `brand_identities.{whatsapp_number,contact_email,website_url}` (los valores). **✅ LIVE `v52-contact-overlays`, aprobado por Javier 2026-06-01.** **→ WS9 (v55-contact-card, 2026-06-02):** el badge verde PLANO se reemplazó por una **TARJETA generada** (`lib/contact-card.js` con `@napi-rs/canvas`) adaptada a la **PALETA del estilo visual elegido** (mapa de los 14 estilos; Nivel A aprobado por Javier — paleta, no textura), con **logo de WhatsApp** (PNG `assets/contact/whatsapp.png`, glifo handset U+1F4DE) + **globo web** (dibujado) / sobre (correo), **dominio limpio** (sin protocolo/www) y **auto-fit** del texto (nunca se sale). Se compone como **overlay PNG animado** (fade in/out) en `burnCaptions`, sincronizado con la mención de contacto en el transcript (regex ampliada con `síguenos|visita`). ⚠️ El PNG se carga con **`-loop 1 -t {dur}`** (sin loop el overlay no aparece — error #11). `buildASS` ya NO dibuja los badges (se llama con `[]`); `formatContactCta` queda como código muerto (back-compat). Diseño portado 1:1 del mockup PIL aprobado (`EDIT_VIDEO/tmp_contacto/`). **Validado E2E con ffmpeg local** (overlay sobre frame de prueba). Pendiente: aprobación final de Javier en un render real.
21. **Imágenes IA SIEMPRE derechas + SIMPLES (9:16 a pantalla completa)** — **v41→v42→v46** ✅ Evolución del fix: (v41) quitar "horizontal" del prompt — insuficiente solo; (v42) 16:9 + card centrada con blur — funcionaba pero dejaba la ilustración en una banda chica; (**v46, Opción 1 Javier 2026-05-24**) **las animaciones se generan SIMPLES** (UN sujeto, sin infografía densa ni labels múltiples) y en **9:16 (ratio del video) a PANTALLA COMPLETA** — al ser simples y verticales ya NO se acuestan y llenan el frame. **Por qué se pudo volver a 9:16:** la rotación pasaba con composiciones tipo infografía densa; con animaciones simples nano-banana las dibuja derechas en vertical. Cableado: `lib/styles.js` (doodle SIN "educational explainer style" — eso generaba las infografías recargadas; ahora "ONE single clear subject, minimal, NOT a dense infographic"), `lib/llm-moments.js` (sujetos SIMPLES, 1 idea, menos momentos), `lib/kie-image.js` (orientationDirective vertical + "simple uncluttered, one focal subject"), `lib/render.js` pass 3 fullscreen (`scale+crop`, `aa=0.92`) + llamadas con `aspectRatio:'9:16'`. **Verificado con imágenes reales (derechas + simples + full frame) antes de deployar.** ⚠️ La densidad se controla en el prompt: NO devolver "educational explainer style" a `styles.js` ni pedir infografías al LLM (eso recarga + reintroduce rotación).
22. **Intro glitch + outro blanco con logo (automático)** — **v43** ✅ Todo video con logo lleva intro (1.8s: logo grande + scanlines + aberración cromática RGB ±18px sobre gris) + outro (1.5s: logo sobre blanco + fade + destello blanco final), réplica de los Reels manuales (Carmen/Savoryx v5). `lib/intro-outro.js` (`addIntroOutro`) genera ambos clips y los concatena (filter concat) al final de `renderCreate`/`renderEdit` cuando hay `logoPath`. El logo PNG se **loopea** (`loop=loop=-1:size=1:start=0`; sin loop = 1 frame en t=0, no aparece — error #11 del editor manual). Sin logo → no se agrega. Graceful (si falla, video sin branding). Verificado visualmente con el logo de Mac Gyver.
23. **Sincronización de recursos con la narración** — **v47** ✅ (2026-05-28, pedido universal de Javier "que la imagen concuerde con lo que se está diciendo"). En `renderCreate`, ANTES de armar los segmentos, la IA mira cada recurso del cliente (imagen directa, o un frame del video extraído con ffmpeg) + el GUIÓN (`manifest.script`, ya en orden temporal) y devuelve la PERMUTACIÓN óptima para que cada recurso caiga en el tramo de la narración que le corresponde (el "resultado final" cerca del cierre, el proceso antes, etc.). Antes los recursos iban en ORDEN DE SUBIDA, sin relación con lo que dice la voz. Módulo `lib/llm-resource-sync.js` (`orderResourcesByNarration`, Haiku 4.5 Vision, ~$0.01/render). **Fallback TOTAL:** si no hay key/guión, falla, o no devuelve una permutación válida → `null` → el caller usa el orden original (cero regresión). Opt-out técnico: `manifest.resourceSync === 'off'`. Solo `create` mode (donde hay guión); en `edit` no aplica (la voz es del footage, el orden ya es el del cliente). Matching validado contra Anthropic con frames reales antes de integrar. **PENDIENTE:** validar con un render real (video con voz + varios recursos en orden mezclado → verificar que los reordena con sentido). Approach: solo Vision (los `manifest.fileLabels` del cliente como mejora futura para reforzar el matching).
24. **Modo "video 100% generado por IA" (Opción 3 / `generate_full_ai`)** — **v48** ✅ (2026-05-31). Cuando `manifest.generateMedia === true` (modo "Generar video con IA" del SaaS: el cliente NO sube footage, solo una descripción), `renderCreate` genera el LIENZO del video con IA ANTES del pass 1: helper `generateCanvasImages` (transcribe `voice.mp3` con Whisper → `detectScriptScenes` en `lib/llm-moments.js` divide el guion en N escenas CONSECUTIVAS que cubren todo el video → `generateImagesForMomentsParallel` genera N ilustraciones full-frame en el estilo elegido → las renombra a `media_01.jpg`…). A partir de ahí el resto del pipeline (Ken Burns, xfade, captions, música, voz 1.45, SFX, intro/outro, logo) corre IDÉNTICO tratándolas como media del cliente — **todos los inamovibles vienen gratis por reusar `renderCreate`**. Densidad: ~1 imagen cada 7s, mínimo 2, **tope 12** (acota costo Kie + tiempo). El transcript se reusa para los captions del pass 2 (evita doble Whisper). En este modo se SALTAN el pass-3 overlay (las imágenes YA son el lienzo, no overlay) y el resource-sync (las escenas ya vienen en orden narrativo). **Fallback TOTAL:** si falta ANTHROPIC/KIE key, no hay escenas, o fallan todas las imágenes → 0 media → `renderCreate` cae al fondo negro existente (piso aceptable, con warning). Gateado 100% por el flag `generateMedia` (ausente en los flujos actuales → cero impacto). Es `mode:'create'` (hay voz). **PENDIENTE: validar con un render real** (descripción tipo comercial → verificar que las N ilustraciones cubren el video, sincronizadas con la voz, con Ken Burns + transiciones + captions + música + intro/outro). Cliente NO ve toggle — es la elección de "experiencia" en el dashboard (las 3 cards), el alcance Nivel A (sin cards/contadores animados tipo HyperFrames, eso es fase 2).

25. **SUBTÍTULOS SIEMPRE AL FRENTE** — **v57** ✅ (Javier 2026-06-02, UNIVERSAL e INAMOVIBLE). Los captions NUNCA pueden quedar tapados por las animaciones (ilustraciones IA del pass de imágenes). **Orden de capas obligatorio: video base → imágenes IA → SUBTÍTULOS encima de todo.** En `renderCreate` se reordenó el pipeline: las imágenes IA se overlayean PRIMERO sobre `rawPath` (→ `captionBase`) y `burnCaptions` quema los subtítulos AL FINAL sobre esa base. En `renderEdit` (estructura más anidada por el content-trim) se re-quema el `.ass` de captions ENCIMA de las imágenes al final del pass de imágenes (`fc3.push(...ass=...[vcap])`, mapeando `[vcap]`). Ambos logran lo mismo: captions en la capa superior. **NUNCA** volver al orden viejo (captions → imágenes encima). La tarjeta de contacto (#20) también va por debajo de los captions (en `burnCaptions` el `ass` se aplica después del overlay de la tarjeta).

### Cliente ELIGE (preferencia estética)
- **Estilo de subtítulos** (v36 → **11 presets en v53**) — llega en `manifest.subtitleStyle`. Catálogo en `lib/subtitle-styles.js`; `buildASS(words, styleKey)` lo aplica; default `classic` = look actual EXACTO (cero regresión). Los captions siguen SIEMPRE on (inamovible #7) — solo cambia el LOOK, no se puede apagar. **Los 6 originales:** `classic`/`hormozi`/`tiktok_box`/`neon`/`minimal`/`duo`. **5 nuevos (v53, 2026-06-01):** `viral_pink` (Impact, activa rosa fuerte), `bubble` (caja VIOLETA de marca — BorderStyle=3 usa OutlineColour, no BackColour), `outline_orange` (activa naranja), `retro_karaoke` (todo amarillo, activa blanca), `elegant` (Liberation Serif, activa dorada). **Para agregar uno:** `lib/subtitle-styles.js` (params ASS) + `chixy/src/lib/subtitle-styles.ts` (union + label/desc/previewUrl) + preview `cap_<style>.mp4` en bucket `subtitle-previews` (generador `EDIT_VIDEO/style-samples/gen_subtitle_previews.mjs`, sube con `--upload`). ⚠️ **ASS BorderStyle=3 (caja): el color de la caja = OutlineColour, NO BackColour** (BackColour ahí es la sombra).
- **Música** (12 géneros, "Sin música", o **propia subida**) — su gusto. **WS10 (v56, 2026-06-02):** con música PROPIA, el endpoint `POST /music-fragments` (`lib/music-fragments.js`) corta 4 fragmentos de distintas partes de la canción (offsets 0/33%/66%/100% del rango, fade+loudnorm) y devuelve URLs firmadas; el cliente elige cuál parte suena en el paso "Música" del SaaS, y el render aplica `manifest.musicOffsetSec` (`-ss` en la música, create+edit). Back-compat: sin offset → desde el inicio.
- **Empresa** (cuando haya multi-empresa Creator/Pro) — qué brand usar
- **Descripción del video** (es su INPUT, no técnico)
- **Estilo visual de las ilustraciones IA** (v30→v54 2026-06-01) — **14 estilos**: `auto` = **"★ Estilo Chixy"** (el estilo de la casa, INSIGNIA — 1er lugar del dropdown) / `doodle` (default técnico/fallback) / `whiteboard` / `flat` / `isometric` / `claymation` / `watercolor` / `comic` / `lineart` / `render3d` / `neon` / `cinematic` / `papercut` / `sticker`. Es preferencia estética → dropdown en el SaaS, llega en `manifest.visualStyle`. Para agregar uno: `lib/styles.js` (prompt_base SIN orientación) + skill `~/.claude/skills/mackree-styles/style-catalog.json` (CON orientación) + `chixy/src/lib/visual-styles.ts` + thumbnails (`style-samples/gen_style_cards.mjs` + `upload_thumbnails.mjs`). **WS3 (v54, 2026-06-01):** `auto` dejó de ser un placeholder que caía a `doodle` — ahora es un estilo REAL en `STYLES` (línea gráfica del comercial respondele de Santiago: line-art editorial cálido, papel crema + glow durazno, acento verde sage, premium). `llm-moments.js` ya NO lo intercepta (usa `normalizeStyle` directo). En el SaaS usa el carrusel normal de 8 ejemplos como el resto. La KEY `auto` se conserva (no se renombró) para no migrar `video_jobs.visual_style` existentes.
- **Clips de video Seedance-2 en Opción 3** (v50 2026-05-31) — `generateCanvasImages` en `render.js` marca 2 escenas de acento como `kind:'video'` (primera=apertura, última=reveal) y genera clips reales via `lib/kie-video.js` (`bytedance/seedance-2`, mismo patrón createTask/recordInfo). El resto sigue como imágenes en el estilo elegido. En el loop de segmentos, clips generados (`isGeneratedClip`) van sin timelapse ni deshake pesado (velocidad nativa ±20%, eq suave). Fallback TOTAL: si un clip falla se genera imagen fija para esa escena. Cambiar a Kling cuando esté disponible: reemplazar `VIDEO_MODEL` en `lib/kie-video.js`. El worker lo aplica en `lib/styles.js` + `lib/llm-moments.js` (LLM devuelve solo el sujeto) + `lib/kie-image.js` (prepend del `prompt_base`). Reemplaza el viejo "cinematic photorealistic automotive" hardcodeado. Default `doodle` si el manifest no lo trae. Aplica en AMBOS flujos (edit + create con voz).

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

### 4. Silence cuts — **v27 WORD-GAP FORMULA APROBADA POR JAVIER (INAMOVIBLE FINAL)**

## 🔒 FÓRMULA EXACTA APROBADA — NO MODIFICAR JAMÁS

**Render que la validó:** `b311f719-816a-43ef-9528-a400732802e6` (2026-05-19 03:10-03:16 UTC)
**Veredicto Javier:** "ME GUSTÓ, ME FASCINÓ, APROBADO. Replicar esta fórmula para siempre"

**Configuración EXACTA en `lib/render.js` `applyContentTrim`:**
```javascript
const rawDur = await getMediaDuration(rawPath)
const gaps = detectWordGaps(words, {
  minGapSec: 0.30,        // gaps mid-speech mínimos a cortar
  padding: 0.10,          // aire a cada lado del corte (preserva respiración)
  minInitGapSec: 0.40,    // corta silencio INICIAL si > 0.40s
  minEndGapSec: 0.40,     // corta silencio FINAL si > 0.40s
  introGuardSec: 0.30,    // mini guard interno (no aplica a init cut)
  outroGuardSec: 0.30,    // mini guard interno (no aplica a end cut)
  totalDur: rawDur,
})
```

**Resultado validado en `b311f719`:**
- Original: 67.43s
- Final: **49.90s** (17.53s recortados, 26% más punchy)
- Cortes: 15 = `gap_init: 1` + `gap: 10` (mid) + `gap_end: 1` + `prolonged: 3`
- `silence_removed_sec`: 0 (capa dB pre-Whisper sigue activa pero NO contribuye en este caso — el word-gap hace todo el trabajo)

**🔒 Bloqueo permanente:**

Esta fórmula es **INAMOVIBLE PERMANENTE** por instrucción explícita de Javier ("replicá esa fórmula para siempre"). Cualquier sesión futura que:
- Cambie `minGapSec` (0.30s)
- Cambie `padding` (0.10s)
- Cambie `minInitGapSec` o `minEndGapSec` (0.40s)
- Cambie `introGuardSec` o `outroGuardSec` (0.30s)
- Elimine la llamada a `detectWordGaps` en `applyContentTrim`
- Vuelva al approach `silencedetect` dB-based (descartado en v25)

→ **DEBE PARAR Y CONSULTAR A JAVIER** antes de hacer el cambio. No es opcional. La fórmula está validada con render real y aprobada.

**Razón histórica completa** (en caso de duda):

| Versión | Approach | Resultado real |
|---|---|---|
| v8-v23 | `silencedetect` dB con varios umbrales | Funcionaba en algunos clips, fallaba en otros |
| v24 | dB 0.55/-32/0.12 (suavizado) | `silence_removed: 0` en clip Javier ❌ |
| v25 | dB 0.30/-25/0.05 (mega-agresivo) | `silence_removed: 0` IGUAL ❌ (ambient noise mata dB) |
| v26 | Whisper word-gaps > 0.4s, sin init/end | 9 cortes, 13.92s removidos. Mejora pero **faltaba init** |
| **v27** | **Whisper word-gaps > 0.30s + init + end** | **15 cortes, 17.61s removidos. APROBADO** ✅ |

**Fuentes técnicas que avalan la decisión:**
- [Rendi.dev FFmpeg API — silence detection](https://docs.rendi.dev/silence-detection-removal)
- [Descript blog — silence remover best practices](https://www.descript.com/blog/article/best-silence-remover-tools)
- Industria: Reels/high-energy usa 0.3-0.5s threshold, podcasts 0.8-1.0s

---

### 4b. Por qué dB-based falla y word-gap SÍ funciona (referencia técnica)

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

### 5. Voz y música — INAMOVIBLE (v29 valores aprobados)

- **Voz protagonista:** `volume=1.45 + alimiter=limit=0.95` (subida 1.3→1.45 en v45 a pedido de Javier; pasa por `loudnorm=I=-16`, así que el bump de volume refuerza pero loudnorm domina la sonoridad final — para subir la voz de verdad, el dial real es loudnorm I -16→-14).
- **Música según tipo (v45, Javier 2026-05-24 "voz más alta, música más baja"):**
  - **commercial: `0.09`** (bajado desde 0.12 — la voz debía destacar más)
  - **personal: `0.17`** (sin cambios)
- Cableado en `render.js`: `musicVol = isCommercial ? 0.09 : 0.17` (create + edit) + voz `volume=1.45` (create, línea ~552).
- **Trayectorias:** música comercial v27=0.06 → v28=0.10 → v29=0.12 → **v45=0.09**; voz 1.3 → **v45=1.45**. Próximos diales si Javier pide: más voz → loudnorm I -16→-14; menos música → bajar de 0.09. **Solo con pedido explícito.**
- **`amix` SIEMPRE con `normalize=0` (v38, INAMOVIBLE):** por defecto `amix` divide cada pista entre el nº de inputs → la voz quedaba a la mitad (mezcla voz+música) y aún más baja tras el pass de SFX (÷ 1+nº SFX); además la música quedaba tan abajo que solo se oía cuando la voz paraba (~final). Con `normalize=0` la voz se queda a su nivel pleno (loudnorm -16) y la música suena a 0.12 **desde el inicio**. El `alimiter=0.95` posterior evita clipping. Aplica a los 4 `amix` (voz+música y SFX, en create y edit). NO quitar `normalize=0`.

**Trayectoria histórica del volumen de música:**

| Versión | Commercial | Personal | Cambio | Razón |
|---|---|---|---|---|
| v25-v27 | `0.06` | `0.12` | inicial | Defaults del manual (regla #3 editor: comercial urbano 0.06, personal emotivo 0.12) |
| v28 (03:25 UTC) | `0.10` | `0.14` | +67% / +17% | Javier "un poquito más volumen" tras v27 aprobado |
| **v29 (10:30 EDT)** | **`0.12`** | **`0.17`** | **+20% / +20%** | Javier validó v28 audible, pidió "subir un poquito más" |

- **NO bajar de estos valores** sin pedido explícito. Si Javier pide más volumen otra vez, solo subir (siguiente escalón razonable: 0.14 / 0.20). Si pide bajar → SOLO si lo nombra explícito.

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

1. **Queue/semáforo en `server.js`** — ✅ **RESUELTO en v30 (2026-05-20).** Antes no había control de concurrencia: 2 `POST /render` simultáneos (usuario o retry del front Vercel) podían saturar el contenedor (incidente v19). Ahora `server.js` tiene **cola FIFO global + semáforo de 1 render a la vez + timeout de seguridad** (`RENDER_TIMEOUT_MS`, default 25 min). El 2º pedido espera turno (FIFO, ordenado por llegada, sin agrupar por cliente); el cliente igual recibe `202` al instante y el dashboard hace polling. **Escala futura cuando suba el volumen:** (a) subir concurrencia 1→2 **solo tras upgrade de CPU** en Easypanel (renders son CPU-bound 10-16 min; 2 en tier básico thrashean); (b) **mejor:** agregar un 2º worker + mover la cola a un store compartido (Redis / row-lock Supabase), porque esta cola es **in-memory por contenedor** y NO coordina entre réplicas. Dial: env `RENDER_TIMEOUT_MS`.

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
| 6 | `mpk7q9xa5m7j1i227pl` | 2026-05-24 20:11-20:30 UTC (~19 min) | `v46-simple-images-vertical` (incluye v43 intro/outro + v44 crf + v45 audio) | **APROBADO por Javier** ("el render me gustó, por eso aprobé"). Primer render COMPLETO con TODO junto: animaciones IA simples a 9:16 full frame + voz 1.45/música 0.09 + logo intro glitch/outro blanco + SFX + captions. **Consolida v43→v46 como validados — no reabrir.** |
| 7 | `2a6115e7-90eb-4879-bbf2-1a94d63ee3f0` | 2026-05-25 02:46-03:06 UTC (~20 min) | `v46-simple-images-vertical` | **APROBADO por Javier — PRIMER RENDER EDIT MODE aprobado** ("me gustó lo que se hizo el render que acabé de hacer"). Flujo "Editar mi video" (audio/voz del FOOTAGE, sin TTS): 2 clips, 60s objetivo, 9:16, música `electronic`, estilo visual `whiteboard`, subtítulos `classic`. **Content-trim recortó 31.06s (130.59→99.53s, 24% más punchy):** gap×22, prolonged×9, filler×3, clip_bridge×2, repetition×1, phrase×1, gap_end×1. `silence_removed=0` (el word-gap hace TODO el trabajo, esperado/documentado §4). **Valida que v43→v46 (intro/outro logo, animaciones IA 9:16, audio v45, captions, SFX, correcciones de marca) funcionan también en EDIT mode.** Sin errores. |

> **📌 EDIT MODE VALIDADO (2026-05-25):** el flujo "Editar mi video" quedó probado y aprobado (render #7). **Lo que aplica en edit (confirmado):** content-trim (gaps + muletillas + clip-bridge), audio limpio (denoise nr=50 + loudnorm I=-16 sobre la voz del footage), captions ASS, ilustraciones IA simples 9:16, música por género, SFX, logo watermark + intro glitch/outro blanco, correcciones de nombre de marca, CTA WhatsApp. **Lo que TODAVÍA NO está en edit (solo create, pendiente portar):** (a) **transiciones xfade (v37)** — en edit los cortes son DUROS (requiere acrossfade de audio + reajuste de offsets de captions); (b) **Ken Burns zoom/pan (v35)** en las imágenes IA. ⚠️ **Audio en edit:** la voz viene del footage con `loudnorm I=-16` (NO el `volume=1.45` de v45, que es solo create) — si Javier pide subir la voz en edit, el dial es loudnorm I (-16→-14), no el `volume`.

**Estado al 2026-05-24: v46 LIVE** (`v46-simple-images-vertical`). Suma sobre v45: **animaciones IA SIMPLES en 9:16 a pantalla completa** (Opción 1 Javier — inamovible #21 evolucionado). Las ilustraciones dejan de ser infografías densas (se quitó "educational explainer style" del doodle + el LLM pide sujetos simples) y vuelven a 9:16 full frame (al ser simples no se acuestan; reemplaza la card 16:9 de v42). Verificado con 2 imágenes reales (derechas, simples, full frame). Requiere re-render para verse.

**Estado al 2026-05-24: v45 LIVE** (`v45-audio-voice-up-music-down`). Suma sobre v44: **ajuste de balance de audio a pedido de Javier** ("voz más alta, música más baja", tras aprobar el primer render completo) — voz `volume=1.3→1.45`, música comercial `0.12→0.09` (personal 0.17 igual), en create+edit. Ver sección 5 (trayectorias actualizadas). Requiere re-render para oírse (audio bakeado).

**Estado al 2026-05-24: v44 LIVE** (`v44-intro-outro-crf26`). Hotfix sobre v43: el concat del intro/outro (`lib/intro-outro.js`) usaba `-crf 20` → re-encodeaba el video completo a alta calidad e inflaba el archivo > límite global de Supabase Storage (50 MB) → fallo de upload "object exceeded the maximum allowed size". Bajado a **`-crf 26`** (igual que el resto del pipeline) → el archivo vuelve al tamaño previo que ya se subía OK. El bucket `video-jobs` tiene `file_size_limit:null` (aplica el global del proyecto). Si en el futuro hacen falta videos largos pesados, subir el límite global de Storage (afecta infra compartida con el bot — consultar antes).

**Estado al 2026-05-24: v43 LIVE** (`v43-auto-intro-outro-logo`). Suma sobre v42: **intro glitch + outro blanco con logo, automáticos** (inamovible #22) — `lib/intro-outro.js`, réplica de los Reels manuales, concatenados en create+edit cuando hay logo. Verificado visualmente con el logo de Mac Gyver.

**Estado al 2026-05-24: v42** (`v42-ai-image-card-no-rotation`). Suma sobre v41: **fix DEFINITIVO de orientación de imágenes IA** (inamovible #21) — generadas en 16:9 + montadas como card centrada con blur. El prompt-only de v41 no bastó (nano-banana acostaba las infografías igual). Bug crítico reportado por Javier ("sale volteada, se ve horrible"). Verificado con imagen real antes de deployar.

**Estado al 2026-05-24: v41** (`v41-image-orientation-sfx-pro`). Dos cambios: (1) primer intento de fix de orientación (quitar "horizontal" de los prompts de estilo + inyectar orientación según aspect ratio) — insuficiente solo, completado en v42; (2) **regla SFX reescrita** (inamovible #15 actualizado): motivado por evento, sin cuotas de duración, less-is-more, `reason` por efecto en logs.

**Estado al 2026-05-23: v40 LIVE** (`v40-whatsapp-cta`). Suma sobre v39: **CTA de WhatsApp animado** (inamovible #20) — badge verde con el número de la empresa cuando se menciona WhatsApp. Validado visualmente con el número real de Mac Gyver.

**Estado al 2026-05-23: v39** (`v39-caption-fix`). Suma sobre v38: **corrección automática de nombres de marca en subtítulos** (inamovible #19) — `captionReplacements` (por-empresa automáticas + puntuales de MACtin). Mac Gyver sembrado (gaiber→Mac Gyver).

**Estado al 2026-05-23: v38** (`v38-audio-mix-normalize`). Suma sobre v37: **fix de mezcla de audio** — `amix` con `normalize=0` en los 4 sitios (voz+música y SFX, create+edit). Antes `amix` dividía la voz entre el nº de pistas → voz muy baja y música solo audible al final; ahora la voz se queda a nivel pleno y la música suena desde el inicio (reporte de Javier, render `mpipzdhr1e1pl7642lx`). Validado E2E: render con 8 medias salió con fondo real, transiciones, Ken Burns, doodles IA, subtítulos y audio — aprobado "en términos generales súper bien".

**Estado al 2026-05-23: v37** (`v37-xfade-transitions`). Suma sobre v36: **Transiciones automáticas (xfade cross-dissolve 0.35s)** entre segmentos en create mode (inamovible #18), con compensación de duración (video sigue durando = voz) y **fallback a corte duro**. Validado con ffmpeg local. Pendiente: edit mode.

**Estado al 2026-05-23: v36** (`v36-subtitle-styles`). Suma sobre v35: **6 estilos de subtítulos seleccionables** (`lib/subtitle-styles.js` + `buildASS(words, styleKey)`). Default `classic` = look actual exacto (cero regresión verificada). Es elección por-video (`manifest.subtitleStyle`); la UI (menú + preview al hover) se cablea en el SaaS (`mackree-ai`).

**Estado al 2026-05-23: v35** (`v35-ken-burns`). Suma sobre v34: **Ken Burns (zoom/pan) en imágenes** (inamovible #17) — las imágenes de `renderCreate` ya no salen estáticas; llevan zoom-in/pan rotado por índice. Receta `zoompan` + pre-escala 2x validada con ffmpeg local (zoom 1.0→1.12 y pan horizontal visibles, duración exacta).

**Estado al 2026-05-23: v34** (`v34-create-sfx`). Suma sobre v33: **BUGFIX SFX en create mode** — el pass 4 de SFX (AI-driven, inamovible #15) ahora también corre en `renderCreate` (flujo "Crear video con voz"); antes solo estaba en `renderEdit`, por eso Javier no veía SFX en sus pruebas de create. Port verbatim del bloque de edit, usando `voiceDur` como totalDur. Mismo gate (`sfx !== 'off'` + words + ANTHROPIC_API_KEY), fallback graceful.

**Estado al 2026-05-23: v33** (`v33-create-music`). Suma sobre v32: **BUGFIX música en create mode** — `renderCreate` ahora GENERA música con Kie Suno cuando el cliente elige un género (`manifest.music !== 'none'`), igual que `renderEdit`. Antes el flujo "Crear video con voz" solo leía un `music.mp3` que nadie sube → SIEMPRE salía sin música (Javier eligió electrónica y no se aplicó). Además se alineó el volumen de música de create mode al inamovible v29 (`0.12` commercial / `0.17` personal; antes `0.06` hardcodeado). Cableado en la rama "Optional music" de `renderCreate`.

**Estado al 2026-05-23: v32** (`v32-real-timelapse`). Suma sobre v31: **Timelapse REAL del footage en create mode** (inamovible #16) — los clips de instalación se aceleran de verdad para entrar enteros en su slot de narración (`speed = min(60, max(1, origDur/segDur))`), en vez de mostrar solo el inicio. Solo create mode; edit mode intacto. Cableado en la rama de video de `renderCreate`.

**Estado al 2026-05-22: v31** (`v31-sfx-ai-sync`, commit `bf98177`). Suma sobre v30: **Pass 4 SFX AI-driven** — Claude Haiku analiza el transcript Whisper y decide autónomamente qué efectos de sonido (whoosh/ding/boom/pop/sparkle/swoosh/click) colocar en momentos clave, con reglas profesionales de sound design (volumen jerárquico, densidad máx 1 SFX/2s, timing offsets, boom guard, orchestra rule). Nuevo módulo `lib/llm-sfx.js`. Inamovible #15 añadido a la lista.

**Estado al 2026-05-20:** **v30** (`v30-visual-styles-semaphore`, commit `5266115`). Suma sobre v23/v29: (1) **estilos visuales elegibles** para las ilustraciones IA in-video (`manifest.visualStyle`, 6 estilos del catálogo, default `doodle`) aplicados en AMBOS flujos (`renderEdit` + pass-3 PORTADO a `renderCreate`) vía `lib/styles.js` + `llm-moments.js` (el LLM devuelve SOLO el sujeto, sin estilo hardcodeado) + `kie-image.js` (prepend del `prompt_base`); reemplaza el viejo "cinematic photorealistic automotive". (2) **semáforo de 1 render + cola FIFO global + timeout `RENDER_TIMEOUT_MS` (25min)** en `server.js` → **bug #15 RESUELTO**.

**Estado al 2026-05-19 madrugada:** **v23 es el comportamiento LIVE del worker.** Incluye v20 (audio + cortes inamovibles) + v21 (música Suno V5 automática) + v22 (imágenes IA automáticas) + v23 (12 géneros de música con prompts pro).

### Valores inamovibles del audio + cortes (v20, no cambiar)
`afftdn=nr=50 + highpass=f=100`, silence-trim `0.55/-32/0.12`, diccionario muletillas expandido (vocales prolongadas + sin ambiguas como pues/nada/literalmente), `isSustainedSound` con `y`, `isProlongedShortWord` thresholds `0.4/0.5/0.6s` (sin tocar), `detectClipBridgeRepetitions` sin tocar. **NO retroceder.** Cualquier sesión futura que considere modificar estos valores requiere pedido explícito de Javier.

### Nuevos módulos 2026-05-18 noche → 2026-05-19 madrugada

| Módulo | Qué hace | Trigger |
|---|---|---|
| `lib/kie-music.js` | Genera música de fondo con Kie Suno V5 instrumental. 12 géneros con prompts pro: urban, acoustic, cinematic, latin, electronic, corporate, rock, lofi, epic, funk, pop. Polling cada 5s, timeout 5min. Fallback graceful sin música. | `manifest.music !== 'none'` + no hay `music.mp3` subido + `KIE_AI_API_KEY` presente |
| `lib/kie-image.js` | Genera imágenes IA con Kie nano-banana-2 (Gemini 3.1 Flash, 4K, 9:16). `generateImagesForMomentsParallel` para batch. Polling cada 3s, timeout 2min/imagen. | Llamado por pass 3 (ver abajo) |
| `lib/llm-moments.js` | Claude Haiku 4.5 analiza transcript word-level de Whisper y devuelve hasta 5 momentos clave + prompts visuales en inglés para nano-banana. ~$0.01/render. | Pass 3 |
| `lib/llm-sfx.js` | **(v31, 2026-05-22)** Claude Haiku 4.5 analiza transcript word-level y devuelve `[{time, category, type, volume, delay_ms}]` — decide autónomamente qué SFX poner en cada momento. Reglas profesionales de sound design hard-coded (ver sección "Catálogo SFX"). `pickRandomSFXFile(category, catalog)` elige un archivo aleatorio del catálogo. ~$0.003/render. | Pass 4 |
| Pass 3 en `lib/render.js` | Después del pass 2 (captions): detectar momentos LLM → generar N imágenes Kie en paralelo → overlay fullscreen 9:16 alpha=0.85 durante 3s con corte duro. Fallback graceful. | `style === 'commercial'` + `words.length > 0` + `ANTHROPIC_API_KEY` + `KIE_AI_API_KEY` + `manifest.aiImages !== 'off'` |
| **Pass 4 en `lib/render.js`** | **(v31, 2026-05-22)** Después del pass 3 (imágenes IA): `detectSFXMoments` → `pickRandomSFXFile` × N → ffmpeg amix con `adelay` + `-c:v copy` (re-encode solo audio). Fallback graceful — si falla, el video queda con el audio limpio del pass 3. | `manifest?.sfx !== 'off'` + `words.length > 0` + `ANTHROPIC_API_KEY` |

### TODO arquitectural pendiente (multi-empresa)

El trigger del pass 3 está hard-coded a `style === 'commercial'` por compat con el render aprobado v20. Pero el dashboard del SaaS ya NO muestra el toggle commercial/personal (commit `dac4f84` + fix build `210a8c7` 2026-05-19) — fue reemplazado por dropdown "Empresa" que carga `brand_identities` del user. Internamente el SaaS sigue mandando `style:'commercial'` siempre. **Cuando el backend del SaaS implemente multi-empresa real** (tier Creator/Pro = N brands por user, hoy solo 1), el trigger del worker debe cambiar a `Boolean(manifest.selectedCompany)` y el prompt del LLM debe incluir contexto de la empresa elegida (industria, brand colors, productos). Esto es trabajo del SaaS (mackree-ai/), no del worker.

### Costo aproximado por render con todas las features

| Pieza | Cost | Cuándo se ejecuta |
|---|---|---|
| FFmpeg base + Whisper + ASS captions | $0 (incluido en compute Easypanel) | Siempre |
| Kie Suno V5 (música, ~3 min audio) | ~$0.05-0.10 | Si `music !== 'none'` |
| Claude Haiku 4.5 (LLM moments — imágenes) | ~$0.01 | Si `commercial + words` |
| Kie nano-banana-2 ×5 imágenes | ~$0.20 ($0.04 c/u) | Si `commercial + words` |
| **Claude Haiku 4.5 (LLM SFX — v31)** | **~$0.003** | Si `sfx !== 'off' + words` |
| **Total render con TODO activado** | **~$0.26-0.31** | — |

### Catálogo SFX (commit `2b21052`, 2026-05-19) + integración AI-driven (commit `bf98177`, 2026-05-22, v31)

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

**Estado v31 (2026-05-22): ✅ INTEGRADO AL RENDER — pass 4 activo.**

**Módulo:** `lib/llm-sfx.js` — exports `detectSFXMoments(words, anthropicKey, totalDur)` y `pickRandomSFXFile(category, catalog)`.

**Reglas profesionales hard-coded en `llm-sfx.js`** (investigadas de fuentes de sound design):
- **Jerarquía de volumen:** voice 0 dB ref → key SFX `volume=0.25` (-12 dB) → subtle SFX `volume=0.16` (-16 dB)
- **Density rule:** `MIN_GAP=2.0s` mínimo entre SFX (negative space)
- **Timing offsets por categoría:** `whoosh/swoosh = -0.10s` (antes del corte), `boom/ding = 0.00s` (en el frame), `sparkle = +0.05s` (después del momento)
- **Boom guard:** `boom+boom` dentro de 5s → rechazado
- **Orchestra rule:** máx 1 low (boom) + 1 mid (whoosh/swoosh) + 1 high simultáneos
- **Guards:** no SFX en primeros 2s ni últimos 1.5s del video
- **Clasificación por tier:** boom/ding = `key` (0.25vol); whoosh/swoosh/sparkle/pop/click = `subtle` (0.16vol)

**Pass 4 en `render.js`:**
- Trigger: `manifest?.sfx !== 'off'` + `words.length > 0` + `ANTHROPIC_API_KEY`
- Llama `detectSFXMoments` → mapea cada momento a un archivo random vía `pickRandomSFXFile`
- Construye comando ffmpeg con `-c:v copy` (re-encode SOLO audio, sin tocar video)
- `adelay=TIME_MS|TIME_MS` por SFX + `amix` para mezclar todo + `alimiter=0.95` para evitar clipping
- Fallback graceful: si falla pass 4, el video queda intacto con audio limpio de pass 3

---

## Stack rápido

| Capa | Detalle |
|---|---|
| Runtime | Node 22, Express, FFmpeg (Docker) |
| Pipeline | `downloadJobAssets` → `renderJob` (create o edit mode) → `uploadOutput` → `postCallback` |
| Audio chain (edit mode) | `aresample=44100 → highpass=100 → afftdn=nr=50 → dynaudnorm → format` por clip; después concat → `loudnorm I=-16:LRA=11:TP=-1.5` → mix con música → `alimiter=limit=0.95` |
| Video chain (edit mode) | `setpts → scale → crop → fps → setsar → deshake (si motion>1) → unsharp → eq → format` |
| Captions | Whisper word-level → ASS karaoke con `Impact 76px`, color verde limón `&H0000FF80` |
| Build version | leer `BUILD_VERSION` en `server.js` (actual: `v57-captions-front`) |

---

## Deploy

Cambios al código → `git push origin main` → Easypanel auto-rebuild (~3-5 min) → `/health` debe mostrar el `version` nuevo.

Verificar deploy con:
```bash
curl https://worker-mackree-ai.kqlrkv.easypanel.host/health
# Debe responder {"ok":true,"version":"v19-...","ts":"..."}
```

Si `version` no cambió tras 5 min → forzar redeploy manual desde el panel de Easypanel.
