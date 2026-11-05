FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib

RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /data && chown app:app /data

USER app
ENV DATA_DIR=/data \
    PORT=9223
EXPOSE 9223
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
