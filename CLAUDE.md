# CLAUDE.md — mackree-ai-worker

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Worker FFmpeg productivo para MackreeAI.** Corre en Docker en Easypanel (`worker-mackree-ai.kqlrkv.easypanel.host`). Recibe `POST /render {jobId, userId}` desde el Vercel del SaaS, baja assets de Supabase Storage, renderiza con FFmpeg + Whisper + ASS captions, sube `output.mp4` y dispara callback. Arquitectura general en `README.md`.

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

### 4. Silence trim — valores actuales (suavizado "10 → 7", 2026-05-18)

**Valores actuales** en `lib/render.js` (sección `wantSilenceTrim` ~línea 598):
```javascript
trimSilences(item.filePath, workDir, label, {
  minSilenceDur: 0.55,   // antes 0.35 ("super agresivo v14")
  noiseDb: -32,           // antes -28
  padding: 0.12,          // antes 0.05
})
```

**Cómo interpretar la escala "10 → 7":** 10 = super-agresivo (0.35/-28/0.05). 7 = balance actual (0.55/-32/0.12). 5 = más suave (0.7/-35/0.15). 0 = sin recorte de silencios. Si Javier pide subir o bajar, mover los 3 dials proporcionalmente.

### 5. Voz y música — reglas del editor de video manual aplican acá también

- **Voz protagonista:** `volume=1.3 + alimiter=limit=0.95` (regla #2 del editor manual, validada).
- **Música según tipo:** commercial=0.06, personal=0.12 (regla #3 — cableada en `render.js` línea ~696: `musicVol = isCommercial ? 0.06 : 0.12`).
- **No cambiar estos valores** salvo pedido explícito.

### 6. Logo top-right — siempre visible si el manifest lo trae

Cableado en `lib/render.js` ~líneas 717-725. `scale=140:-1` + `overlay=W-w-30:30`. Si Javier sube logo en su brand identity, debe aparecer. No quitar.

---

## ⚠️ Errores documentados — NO repetir

1. **No tener queue en `server.js`** (referencia: error #15 del editor de video). Disparar 2 `POST /render` en paralelo (sea por el usuario o por retry del front Vercel) puede sobrecargar el contenedor. **Pendiente arreglar:** agregar semaphore de 1 render concurrente. Hasta que se haga, regla operativa: nunca asumir que hay queue.

2. **Perder ajustes entre sesiones** (incidente 2026-05-18). Javier reportó que ajustes aprobados de denoise se "perdieron" al cambiar de sesión. Causa probable: cambios locales que nunca se commitearon, o que se sobrescribieron por un commit posterior. **Fix de proceso:** este archivo `CLAUDE.md` es la fuente de verdad de decisiones aprobadas — cualquier sesión nueva debe leerlo ANTES de tocar `render.js` o `fillerWords.js`.

3. **Hacer 2 cambios a la vez sin confirmar.** Cuando Javier pide ajustar X, Claude no debe asumir que también quiere ajustar Y aunque parezca relacionado. Ejemplo del 2026-05-18: pidió bajar agresividad de cortes y casi suavicé también `isProlongedShortWord` — eso habría roto el corte de sus "Eeeeeh" personales. Corregido por Javier en el momento.

4. **Confundir "PUENTE" con xfade visual.** En este worker no hay xfade entre clips (la concat usa corte duro). Cuando Javier dice "palabra puente" se refiere a la **técnica de continuidad lingüística** descrita en sección 3 arriba, no a una transición visual. Documentado para futura sesión.

5. **Asumir que el usuario disparó 2 renders cuando ve 2 rows en DB.** (Incidente 2026-05-18.) Si aparecen 2 jobs muy seguidos con mismo `user_id` pueden venir de retry automático del front-end o doble insert del handler — NO acusar al usuario sin evidencia. Investigar siempre la causa real.

---

## Proceso obligatorio antes de tocar `render.js` o `fillerWords.js`

1. **Leer este archivo completo.** Cada sección "INAMOVIBLE" es no negociable.
2. **Leer `git log -p -- lib/render.js | head -200`** para entender la trayectoria reciente de los parámetros.
3. **Si vas a cambiar un valor numérico, justificarlo:** ¿hacia dónde se mueve históricamente este parámetro? ¿Estás respetando la dirección establecida?
4. **Cuando Javier aprueba un cambio:** committearlo de inmediato. NO dejar cambios sin commit entre sesiones.
5. **Cuando un render queda aprobado:** documentar acá el `jobId`, qué parámetros se usaron, qué quedó bien, qué quedó por mejorar.

---

## Renders aprobados de referencia (no borrar)

| Render | jobId | Cuándo | Qué quedó bien | Qué falta |
|---|---|---|---|---|
| 1 | `f1203785-20f8-4cf4-bac4-040cecffb28a` | 2026-05-18 20:47-20:57 UTC | Captions, corte de muletillas personales ("Eeeeeh", "Iiiii"), tiempo total 9:36 min | Ruido del audio aún alto (motivó `nr=35 → nr=50`); cortes silencios un poco agresivos (motivó 10 → 7) |

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
