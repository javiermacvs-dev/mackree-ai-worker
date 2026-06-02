// music-fragments.js (WS10) — dada una canción propia subida por el cliente y la
// duración del video, corta 4 fragmentos de distintas partes (de T segundos cada uno)
// para que el cliente ESCUCHE y elija cuál suena en su video. El render luego usa el
// offset elegido (manifest.musicOffsetSec). Procesa SOLO el archivo del propio usuario.
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execAsync = promisify(exec)

async function probeDuration(file) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${file}"`,
    { timeout: 30_000 },
  )
  const d = parseFloat(String(stdout).trim())
  return Number.isFinite(d) ? d : 0
}

/**
 * Corta hasta 4 fragmentos de `durationSec` de distintas partes de la canción.
 * Si la canción es más corta que el video → 1 solo fragmento (la canción entera).
 * @returns {Promise<Array<{index:number, offsetSec:number, label:string, localPath:string}>>}
 */
export async function cutFragments({ musicPath, durationSec, workDir }) {
  const dur = Math.max(1, Number(durationSec) || 30)
  const total = await probeDuration(musicPath)

  // Offsets de inicio de cada fragmento (en segundos) + etiqueta legible.
  let plan
  if (total <= dur + 0.5) {
    plan = [{ offsetSec: 0, label: 'Toda la canción' }]
  } else {
    const maxOffset = total - dur
    plan = [
      { offsetSec: 0,                       label: 'Inicio' },
      { offsetSec: +(maxOffset * 0.33).toFixed(2), label: 'Parte media' },
      { offsetSec: +(maxOffset * 0.66).toFixed(2), label: 'Más adelante' },
      { offsetSec: +maxOffset.toFixed(2),   label: 'Tramo final' },
    ]
  }

  const out = []
  for (let i = 0; i < plan.length; i++) {
    const { offsetSec, label } = plan[i]
    const localPath = path.join(workDir, `music_frag_${i}.m4a`)
    const fadeOut = Math.max(0.1, dur - 0.4).toFixed(2)
    const cmd = [
      'ffmpeg -y',
      `-ss ${offsetSec.toFixed(2)} -t ${dur.toFixed(2)}`,
      `-i "${musicPath}"`,
      `-af "afade=t=in:st=0:d=0.25,afade=t=out:st=${fadeOut}:d=0.4,loudnorm=I=-16:LRA=11:TP=-1.5"`,
      '-c:a aac -b:a 128k',
      `"${localPath}"`,
    ].join(' ')
    await execAsync(cmd, { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 })
    out.push({ index: i, offsetSec, label, localPath })
  }
  return out
}
