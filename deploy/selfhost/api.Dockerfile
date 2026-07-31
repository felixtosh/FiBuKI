# fibuki-api — the selfhost host (functions/src/selfhost/server.ts) run via
# vite-node, which reuses the vitest.selfhost.config.ts module aliases (no
# bundler / build step). Node 22 matches functions/package.json engines and is
# the version the host was developed + tested under. Build context = repo root.

FROM node:22-slim

# Tini for correct signal handling (the host installs SIGTERM/SIGINT teardown).
#
# Chromium: htmlToPdf.ts is reached by four live paths (precisionSearchQueue,
# generateUvaPdf, receiveEmail, convertHtmlToPdfCallable). Its default branch
# uses @sparticuz/chromium, whose bundled binary is x86_64-only and needs shared
# libraries node:22-slim does not carry — every PDF call would throw here. We
# install Debian's Chromium and point htmlToPdf at it via FIBUKI_CHROME_PATH
# (below), which also makes this image buildable on arm64.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     tini \
     chromium \
     fonts-liberation \
     fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. functions/ is self-contained.
COPY functions/package.json functions/package-lock.json ./
RUN npm ci

# App source (src/, vitest.selfhost.config.ts, tsconfig). node_modules excluded
# by .dockerignore so the npm ci layer above is what's used.
COPY functions/ ./

ENV NODE_ENV=production
ENV PORT=8788
# Consumed by htmlToPdf.ts — takes precedence over @sparticuz/chromium.
ENV FIBUKI_CHROME_PATH=/usr/bin/chromium
EXPOSE 8788

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "vite-node", "--config", "vitest.selfhost.config.ts", "src/selfhost/server.ts"]
