# 2016YouTubeTV — production container
#
# Runs an nginx front next to the Node backend (see deploy/entrypoint.sh).
# The server binds its sockets to BIND_ADDR (defaults to the configured
# server IP). When running under Docker we must bind to every interface
# (0.0.0.0) while the *client-facing* URLs keep using the static public IP
# stored in back/settings.json (serverIp) — unless nginx is in front, in which
# case the backend derives the public origin from X-Forwarded-Proto/Host and
# settings.publicOrigin, and the client derives everything from
# window.location. Nothing has to be hard-coded per host.
#
# Published ports:
#   8080  plain HTTP  (the only public entry, nginx front for the TV)
#   8090  Node, for direct access / debugging
#   8070  standalone cors-anywhere; the client normally uses /proxy instead
#
# Base image is the official nginx image rather than node:* + apt nginx,
# because the distribution package is nginx 1.22 and predates the `http2 on;`
# directive (1.25.1). The Node runtime is copied in from the official node
# image instead of being installed twice.

FROM node:22-bookworm-slim AS nodejs

FROM nginx:1.27-bookworm

# yt-dlp: youtube-dl-exec wraps the python3 executable and spawns
# `#!/usr/bin/env python3`, so python3 must be on PATH. The pinned
# youtube-dl-exec (v3.x) predates yt-dlp's self-contained C binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        ca-certificates \
        openssl \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

# Node runtime, taken from the official image so the versions match the
# toolchain the app is developed against.
COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=nodejs /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

# Install production dependencies first so the layer can be cached.
# youtube-dl-exec's postinstall ("downloaded YTDLP binary") must run inside a
# container that can reach GitHub, which the build stage can.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the project after npm install to keep the caching warm.
COPY . .

# nginx configuration. Only the plain HTTP front on :8080 is used (no TLS).
COPY deploy/nginx/nginx.conf              /etc/nginx/nginx.conf
COPY deploy/nginx/youtubetv-locations.conf /etc/nginx/youtubetv-locations.conf
COPY deploy/nginx/conf.d/                 /etc/nginx/conf.d/
# The stock config would collide with ours on :8080 and on the default server.
RUN rm -f /etc/nginx/conf.d/default.conf

# BBR plus larger socket buffers matter here: the client link is long-haul and
# lossy, and the default 64 KB receive window cannot fill it. Tuned in
# deploy/sysctl.conf — apply on the host (or via docker run --sysctl).
COPY deploy/sysctl.conf /etc/2016youtubetv-sysctl.conf

# Bind to every interface inside the container.
ENV BIND_ADDR=0.0.0.0

# Bind the listen socket's CORS-anywhere server port (8070) as well.
ENV CORS_PROXY_HOST=0.0.0.0

EXPOSE 8080
EXPOSE 8090
EXPOSE 8070

RUN chmod +x deploy/entrypoint.sh

ENTRYPOINT ["./deploy/entrypoint.sh"]
