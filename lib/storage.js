// Storage helpers for the worker — DUAL backend (2026-08-14):
//   · Cloudflare R2 (S3-compatible) si las vars R2_* están presentes → jobs nuevos.
//   · Supabase Storage → fallback y jobs de antes de la migración.
// Por qué: Supabase Free limita 50 MB/archivo → los .mov de iPhone obligaban a
// comprimir en el navegador. R2 no tiene ese límite (decisión Javier 2026-08-13).
// El bucket sigue siendo PRIVADO (inamovible #33): nunca URLs públicas, siempre
// firmadas (Supabase createSignedUrl / R2 presigned GET).
// Los buckets ajenos (brand-assets, generations) SIGUEN en Supabase — no se tocan.
// We use the service role key to bypass RLS — anything that hits this worker
// is already authenticated by the bearer secret in /render.

import { createClient } from '@supabase/supabase-js'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
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

// ── R2 (opcional) ───────────────────────────────────────────────────────────
// La config llega por DOS vías: vars de entorno R2_* (Easypanel) o, si faltan,
// via setR2Config() con el body de cada request del SaaS (/render, /cover,
// /captions-fix, /music-fragments) — canal HTTPS + Bearer WORKER_SECRET,
// transitoria (solo memoria, nunca se persiste). v82, 2026-08-14: permite
// operar sin cargar las vars en el panel de Easypanel.
let R2_CFG = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
}
let _r2 = null

function r2Bucket() {
  return R2_CFG.bucket || 'chixy-video-jobs'
}

export function r2Enabled() {
  return Boolean(R2_CFG.accountId && R2_CFG.accessKeyId && R2_CFG.secretAccessKey && R2_CFG.bucket)
}

/** Config R2 recibida del SaaS en el body. Devuelve true si R2 queda activo. */
export function setR2Config(cfg) {
  if (!cfg || !cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) return r2Enabled()
  const same = R2_CFG.accountId === cfg.accountId && R2_CFG.accessKeyId === cfg.accessKeyId
    && R2_CFG.secretAccessKey === cfg.secretAccessKey && R2_CFG.bucket === cfg.bucket
  if (!same) {
    R2_CFG = { accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket }
    _r2 = null
    console.log('[storage] R2 configurado via request del SaaS')
  }
  return true
}

function r2() {
  if (!_r2) {
    _r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_CFG.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_CFG.accessKeyId,
        secretAccessKey: R2_CFG.secretAccessKey,
      },
      forcePathStyle: true,
    })
  }
  return _r2
}

async function r2Head(key) {
  try {
    await r2().send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }))
    return true
  } catch {
    return false
  }
}

async function r2List(prefix) {
  const keys = []
  let token
  do {
    const res = await r2().send(new ListObjectsV2Command({ Bucket: r2Bucket(), Prefix: prefix, ContinuationToken: token }))
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function r2Download(key, destPath) {
  const res = await r2().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: key }))
  const buf = Buffer.from(await res.Body.transformToByteArray())
  await writeFile(destPath, buf)
  return destPath
}

async function r2Upload(key, buf, contentType) {
  await r2().send(new PutObjectCommand({ Bucket: r2Bucket(), Key: key, Body: buf, ContentType: contentType }))
}

async function r2SignGet(key, expiresSec) {
  // Tope SigV4: 7 días (604800s) — igual al TTL que ya usábamos en Supabase.
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: r2Bucket(), Key: key }), { expiresIn: Math.min(expiresSec, 604800) })
}

/**
 * Download every file under bucket/<userId>/<jobId>/ into a local dir.
 * Returns the list of local filepaths in the order they came in.
 */
export async function downloadJobAssets(userId, jobId, workDir) {
  await mkdir(workDir, { recursive: true })

  const prefix = `${userId}/${jobId}`

  // Unión de ambos backends: un job nuevo vive en R2, uno viejo en Supabase, y un
  // re-render en transición puede tener piezas en ambos. R2 gana en conflicto.
  const fromR2 = new Set()
  if (r2Enabled()) {
    try {
      for (const key of await r2List(`${prefix}/`)) {
        const name = key.slice(prefix.length + 1)
        if (name && !name.includes('/')) fromR2.add(name)
      }
    } catch (e) {
      console.warn(`[storage] r2List ${prefix}/ falló (sigo con Supabase):`, e?.message ?? e)
    }
  }

  const { data: list, error: listErr } = await sb.storage
    .from(BUCKET)
    .list(prefix, { limit: 100 })
  if (listErr && fromR2.size === 0) throw new Error(`storage.list failed: ${listErr.message}`)

  const fromSupabase = (list ?? []).map(e => e.name).filter(n => n && !fromR2.has(n))
  if (fromR2.size === 0 && fromSupabase.length === 0) {
    throw new Error(`No assets found at ${BUCKET}/${prefix}/ (ni en R2)`)
  }

  const local = []
  for (const name of fromR2) {
    const localPath = path.join(workDir, name)
    await r2Download(`${prefix}/${name}`, localPath)
    local.push(localPath)
  }
  for (const name of fromSupabase) {
    const remotePath = `${prefix}/${name}`
    const { data: blob, error } = await sb.storage.from(BUCKET).download(remotePath)
    if (error) throw new Error(`download ${remotePath}: ${error.message}`)
    const buf = Buffer.from(await blob.arrayBuffer())
    const localPath = path.join(workDir, name)
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
  const contentType = remoteName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'

  if (r2Enabled()) {
    await r2Upload(remotePath, buf, contentType)
    return r2SignGet(remotePath, SIGNED_UPLOAD_TTL_SEC)
  }

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(remotePath, buf, { contentType, upsert: true })

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
  if (r2Enabled()) {
    await r2Upload(remotePath, buf, 'image/jpeg')
    return r2SignGet(remotePath, SIGNED_UPLOAD_TTL_SEC)
  }
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
  // R2 primero (jobs nuevos), Supabase después (jobs de antes de la migración).
  if (r2Enabled() && await r2Head(remotePath)) {
    return r2Download(remotePath, destPath)
  }
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
  if (r2Enabled()) {
    await r2Upload(remotePath, buf, contentType)
    return r2SignGet(remotePath, SIGNED_UPLOAD_TTL_SEC)
  }
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
  // Best-effort en AMBOS backends (la biometría cruda no debe quedar en ninguno).
  if (r2Enabled()) {
    try {
      await r2().send(new DeleteObjectCommand({ Bucket: r2Bucket(), Key: remotePath }))
    } catch (e) {
      console.warn(`[storage] deleteAsset R2 ${remotePath}:`, e?.message ?? e)
    }
  }
  const { error } = await sb.storage.from(BUCKET).remove([remotePath])
  if (error) console.warn(`[storage] deleteAsset ${remotePath}:`, error.message)
}

/**
 * URL firmada (temporal) para reproducir un asset del bucket privado en el navegador.
 * Dual: si el objeto vive en R2 → presigned GET de R2; si no → Supabase.
 */
export async function createSignedAssetUrl(userId, jobId, remoteName, expiresSec = 3600) {
  const remotePath = `${userId}/${jobId}/${remoteName}`
  if (r2Enabled() && await r2Head(remotePath)) {
    return r2SignGet(remotePath, expiresSec)
  }
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
// CN-003 (SSRF): el logo_url lo controla el usuario y el worker lo baja server-side.
// Bloqueamos protocolos no-http(s) y destinos internos (loopback, IPs privadas,
// link-local / metadata cloud 169.254.169.254) para que no se pueda usar como SSRF.
function isSafePublicUrl(u) {
  let parsed
  try { parsed = new URL(u) } catch { return false }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const h = parsed.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return false
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1], b = +m[2]
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false                 // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
  }
  return true
}

export async function downloadBrandLogo(logoUrl, workDir) {
  if (!logoUrl) return null
  if (!isSafePublicUrl(logoUrl)) {
    console.warn('[storage] logo URL bloqueada por política SSRF, se omite el logo')
    return null
  }
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
