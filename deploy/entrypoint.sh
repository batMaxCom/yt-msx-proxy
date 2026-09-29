#!/bin/sh
# Runs nginx in front of the Node backend inside one container.
#
# The TLS/HTTP2 server block is only enabled when a certificate is mounted at
# /etc/nginx/certs/fullchain.pem. Without one the container still works, just
# over plain HTTP on :8080. QUIC/HTTP/3 is not used anymore: the only client is
# the 2016 TV app, which speaks plain HTTP/1.1 on :8080.

set -eu

CERT_DIR=/etc/nginx/certs
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"
TLS_CONF=/etc/nginx/conf.d/20-https.conf
TLS_CONF_DISABLED=/etc/nginx/conf.d/20-https.conf.disabled

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    if [ -f "$TLS_CONF_DISABLED" ] && [ ! -f "$TLS_CONF" ]; then
        mv "$TLS_CONF_DISABLED" "$TLS_CONF"
    fi
    echo "[entrypoint] TLS + HTTP/2 enabled on :443 (cert: $CERT_FILE)"
else
    if [ -f "$TLS_CONF" ]; then
        mv "$TLS_CONF" "$TLS_CONF_DISABLED"
    fi
    echo "[entrypoint] no certificate at $CERT_FILE - running plain HTTP on :8080"
    echo "[entrypoint] mount certs to terminate TLS (HTTP/2) on :443"
fi

# If nginx fails to start (bad cert, port taken) the container would otherwise
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
