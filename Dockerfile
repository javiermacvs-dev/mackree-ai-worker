# Worker para Chixy: corre el motor FFmpeg fuera de Vercel.
# Easypanel-friendly: imagen ligera, healthcheck, env vars via UI.

FROM node:22-slim

# FFmpeg + ffprobe + fonts para el ASS subtitle filter
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    fonts-dejavu-core \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better Docker layer caching.
# CN-014: `npm ci` instala EXACTAMENTE lo del package-lock.json (reproducible), no `npm install`.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Render workspace lives on a tmpfs volume by default; Easypanel can mount a
# persistent volume here if jobs are big enough to overflow RAM.
RUN mkdir -p /tmp/render-jobs

# CN-004: correr como usuario NO-root (defensa en profundidad: si el pipeline sufriera
# una RCE, el atacante no obtiene root dentro del contenedor).
RUN groupadd -r app && useradd -r -g app app \
    && chown -R app:app /app /tmp/render-jobs
USER app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
