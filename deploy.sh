#!/bin/bash
# Деплой 2016YouTubeTV на удалённый сервер.
#
# Всё крутится в одном контейнере: nginx-фронт на :8080 - единственный
# публичный вход для ТВ-клиента, Node-бэкенд на :8090 позади (nginx
# проксирует на него). TLS/HTTP/2/QUIC убраны: клиент только ТВ (MSX-2016),
# он ходит plain HTTP/1.1. Поэтому:
#   * :8080 публикуется всегда - это фронт для ТВ;
#   * :8090 остаётся для прямого доступа к Node (диагностика, откат);
#   * :8070 (cors-anywhere) наружу НЕ публикуется - клиент ходит через
#     /proxy на том же origin, а открытый cors-anywhere на публичном IP это
#     свободный прокси для кого угодно. Поставьте PUBLISH_8070=yes, только
#     если он реально нужен старым клиентам.
#   * back/imgcache и back/logs вынесены в named volumes, иначе каждый
#     docker rm -f сбрасывал бы 39 МБ превью и логи.

set -euo pipefail

# ============================ НАСТРОЙКИ =============================
# Единственная настройка, которую можно переопределить из окружения или
# аргументом, не правя файл:  PUBLISH_8070=yes ./deploy.sh

SERVER_USER="${SERVER_USER:-root}"
SERVER_IP="${SERVER_IP:-test-service.freeddns.org}"
REMOTE_DIR="${REMOTE_DIR:-projects/yt-msx-proxy}"

CONTAINER="${CONTAINER:-yt2016}"
IMAGE="${IMAGE:-2016youtubetv}"

PUBLISH_8070="${PUBLISH_8070:-no}"

case "$PUBLISH_8070" in yes|no) ;; *) echo "!! PUBLISH_8070='$PUBLISH_8070' - допустимо yes|no"; exit 2;; esac
# Значения уезжают в команду ssh внутри одинарных кавычек - одинарная
# кавычка в пути сломала бы её и дала бы невнятную ошибку от удалённого bash.
for v in "$SERVER_IP" "$REMOTE_DIR" "$CONTAINER" "$IMAGE"; do
    case "$v" in
        *"'"*) echo "!! Значение с одинарной кавычкой недопустимо: $v"; exit 2;;
    esac
done
# ====================================================================

ssh "${SERVER_USER}@${SERVER_IP}" \
    "REMOTE_DIR='$REMOTE_DIR' CONTAINER='$CONTAINER' IMAGE='$IMAGE' \
     PUBLISH_8070='$PUBLISH_8070' \
     bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$REMOTE_DIR" || { echo "Каталог $REMOTE_DIR не найден"; exit 1; }

# --- 1. Обновляем код ------------------------------------------------
echo "==> git pull"
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
    echo "    ВНИМАНИЕ: рабочее дерево на сервере изменено, pull может не пройти:"
    git status --short | head
fi
git pull --ff-only

# --- 2. Сеть: BBR и буферы -----------------------------------------
# Опционально и безопасно: на хосте без CAP_SYS_ADMIN это просто пропустится.
if [ -f deploy/sysctl.conf ]; then
    echo "==> sysctl -p deploy/sysctl.conf"
    sysctl -p deploy/sysctl.conf 2>&1 | sed 's/^/    /' || \
        echo "    пропущено (нужны права). Внутри контейнера работает только если передан --sysctl"
fi

# --- 3. Собираем образ ------------------------------------------------
TS=$(date +%Y%m%d-%H%M%S)
echo "==> docker build -t $IMAGE:$TS ."
docker build -t "$IMAGE:$TS" .
docker tag "$IMAGE:$TS" "$IMAGE:latest"

# --- 4. Запоминаем предыдущий образ для отката ------------------------
PREV=""
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    PREV=$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
    [ -n "$PREV" ] && docker tag "$PREV" "$IMAGE:rollback" 2>/dev/null || true
fi

# --- 5. Сносим старый контейнер, освобождая порты ---------------------
echo "==> сносим предыдущий контейнер"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# --- 6. Запуск --------------------------------------------------------
# shellcheck disable=SC2086
ARGS=(
    -d --name "$CONTAINER"
    --restart unless-stopped
    -p 8080:8080
    -p 8090:8090
)
[ "$PUBLISH_8070" = "yes" ] && ARGS+=(-p 8070:8070)
ARGS+=(-v "$IMAGE-imgcache:/app/back/imgcache" -v "$IMAGE-logs:/app/back/logs")

echo "==> docker run ${ARGS[*]} $IMAGE:$TS"
docker run "${ARGS[@]}" "$IMAGE:$TS"

# --- 7. Проверка, что контейнер реально обслуживает трафик -----------
echo "==> проверка готовности"
ok=0
for i in $(seq 1 40); do
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
        echo "    контейнер умер, лог:"
        docker logs --tail 25 "$CONTAINER" 2>&1 | sed 's/^/    /'
        break
    fi
    # Проверяем end-to-end через nginx, а не только то, что процесс жив.
    if docker exec "$CONTAINER" node -e "
        require('http').get('http://127.0.0.1:8080/', r => process.exit(r.statusCode === 200 ? 0 : 1))
            .on('error', () => process.exit(1));" >/dev/null 2>&1; then
        ok=1
        echo "    nginx отвечает 200 на :8080"
        break
    fi
    sleep 1
done

# --- 8. Откат -------------------------------------------------------
if [ "$ok" -ne 1 ]; then
    echo "!! НОВЫЙ КОНТЕЙНЕР НЕ ПРОШЁЛ ПРОВЕРКУ"
    if [ -n "$PREV" ]; then
        echo "==> откат на предыдущий образ $PREV"
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        docker run "${ARGS[@]}" "$PREV" || { echo "!! и откат не удался"; exit 1; }
        echo "==> откатились, версии на http://<host>:8080"
    else
        echo "!! откатываться не на что (это был первый деплой)"
    fi
    exit 1
fi

# --- 9. Чистим старые образы ----------------------------------------
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' \
    | grep -vE ":($TS|latest|rollback)$" \
    | xargs -r docker rmi -f >/dev/null 2>&1 || true

echo
echo "==> Деплой завершён"
echo "    http://<host>:8080/      фронт для ТВ (nginx)"
echo "    http://<host>:8090/      напрямую Node (диагностика)"
REMOTE_SCRIPT