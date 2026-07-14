// Supabase Storage helpers for the worker.
// We use the service role key to bypass RLS — anything that hits this worker
// is already authenticated by the bearer secret in /render.

import { createClient } from '@supabase/supabase-js'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = process.env.STORAGE_BUCKET || 'video-jobs'

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('storage: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

/**
 * Download every file under bucket/<userId>/<jobId>/ into a local dir.
 * Returns the list of local filepaths in the order they came in.
 */
export async function downloadJobAssets(userId, jobId, workDir) {
  await mkdir(workDir, { recursive: true })

  const prefix = `${userId}/${jobId}`
  const { data: list, error: listErr } = await sb.storage
    .from(BUCKET)
    .list(prefix, { limit: 100 })

  if (listErr) throw new Error(`storage.list failed: ${listErr.message}`)
  if (!list || list.length === 0) {
    throw new Error(`No assets found at ${BUCKET}/${prefix}/`)
  }

  const local = []
  for (const entry of list) {
    if (!entry.name) continue
    const remotePath = `${prefix}/${entry.name}`
    const { data: blob, error } = await sb.storage.from(BUCKET).download(remotePath)
    if (error) throw new Error(`download ${remotePath}: ${error.message}`)
    const buf = Buffer.from(await blob.arrayBuffer())
    const localPath = path.join(workDir, entry.name)
    await writeFile(localPath, buf)
    local.push(localPath)
  }
  return local
}

// TTL de las URLs firmadas que este módulo devuelve al subir a video-jobs
// (bucket PRIVADO — contiene caras/voces de clientes). 7 días alcanza de sobra
// para que el callback llegue al SaaS y para que un tercero (KIE) haga fetch
// de un asset recién subido dentro de la ventana de generación.
const SIGNED_UPLOAD_TTL_SEC = 7 * 24 * 3600

/**
 * Upload a single local file to bucket/<userId>/<jobId>/<remoteName>.
 * Devuelve una URL FIRMADA (el bucket es privado — ver createSignedAssetUrl).
 */
export async function uploadOutput(userId, jobId, localPath, remoteName = 'output.mp4') {
  const buf = await readFile(localPath)
  const remotePath = `${userId}/${jobId}/${remoteName}`

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(remotePath, buf, {
      contentType: remoteName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
      upsert: true,
    })

  if (error) throw new Error(`upload ${remotePath}: ${error.message}`)

  return createSignedAssetUrl(userId, jobId, remoteName, SIGNED_UPLOAD_TTL_SEC)
}

/**
 * Sube un thumbnail JPG (extraído del mp4) al mismo bucket.
 * Reemplaza si existe. Devuelve una URL FIRMADA (bucket privado).
 */
export async function uploadThumbnail(userId, jobId, localPath) {
  const buf = await readFile(localPath)
  const remotePath = `${userId}/${jobId}/thumbnail.jpg`
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(remotePath, buf, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error(`upload thumbnail ${remotePath}: ${error.message}`)
  return createSignedAssetUrl(userId, jobId, 'thumbnail.jpg', SIGNED_UPLOAD_TTL_SEC)
}

/**
 * Descarga UN archivo específico de bucket/<userId>/<jobId>/<remoteName> a destPath.
 * Lanza si no existe. (downloadJobAssets baja TODO; esto baja uno suelto.)
 */
export async function downloadOneAsset(userId, jobId, remoteName, destPath) {
  const remotePath = `${userId}/${jobId}/${remoteName}`
  const { data: blob, error } = await sb.storage.from(BUCKET).download(remotePath)
  if (error) throw new Error(`download ${remotePath}: ${error.message}`)
  const buf = Buffer.from(await blob.arrayBuffer())
  await writeFile(destPath, buf)
  return destPath
}

/**
 * Sube un archivo local a bucket/<userId>/<jobId>/<remoteName> (upsert).
 * Devuelve una URL FIRMADA (igual que uploadOutput/uploadThumbnail) — el bucket
 * video-jobs es PRIVADO (contiene caras/voces de clientes: media del cliente,
 * fotos de avatar, output.mp4). Un tercero como KIE puede hacer fetch() de esta
 * URL dentro de la ventana de generación sin que quede públicamente indexable.
 */
export async function uploadAsset(userId, jobId, localPath, remoteName, contentType = 'application/octet-stream') {
  const buf = await readFile(localPath)
  const remotePath = `${userId}/${jobId}/${remoteName}`
  const { error } = await sb.storage.from(BUCKET).upload(remotePath, buf, { contentType, upsert: true })
  if (error) throw new Error(`upload ${remotePath}: ${error.message}`)
  return createSignedAssetUrl(userId, jobId, remoteName, SIGNED_UPLOAD_TTL_SEC)
}

/**
 * Borra un archivo puntual de bucket/<userId>/<jobId>/<remoteName>.
 * No lanza si falla — usado para borrar biometría cruda (foto de avatar) apenas
 * se usó; nunca debe tumbar el render si el borrado tiene un hiccup.
 */
export async function deleteAsset(userId, jobId, remoteName) {
  const remotePath = `${userId}/${jobId}/${remoteName}`
  const { error } = await sb.storage.from(BUCKET).remove([remotePath])
  if (error) console.warn(`[storage] deleteAsset ${remotePath}:`, error.message)
}

/**
 * URL firmada (temporal) para reproducir un asset del bucket privado en el navegador.
 */
export async function createSignedAssetUrl(userId, jobId, remoteName, expiresSec = 3600) {
  const remotePath = `${userId}/${jobId}/${remoteName}`
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(remotePath, expiresSec)
  if (error) throw new Error(`sign ${remotePath}: ${error.message}`)
  return data.signedUrl
}

/**
 * Read a JSON file ({jobId}/job.json) from the local work dir.
 * Falls back to empty object if absent.
 */
export async function readJobManifest(workDir) {
  try {
    const raw = await readFile(path.join(workDir, 'job.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Download the user's brand logo from a public URL (typically the brand-assets
 * bucket). Saves to workDir/logo.png and returns the local path. Returns null
 * if no URL was provided or the fetch failed — caller renders without logo.
 */
export async function downloadBrandLogo(logoUrl, workDir) {
  if (!logoUrl) return null
  try {
    const res = await fetch(logoUrl)
    if (!res.ok) {
      console.warn(`[storage] logo fetch ${res.status}, skipping logo`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const localPath = path.join(workDir, 'logo.png')
    await writeFile(localPath, buf)
    return localPath
  } catch (e) {
    console.warn(`[storage] logo download error, skipping:`, e?.message ?? e)
    return null
  }
}
