FROM node:24-alpine

# Native build tools + ffmpeg for voice features
RUN apk add --no-cache python3 make g++ git ffmpeg

# Enable pnpm (lockfile v9 → needs pnpm v9+)
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# ── Copy workspace manifests first (layer cache: reinstall only when these change) ──
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# ── Copy ALL workspace packages (pnpm needs the full workspace graph) ────────
COPY lib/                        ./lib/
COPY scripts/                    ./scripts/
COPY artifacts/api-server/       ./artifacts/api-server/
COPY artifacts/mockup-sandbox/   ./artifacts/mockup-sandbox/

# ── Install all workspace deps ────────────────────────────────────────────────
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# ── Build only the api-server ─────────────────────────────────────────────────
RUN pnpm --filter @workspace/api-server run build

# ── Runtime ───────────────────────────────────────────────────────────────────
WORKDIR /app/artifacts/api-server
ENV NODE_ENV=production

EXPOSE 10000

CMD ["node", "--enable-source-maps", "--max-old-space-size=384", "./dist/index.mjs"]
