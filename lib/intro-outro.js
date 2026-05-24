// intro-outro.js — Branding automático: intro glitch + outro blanco con el logo.
//
// Réplica del estilo de los Reels hechos a mano (Carmen, Savoryx v5):
//   - INTRO (1.8s): fondo gris + scanlines + ruido + logo grande centrado con
//     aberración cromática RGB (±18px) = efecto glitch.
//   - OUTRO (1.5s): fondo blanco + logo con fade in/out + destello blanco al final.
//
// Se concatena: intro + contenido + outro. Si no hay logo → devuelve el video sin
// cambios. Graceful: si algo falla, devuelve el video original (no rompe el render).
//
// Línea gráfica de marca (Javier 2026-05-24): los videos comerciales con logo
// SIEMPRE llevan logo al inicio y al final. Antes solo existía en los videos
// manuales; nunca se había portado al worker.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'

const execAsync = promisify(exec)
const q = (p) => `"${p}"`

const INTRO_DUR = 1.8
const OUTRO_DUR = 1.5

/**
 * addIntroOutro(videoPath, logoPath, workDir, { W, H })
 *  → string (path del video final, con o sin branding)
 *
 * Genera intro+outro con el logo y los concatena al video. El logo PNG se
 * loopea (sin loop, ffmpeg lo trata como 1 frame en t=0 y no aparece).
 */
export async function addIntroOutro(videoPath, logoPath, workDir, opts = {}) {
  const W = opts.W || 1080
  const H = opts.H || 1920
  if (!logoPath) {
    console.log('[intro-outro] sin logo → se omite (video sin branding)')
    return videoPath
  }

  try {
    const introPath = path.join(workDir, 'brand_intro.mp4')
    const outroPath = path.join(workDir, 'brand_outro.mp4')
    const finalPath = path.join(workDir, 'output_branded.mp4')

    const LOGO_INTRO_W = Math.round(W * 0.82)
    const LOGO_OUTRO_W = Math.round(W * 0.62)

    const vEnc =
      '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p -r 30 -crf 20 -preset fast'
    const aEnc = '-c:a aac -ar 44100 -ac 2'

    // ── INTRO: glitch (gris + scanlines + ruido + logo + aberración RGB) ──
    const introFc = [
      `color=c=0xCCCCCC:s=${W}x${H}:d=${INTRO_DUR}:r=30,` +
        `geq=lum='if(mod(Y\\,4)\\,lum(X\\,Y)\\,lum(X\\,Y)*0.75)':cb=128:cr=128,` +
        `noise=alls=18:allf=t,format=rgba[gray]`,
      `[1:v]loop=loop=-1:size=1:start=0,fps=30,setpts=PTS-STARTPTS,` +
        `scale=${LOGO_INTRO_W}:-1,format=rgba[logo_big]`,
      `[gray][logo_big]overlay=(W-w)/2:(H-h)/2[gwl]`,
      `[gwl]split=3[gl1][gl2][gl3]`,
      `[gl1]lutrgb=r='val':g=0:b=0,geq=r='r(X+18\\,Y)':g='0':b='0'[cr]`,
      `[gl2]lutrgb=r=0:g='val':b=0[cg]`,
      `[gl3]lutrgb=r=0:g=0:b='val',geq=r='0':g='0':b='b(X-18\\,Y)'[cb]`,
      `[cr][cg]blend=all_mode=addition[crg]`,
      `[crg][cb]blend=all_mode=addition,format=yuv420p[vout]`,
    ].join(';')
    const introCmd = [
      'ffmpeg -y',
      '-f lavfi -i anullsrc=r=44100:cl=stereo',
      `-i ${q(logoPath)}`,
      `-filter_complex "${introFc}"`,
      `-map "[vout]" -map 0:a -t ${INTRO_DUR}`,
      vEnc, aEnc, '-video_track_timescale 30000',
      q(introPath),
    ].join(' ')
    await execAsync(introCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120_000 })

    // ── OUTRO: fondo blanco + logo fade in/out + destello blanco final ──
    const outroFc = [
      `color=c=white:s=${W}x${H}:d=${OUTRO_DUR}:r=30,format=yuv420p[white]`,
      `[1:v]loop=loop=-1:size=1:start=0,fps=30,setpts=PTS-STARTPTS,` +
        `scale=${LOGO_OUTRO_W}:-1,format=rgba,` +
        `fade=t=in:st=0.1:d=0.5:alpha=1,` +
        `fade=t=out:st=${(OUTRO_DUR - 0.5).toFixed(2)}:d=0.4:alpha=1[logo_o]`,
      `[white][logo_o]overlay=(W-w)/2:(H-h)/2,` +
        `fade=t=out:st=${(OUTRO_DUR - 0.35).toFixed(2)}:d=0.35:color=white,` +
        `format=yuv420p[vout]`,
    ].join(';')
    const outroCmd = [
      'ffmpeg -y',
      '-f lavfi -i anullsrc=r=44100:cl=stereo',
      `-i ${q(logoPath)}`,
      `-filter_complex "${outroFc}"`,
      `-map "[vout]" -map 0:a -t ${OUTRO_DUR}`,
      vEnc, aEnc, '-video_track_timescale 30000',
      q(outroPath),
    ].join(' ')
    await execAsync(outroCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120_000 })

    // ── CONCAT: intro + contenido + outro (filter concat = robusto ante params) ──
    const concatCmd = [
      'ffmpeg -y',
      `-i ${q(introPath)} -i ${q(videoPath)} -i ${q(outroPath)}`,
      `-filter_complex "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]"`,
      '-map "[v]" -map "[a]"',
      '-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p -crf 20 -preset fast',
      aEnc, '-movflags +faststart',
      q(finalPath),
    ].join(' ')
    await execAsync(concatCmd, { maxBuffer: 300 * 1024 * 1024, timeout: 300_000 })

    await copyFile(finalPath, videoPath)
    console.log('[intro-outro] intro glitch + outro blanco aplicados')
    return videoPath
  } catch (e) {
    console.warn(`[intro-outro] FALLÓ, video sin branding: ${e?.message ?? e}`)
    return videoPath
  }
}
