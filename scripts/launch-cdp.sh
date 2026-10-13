#!/usr/bin/env bash
# Запуск headless-Chromium с CDP-портом для проверок UI агентом.
# Браузерные проверки агент выполняет через scripts/cdp_client.py (порт 9222).
#
# Использование (на хосте):
#   bash scripts/launch-cdp.sh        # старт/перезапуск контейнера pw-cdp
#   bash scripts/launch-cdp.sh stop   # остановить
set -eu

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
NAME="pw-cdp"

stop() { docker rm -f "$NAME" 2>/dev/null || true; }

[ "${1:-}" = "stop" ] && { stop; echo "stopped"; exit 0; }

stop
docker run -d --name "$NAME" --rm --shm-size=1g \
  -p 127.0.0.1:9222:9222 \
  "$IMAGE" \
  bash -c 'C=$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1); \
    echo "CHROME_BIN=$C"; \
    exec "$C" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
    --remote-allow-origins=* --window-size=1920,1080'

echo
echo "Проверка (должен вернуться JSON с Browser/Protocol-Version):"
sleep 2
curl -s -m 5 http://127.0.0.1:9222/json/version || echo "порт ещё не поднялся; см.: docker logs $NAME"
