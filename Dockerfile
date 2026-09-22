# 2016YouTubeTV — production container
#
# The server binds its sockets to BIND_ADDR (defaults to the configured
# server IP). When running under Docker we must bind to every interface
# (0.0.0.0) while the *client-facing* URLs keep using the static public IP
# stored in back/settings.json (serverIp). This is handled automatically:
# the Dockerfile sets BIND_ADDR=0.0.0.0 and the client always derives its
# APP_URL from window.location, so there is nothing to hard-code per host.

FROM node:22-bookworm-slim

# yt-dlp: youtube-dl-exec wraps the python3 executable. youtube-dl-exec ships
# a python3 zipapp binary and spawns it via `#!/usr/bin/env python3`. The
# required python3 runtime must exist in the image.
# Note: yt-dlp 2023+ has a self-contained C binary, but this project's pinned
# youtube-dl-exec (v3.x) still needs python3 on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        ca-certificates \
        openssl \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies first so the layer can be cached.
# youtube-dl-exec's postinstall ("downloaded YTDLP binary") must run inside a
# container that can reach GitHub, which the build stage can.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the project after npm install to keep the caching warm.
COPY . .

# Bind to every interface inside the container.
ENV BIND_ADDR=0.0.0.0

# Bind the listen socket's CORS-anywhere server port (8070) as well.
ENV CORS_PROXY_HOST=0.0.0.0

EXPOSE 8090
EXPOSE 8070

# Runs back/server.js
CMD ["node", "back/server.js"]
