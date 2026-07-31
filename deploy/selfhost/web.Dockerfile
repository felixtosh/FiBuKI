# fibuki-web — the Next.js frontend built with FIBUKI_BACKEND=selfhost so the
# next.config alias block swaps firebase/{app,firestore,storage,functions,auth}
# for the lib/selfhost/* client shims. Node 20 (repo engines: node 20.x; Node 22
# breaks Next dev/build on this app). Build context = repo root.
#
# NEXT_PUBLIC_* arrive as build args and are promoted to ENV BEFORE `next build`
# because Next inlines them into the client bundle at build time and next.config
# extends the CSP (connect/img/frame-src) from NEXT_PUBLIC_FIBUKI_API_URL +
# NEXT_PUBLIC_OIDC_ISSUER. Setting them only at runtime would leave dead values.

FROM node:20-slim AS build
WORKDIR /app

# Build can be memory-hungry; the LXC caps at 6 GB.
ENV NODE_OPTIONS=--max-old-space-size=4096
ENV NEXT_TELEMETRY_DISABLED=1
ENV FIBUKI_BACKEND=selfhost

# .npmrc carries legacy-peer-deps=true — needed for the clean install.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_FIBUKI_API_URL
ARG NEXT_PUBLIC_OIDC_ISSUER
ARG NEXT_PUBLIC_OIDC_CLIENT_ID
ARG NEXT_PUBLIC_OIDC_SCOPE
ARG NEXT_PUBLIC_OIDC_ADMIN_GROUP
ARG NEXT_PUBLIC_OIDC_REDIRECT_URI
ARG NEXT_PUBLIC_FIBUKI_POLL_MS
ENV NEXT_PUBLIC_FIBUKI_API_URL=$NEXT_PUBLIC_FIBUKI_API_URL \
    NEXT_PUBLIC_OIDC_ISSUER=$NEXT_PUBLIC_OIDC_ISSUER \
    NEXT_PUBLIC_OIDC_CLIENT_ID=$NEXT_PUBLIC_OIDC_CLIENT_ID \
    NEXT_PUBLIC_OIDC_SCOPE=$NEXT_PUBLIC_OIDC_SCOPE \
    NEXT_PUBLIC_OIDC_ADMIN_GROUP=$NEXT_PUBLIC_OIDC_ADMIN_GROUP \
    NEXT_PUBLIC_OIDC_REDIRECT_URI=$NEXT_PUBLIC_OIDC_REDIRECT_URI \
    NEXT_PUBLIC_FIBUKI_POLL_MS=$NEXT_PUBLIC_FIBUKI_POLL_MS

RUN npm run build

# next start needs .next + node_modules + public + config at runtime. FIBUKI_BACKEND
# stays set so the alias block also applies to the server runtime of the app.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "start"]
