#!/bin/bash
# Деплой 2016YouTubeTV на удалённый сервер.
#
# Всё крутится в одном контейнере: nginx-фронт на :8080 - единственный
# публичный вход для ТВ-клиента, Node-бэкенд на :8090 позади (nginx
# проксирует на него). TLS/HTTP/2/QUIC убраны: клиент только ТВ (MSX-2016),
# он ходит plain HTTP/1.1. Поэтому:
#   * :8080 публикуется всегда - это фронт для ТВ;
#   * :8090 вешается только на loopback хоста (PUBLISH_8090=public - открыть,
#     но ТВ он не нужен, а наружу торчит сам бэкенд без nginx);
#   * :8070 (cors-anywhere) наружу НЕ публикуется - клиент ходит через
#     /proxy на том же origin, а открытый cors-anywhere на публичном IP это
#     свободный прокси для кого угодно. Поставьте PUBLISH_8070=yes, только
#     если он реально нужен старым клиентам.
#
# Тома. Раньше выносились только imgcache и logs, и back/history с
# back/token жили в writable layer. `docker rm -f` в шаге удаления каждый раз
# сбрасывал 39 МБ превью, логи, профили истории И OAuth-токены - то есть после
# деплоя пришлось бы заново привязывать все аккаунты на ТВ. Сейчас в томах
# все четыре каталога, а перед удалением старого контейнера состояние из его
# слоя переносится в тома (без перезаписи уже накопленного).
#
# Пустой том - валидное начальное состояние: каждый каталог приложение
# создаёт само при первой записи (back/history_store.js, back/token_store.js
# через back/oauth_api_v3_api.js, back/image_proxy.js, back/logger.js).
#
# Локальные запуски через docker-compose.yml используют те же пути внутри
# контейнера, но префикс томов у них другой (compose добавляет к имени проекта
# подчёркивание: 2016youtubetv_history против 2016youtubetv-history), так что
# это независимые хранилища. Не ждите общей истории между деплоем и локальным
# запуском.

set -euo pipefail

# ============================ НАСТРОЙКИ =============================
# Единственная настройка, которую можно переопределить из окружения или
# аргументом, не правя файл:  PUBLISH_8070=yes ./deploy.sh

SERVER_USER="${SERVER_USER:-root}"
#SERVER_IP="${SERVER_IP:-194.41.113.178}"
SERVER_IP="${SERVER_IP:-82.23.162.149}"
REMOTE_DIR="${REMOTE_DIR:-projects/yt-msx-proxy}"

CONTAINER="${CONTAINER:-yt2016}"
IMAGE="${IMAGE:-2016youtubetv}"

PUBLISH_8070="${PUBLISH_8070:-no}"
PUBLISH_8090="${PUBLISH_8090:-loopback}"

case "$PUBLISH_8070" in yes|no) ;; *) echo "!! PUBLISH_8070='$PUBLISH_8070' - допустимо yes|no"; exit 2;; esac
case "$PUBLISH_8090" in loopback|public) ;; *) echo "!! PUBLISH_8090='$PUBLISH_8090' - допустимо loopback|public"; exit 2;; esac
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
     PUBLISH_8070='$PUBLISH_8070' PUBLISH_8090='$PUBLISH_8090' SERVER_IP='$SERVER_IP' \
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
# Именно на хосте: net.core.* и tcp_{r,w}mem не namespaced, Docker отклоняет
# их и в --sysctl, и в compose sysctls, поэтому из контейнера их не задать.
# net.ipv4.tcp_congestion_control, наоборот, пробрасывается, но раз его файла
# достаточно - не дублируем.
if [ -f deploy/sysctl.conf ]; then
    echo "==> sysctl -p deploy/sysctl.conf"
    sysctl -p deploy/sysctl.conf 2>&1 | sed 's/^/    /' || \
        echo "    пропущено (нужны права)"
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

# --- 5. Готовим тома и переносим состояние из старого контейнера ------
# Порядок важен: всё это ДО `docker rm -f`, иначе состояние пропадёт.
echo "==> тома"
for d in history token imgcache logs; do
    docker volume create "$IMAGE-$d" >/dev/null
    echo "    $IMAGE-$d"
done

MIGRATE=".deploy-migrate"
rm -rf "$MIGRATE"
mkdir -p "$MIGRATE/history" "$MIGRATE/token"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "==> переносим состояние из старого контейнера в тома"
    for d in history token; do
        # Точка в конце копирует содержимое каталога, а не сам каталог.
        if docker cp "$CONTAINER:/app/back/$d/." "$MIGRATE/$d" 2>/dev/null; then
            n=$(find "$MIGRATE/$d" -type f 2>/dev/null | wc -l)
            echo "    /app/back/$d -> $n файл(ов)"
        else
            echo "    /app/back/$d не найден, пропускаем"
        fi
    done
    # settings.json в .gitignore, поэтому git pull его на сервер не приносит,
    # а без bind-mount сервер создаст новый с serverIp=localhost.
    if [ ! -f back/settings.json ] && \
       docker cp "$CONTAINER:/app/back/settings.json" back/settings.json 2>/dev/null; then
        echo "    settings.json восстановлен из старого контейнера"
    fi
else
    echo "==> старого контейнера нет, переносить нечего"
fi

# Наполняем тома. cp -n ничего не перезаписывает, поэтому повторный деплой не
# откатывает историю на состояние, которое было в контейнере месяц назад.
for d in history token; do
    if [ -n "$(find "$MIGRATE/$d" -type f 2>/dev/null | head -1)" ]; then
        # --entrypoint sh обязателен: у образа свой ENTRYPOINT, и без него
        # `sh -c ...` уйдёт ему аргументом - запустится сервер, а копирования
        # не будет. Молча, без ошибки.
        docker run --rm --entrypoint sh \
            -v "$IMAGE-$d:/dst" -v "$PWD/$MIGRATE:/src" "$IMAGE:$TS" \
            -c "cp -an /src/$d/. /dst/ 2>/dev/null || true"
        echo "    $IMAGE-$d дополнен из старого контейнера"
    fi
done
rm -rf "$MIGRATE"

# settings.json - файл, а не каталог: docker создал бы на его месте
# директорию, и сервер не смог бы его прочитать. Поэтому готовим заранее.
if [ ! -f back/settings.json ]; then
    printf '{\n    "serverIp": "%s",\n    "expBrowse": true\n}\n' "$SERVER_IP" \
        > back/settings.json
    echo "    back/settings.json создан с serverIp=$SERVER_IP"
fi

# --- 6. Сносим старый контейнер, освобождая порты ---------------------
echo "==> сносим предыдущий контейнер"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# --- 7. Запуск --------------------------------------------------------
# shellcheck disable=SC2086
ARGS=(
    -d --name "$CONTAINER"
    --restart unless-stopped
    -p 8080:8080
)
[ "$PUBLISH_8090" = "public" ] && ARGS+=(-p 8090:8090) || ARGS+=(-p 127.0.0.1:8090:8090)
[ "$PUBLISH_8070" = "yes" ] && ARGS+=(-p 8070:8070)
ARGS+=(-v "$IMAGE-history:/app/back/history")
ARGS+=(-v "$IMAGE-token:/app/back/token")
ARGS+=(-v "$IMAGE-imgcache:/app/back/imgcache")
ARGS+=(-v "$IMAGE-logs:/app/back/logs")
ARGS+=(-v "$PWD/back/settings.json:/app/back/settings.json")

echo "==> docker run ${ARGS[*]} $IMAGE:$TS"
docker run "${ARGS[@]}" "$IMAGE:$TS"

# --- 8. Проверка, что контейнер реально обслуживает трафик -----------
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

# --- 9. Откат -------------------------------------------------------
# ARGS те же, поэтому откат поднимает контейнер с теми же томами и не
# трогает накопленную историю.
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

# --- 10. Отчёт о состоянии -------------------------------------------
echo
echo "==> тома с состоянием"
for d in history token; do
    n=$(docker run --rm --entrypoint sh -v "$IMAGE-$d:/d" "$IMAGE:$TS" \
            -c 'ls -1 /d 2>/dev/null | wc -l' 2>/dev/null || echo '?')
    echo "    $IMAGE-$d: $n профил/файл(ов)"
done

# --- 11. Чистим старые образы ----------------------------------------
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' \
    | grep -vE ":($TS|latest|rollback)$" \
    | xargs -r docker rmi -f >/dev/null 2>&1 || true

echo
echo "==> Деплой завершён"
echo "    http://<host>:8080/      фронт для ТВ (nginx)"
case "$PUBLISH_8090" in
    loopback) echo "    http://127.0.0.1:8090/  Node, только с самого сервера" ;;
    *)        echo "    http://<host>:8090/      напрямую Node (диагностика)" ;;
esac
echo "    история и токены: $IMAGE-history, $IMAGE-token (переживают пересборку)"
REMOTE_SCRIPT