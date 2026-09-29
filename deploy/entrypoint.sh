#!/bin/sh
# Runs nginx in front of the Node backend inside one container.
#
# TLS/HTTP/2/QUIC are gone - the only client is the 2016 TV app, which speaks
# plain HTTP/1.1, so nginx always serves plain HTTP on :8080 and proxies to the
# backend on :8090. No certificate is involved anymore.

set -eu

# Stale HTTPS listener blocks from older images: nginx -t would fail on ssl
# directives without a certificate, so drop them defensively before starting.
rm -f /etc/nginx/conf.d/20-https.conf /etc/nginx/conf.d/20-https.conf.disabled

# If nginx fails to start (bad config, port taken) the container would otherwise
# sit there serving nothing, so validate the config before committing to it.
if ! nginx -t -q 2>/tmp/nginx-test.log; then
    echo "[entrypoint] nginx config test failed:"
    cat /tmp/nginx-test.log
    echo "[entrypoint] falling back to serving directly from node on :8090"
    exec node back/server.js
fi

node back/server.js &
NODE_PID=$!

# Wait for the backend to bind before nginx starts accepting traffic.
if [ "${WAIT_FOR_BACKEND:-1}" = "1" ]; then
    i=0
    while [ "$i" -lt 60 ]; do
        if node -e "
            const net = require('net');
            const s = net.connect(8090, '127.0.0.1');
            s.on('connect', () => { s.destroy(); process.exit(0); });
            s.on('error', () => process.exit(1));
        " 2>/dev/null; then
            echo "[entrypoint] backend is up on 127.0.0.1:8090"
            break
        fi
        i=$((i + 1))
        sleep 0.5
    done
    if [ "$i" -ge 60 ]; then
        echo "[entrypoint] backend did not come up in 30s, starting nginx anyway"
    fi
fi

nginx -g 'daemon off;' &
NGINX_PID=$!

# Forward signals to both children and keep the container alive as long as
# either is running, so a crash in one is visible as a container restart.
term() {
    kill -TERM "$NGINX_PID" "$NODE_PID" 2>/dev/null || true
}
trap term TERM INT

while :; do
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[entrypoint] node exited, shutting down"
        kill -TERM "$NGINX_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
        exit 1
    fi
    if ! kill -0 "$NGINX_PID" 2>/dev/null; then
        echo "[entrypoint] nginx exited, shutting down"
        kill -TERM "$NODE_PID" 2>/dev/null || true
        wait "$NGINX_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 2
done