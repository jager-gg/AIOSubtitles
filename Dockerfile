FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts ./
COPY src ./src
COPY test ./test
# The logo routes are tested too. (Logo drafts are left out by .dockerignore.)
COPY assets ./assets
RUN npx vitest run test && npm run build && npm prune --omit=dev

FROM node:22-alpine
# ffmpeg/ffprobe read the anchor windows of the playing file.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production PORT=7000 CACHE_DIR=cache
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
# The bundled model and font ship with their licenses.
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# The cache (and the edited links in it) belongs to the unprivileged node user; a new named volume
# takes this ownership. A bind mount needs `chown 1000:1000` on the host, or compose's `user:`.
RUN mkdir -p cache && chown node:node cache
USER node
VOLUME ["/app/cache"]
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7000) + '/manifest.json').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server.js"]
