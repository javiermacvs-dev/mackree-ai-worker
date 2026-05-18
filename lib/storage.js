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

/**
 * Upload a single local file to bucket/<userId>/<jobId>/<remoteName>.
 * Returns the public URL.
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

  const { data } = sb.storage.from(BUCKET).getPublicUrl(remotePath)
  return data.publicUrl
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
