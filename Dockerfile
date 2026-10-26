# ---- Build stage: compile native deps (better-sqlite3) ----
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund \
 # Only the browser builds of PDF.js are served; drop the rest, plus
 # better-sqlite3's C sources now that it's compiled.
 && cd node_modules \
 && rm -rf pdfjs-dist/legacy pdfjs-dist/web pdfjs-dist/types pdfjs-dist/image_decoders \
           better-sqlite3/deps better-sqlite3/src better-sqlite3/build/Release/obj* \
 && find . -name '*.map' -delete

# ---- Runtime stage: no build tools, small final image ----
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data/files && chown -R node:node /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

USER node
CMD ["node", "server/server.js"]
