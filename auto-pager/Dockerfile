FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Runtime ──
# Use Debian Bullseye which has Asterisk in its repos
FROM debian:bullseye-slim

# Install Node.js 20, Asterisk, and sox
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      nodejs \
      asterisk \
      sox \
      libsox-fmt-all && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .

# Copy Asterisk config templates
COPY asterisk/ /etc/asterisk-templates/

# Copy static web UI
COPY public/ public/

# Data volume for audio files + SQLite DB
RUN mkdir -p /data/audio
VOLUME /data

# Asterisk needs these dirs
RUN mkdir -p /var/run/asterisk /var/log/asterisk /var/spool/asterisk

EXPOSE 3001
EXPOSE 5060/udp
EXPOSE 5061/tcp

COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
