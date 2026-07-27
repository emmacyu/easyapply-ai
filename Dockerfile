# syntax=docker/dockerfile:1

# ---- Stage 1: build the React/Vite frontend ----
FROM node:20-slim AS frontend

WORKDIR /app/frontend

# Install deps first for better layer caching
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Build the static bundle into /app/frontend/dist
COPY frontend/ ./
RUN npm run build


# ---- Stage 2: Python backend that also serves the built frontend ----
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app/backend

# Install tectonic (XeTeX engine) for compiling the LaTeX résumé / cover letter.
# Static musl binary — no system TeX install needed; packages are fetched on demand.
ARG TECTONIC_VERSION=0.15.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin tectonic \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first for caching
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend source
COPY backend/ ./

# Pre-warm tectonic's package/font cache by compiling the résumé template once,
# so the first real PDF build at runtime is fast and works without network.
RUN mkdir -p /tmp/prewarm \
    && cd config/templates \
    && tectonic -X compile resume.tex --outdir /tmp/prewarm \
    && tectonic -X compile coverletter.tex --outdir /tmp/prewarm \
    && rm -rf /tmp/prewarm

# Copy the built frontend so FastAPI can mount it at "/"
# (app.py resolves FRONTEND_DIST as <repo>/frontend/dist == /app/frontend/dist)
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Ensure the SQLite data dir exists (also used as a mount point)
RUN mkdir -p /app/backend/data

EXPOSE 8000

# Serve the API + frontend. Override the command to enable the daily
# scheduler, e.g. `... python main.py serve --schedule`.
CMD ["python", "main.py", "serve", "--host", "0.0.0.0", "--port", "8000"]
