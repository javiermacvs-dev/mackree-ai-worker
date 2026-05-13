# MackreeAI Worker

FFmpeg render worker for [MackreeAI](https://mackree-ai.vercel.app). Runs as
a Docker service on Easypanel — keeps the heavy lifting off Vercel
serverless (no FFmpeg, no shared filesystem, 4.5 MB body limit).

## Architecture

```
[Browser]  upload media       [Supabase Storage]
   │  ─────────────────────►   video-jobs/<userId>/<jobId>/media_*.{ext}
   │                                                +    voice.mp3
   │                                                +    job.json
   ▼
[Vercel API]  POST /render { jobId, userId }
   │           Authorization: Bearer ${WORKER_SECRET}
   ▼
[Easypanel Worker (this repo)]
   1. Pull assets from Supabase Storage into /tmp/<jobId>/
   2. ffprobe duration + ffmpeg concat + Whisper words + ASS captions
   3. Upload output.mp4 back to video-jobs/<userId>/<jobId>/output.mp4
   4. POST callback to Vercel /api/webhooks/render-complete
```

## Run locally

```bash
cp .env.example .env
# Fill in WORKER_SECRET, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (optional)
npm install
npm run dev
```

Health check: `curl http://localhost:8080/health`

Manual render (replace IDs):

```bash
curl -X POST http://localhost:8080/render \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"abc123","userId":"00000000-0000-0000-0000-000000000000"}'
```

## Deploy to Easypanel

1. Create new service → Source = "App" → Build from Git
2. Repo: `https://github.com/javiermacvs-dev/mackree-ai-worker`  (push from local first)
3. Dockerfile auto-detected
4. Env vars (from `.env.example`):
   - `WORKER_SECRET` (`openssl rand -hex 32`, share with Vercel)
   - `SUPABASE_URL` = `https://pbfbgezarmcqxuctdrml.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` (from Supabase dashboard)
   - `CALLBACK_URL` = `https://mackree-ai.vercel.app/api/webhooks/render-complete`
   - `STORAGE_BUCKET` = `video-jobs`
   - `OPENAI_API_KEY` (for Whisper captions; optional)
5. Resource limits: 2 CPU, 2-4 GB RAM, 10 GB ephemeral disk (FFmpeg loves RAM/disk)
6. Healthcheck path = `/health`
7. Expose port 8080 — Easypanel issues TLS + internal hostname

Once deployed, take the internal hostname (e.g.
`http://mackree-ai-worker.kqlrkv.easypanel.host`) and set it on the Vercel
side as `HYPERFRAMES_WORKER_URL`. Wire the Vercel `/api/generate/video`
route to POST to that URL with `{ jobId, userId }` after the client has
uploaded media to Supabase Storage.

## MVP scope vs TODO

✅ Concat media segments (image or video) into a vertical 9:16 reel.
✅ Mix voice.mp3 (with `volume=1.3` + `alimiter`) + optional music.mp3.
✅ ASS karaoke captions (Whisper word timestamps + `Impact` font + LIME accent).
✅ Bearer auth + callback to Vercel.
✅ tmpfs cleanup on success or failure.

⏳ Glitch intro (RGB split lutrgb + scanline geq) — copy from
`mackree-ai/src/app/api/generate/render/route.ts` lines ~373-405.
⏳ Watermark logo overlay (commercial mode).
⏳ White-flash outro with logo growth.
⏳ `blur_bg` photo treatment.
⏳ `timelapse_speed` profile-driven speedup for non-last videos.
⏳ Music generation (currently expects `music.mp3` already in the bucket).
⏳ HMAC-signed callbacks for defense in depth.
⏳ Job retries / dead-letter queue (today: single shot + callback on fail).

## Why not Vercel?

- Vercel serverless: no FFmpeg, no Chrome, 60s timeout (300s on Pro),
  4.5 MB body limit on route handlers, 300 MB function size cap. The
  original `/api/generate/render` was 530 lines that wrote 30+ MB of
  intermediate state to disk — it never had a chance.
- Easypanel: Docker service with persistent disk, generous timeouts,
  TLS termination, healthchecks, env var UI, autoscale.
