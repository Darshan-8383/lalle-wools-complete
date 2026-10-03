# LALLEWOOLS — production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only runtime dependencies (sharp is a dev tool for optimising images; not needed to serve the shop)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The database lives on a volume so it survives redeploys: mount it at /app/server/data
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
VOLUME ["/app/server/data"]

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4000}/api/health || exit 1

CMD ["node", "server/index.js"]
