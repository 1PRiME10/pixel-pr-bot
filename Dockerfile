FROM node:24-alpine

# Native module build tools + ffmpeg
RUN apk add --no-cache python3 make g++ git ffmpeg

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# ── Copy workspace config (layer cache: only reinstall when these change) ──
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# ── Copy all workspace packages ───────────────────────────────────────────
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY artifacts/api-server/ ./artifacts/api-server/

# ── Install all workspace deps ────────────────────────────────────────────
RUN pnpm install --frozen-lockfile

# ── Build the api-server (runs build.mjs → dist/index.mjs) ───────────────
RUN pnpm --filter @workspace/api-server run build

# ── Runtime ───────────────────────────────────────────────────────────────
WORKDIR /app/artifacts/api-server
ENV NODE_ENV=production

EXPOSE 10000

CMD ["node", "--enable-source-maps", "--max-old-space-size=384", "./dist/index.mjs"]
