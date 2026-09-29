#!/bin/bash
# Деплой 2016YouTubeTV на удалённый сервер.
#
# Образ теперь не один Node-процесс, а nginx впереди (HTTP/3 на :443,
# HTTP на :8080) и Node на :8090 позади. Поэтому:
#   * :8080 публикуется всегда - это фронт без TLS;
#   * :443 (tcp+udp) публикуется, только если есть сертификат И порт свободен;
#   * :8090 остаётся для прямого доступа к Node (диагностика, откат);
#   * :8070 (cors-anywhere) наружу НЕ публикуется - клиент ходит через
#     /proxy на том же origin, а открытый cors-anywhere на публичном IP это
#     свободный прокси для кого угодно. Поставьте PUBLISH_8070=yes, только
#     если он реально нужен старым клиентам.
#   * back/imgcache и back/logs выношены в named volumes, иначе каждый
#     docker rm -f сбрасывал бы 39 МБ превью и логи.

set -euo pipefail

# ============================ НАСТРОЙКИ =============================
# Любую настройку можно переопределить из окружения или аргументом, не
# правя файл:  REQUIRE_FREE_443=yes ./deploy.sh
# Значения по умолчанию - то, что ниже.

SERVER_USER="${SERVER_USER:-root}"
SERVER_IP="${SERVER_IP:-test-service.freeddns.org}"
REMOTE_DIR="${REMOTE_DIR:-projects/yt-msx-proxy}"

CONTAINER="${CONTAINER:-yt2016}"
IMAGE="${IMAGE:-2016youtubetv}"

# Каталог на сервере с полной цепочкой: полный путь к fullchain.pem и privkey.pem.
# Оставьте пустым, чтобы deploy работал без TLS (nginx поднимется на :8080).
# Пример: CERT_SRC="/etc/letsencrypt/live/example.com"
CERT_SRC="${CERT_SRC-/etc/letsencrypt/live/test-service.freeddns.org}"

# auto - публиковать 443 если есть сертификат и порт свободен
# yes  - публиковать принудительно (упадёт, если порт занят)
# no   - не публиковать (TLS терминирует хостовый nginx через 127.0.0.1:8080)
ENABLE_443="${ENABLE_443:-auto}"

# Обязательная проверка свободного 443.
# no  - если 443 занят чужим процессом, тихо уйти на :8080
# yes - если 443 занят чужим процессом, ПРЕРВАТЬ деплой с ненулевым кодом.
#       Порт, занятый нашим же прошлым контейнером, помехой не считается.
REQUIRE_FREE_443="${REQUIRE_FREE_443:-no}"

PUBLISH_8070="${PUBLISH_8070:-no}"

# Опечатка в значении (REQUIRE_FREE_443=jes) молча дала бы тихий откат на
# :8080 - ровно тот сбой, который этот параметр и нужен, чтобы не пропустить.
# Поэтому проверяем значения явно.
case "$ENABLE_443"      in auto|yes|no) ;; *) echo "!! ENABLE_443='$ENABLE_443' - допустимо auto|yes|no"; exit 2;; esac
case "$REQUIRE_FREE_443" in yes|no)      ;; *) echo "!! REQUIRE_FREE_443='$REQUIRE_FREE_443' - допустимо yes|no"; exit 2;; esac
case "$PUBLISH_8070"    in yes|no)      ;; *) echo "!! PUBLISH_8070='$PUBLISH_8070' - допустимо yes|no"; exit 2;; esac
# Значения уезжают в команду ssh внутри одинарных кавычек - одинарная
# кавычка в пути сломала бы её и дала бы невнятную ошибку от удалённого bash.
for v in "$SERVER_IP" "$REMOTE_DIR" "$CONTAINER" "$IMAGE" "$CERT_SRC"; do
    case "$v" in
        *"'"*) echo "!! Значение с одинарной кавычкой недопустимо: $v"; exit 2;;
    esac
done
# ====================================================================

ssh "${SERVER_USER}@${SERVER_IP}" \
    "REMOTE_DIR='$REMOTE_DIR' CONTAINER='$CONTAINER' IMAGE='$IMAGE' \
     CERT_SRC='$CERT_SRC' ENABLE_443='$ENABLE_443' PUBLISH_8070='$PUBLISH_8070' \
     REQUIRE_FREE_443='$REQUIRE_FREE_443' \
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

# --- 5. Кто занимает 443 ---------------------------------------------
# Проверка идёт ДО сноса старого контейнера, чтобы при аварии не остаться
# без работающего деплоя. Различаем двух держателей:
#   * наш прошлый контейнер (docker-proxy от $CONTAINER) - это не помеха,
#     порт освободится сам после docker rm;
#   * любой другой процесс - это то, на чём скрипт обязан споткнуться.
# TCP и UDP - разные пространства имён: QUIC нужен UDP, HTTP/2 нужен TCP.
have_probe=1
command -v ss >/dev/null 2>&1 || { have_probe=0; command -v netstat >/dev/null 2>&1 || have_probe=0; }

probe_cmd() {  # proto port -> печатает сокеты (пусто = свободно)
    local proto=$1 port=$2
    if command -v ss >/dev/null 2>&1; then
        if [ "$proto" = tcp ]; then ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2
        else                            ss -lunp "sport = :$port" 2>/dev/null | tail -n +2; fi
    else
        netstat -lntup 2>/dev/null | awk -v p=":$port" -v pr="${proto^^}" \
            'NR>2 && $1 ~ pr && $4 ~ p"$"'
    fi
}
port_in_use() { [ "$have_probe" -eq 1 ] && [ -n "$(probe_cmd "$1" "$2")" ]; }

# Публиковал ли наш контейнер 443? Если да - текущая занятость порта
# принадлежит нам, а не постороннему сервису.
OURS_HOLDS_443=0
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker inspect -f '{{range $p, $_ := .HostConfig.PortBindings}}{{$p}} {{end}}' "$CONTAINER" 2>/dev/null \
        | tr ' ' '\n' | grep -q '^443/' && OURS_HOLDS_443=1
fi

TCP443=0; UDP443=0
FOREIGN_HOLDER=0
port_in_use tcp 443 && TCP443=1
port_in_use udp 443 && UDP443=1
[ "$have_probe" -eq 0 ] && echo "    ВНИМАНИЕ: нет ss/netstat, не смог проверить занятость 443"

if [ "$TCP443" -eq 1 ] || [ "$UDP443" -eq 1 ]; then
    if [ "$OURS_HOLDS_443" -eq 1 ]; then
        echo "==> 443 держит наш прошлый контейнер ($CONTAINER) - это норма, порт освободится при сносе"
    else
        FOREIGN_HOLDER=1
        echo "==> 443 занят посторонним процессом:"
        [ "$TCP443" -eq 1 ] && { echo "      [tcp/443]"; probe_cmd tcp 443 | sed 's/^/        /'; }
        [ "$UDP443" -eq 1 ] && { echo "      [udp/443]"; probe_cmd udp 443 | sed 's/^/        /'; }
    fi
fi

# Строгий режим: прерываемся, пока старый контейнер ещё жив, чтобы не гасить
# работающий деплой. Тихий откат на :8080 - как раз тот случай, который
# нельзя пропускать незаметно.
if [ "$FOREIGN_HOLDER" -eq 1 ] && [ "$REQUIRE_FREE_443" = "yes" ]; then
    echo
    echo "!! ПРЕРВЫВАЮ ДЕПЛОЙ: REQUIRE_FREE_443=yes, а 443 занят не нашим контейнером."
    echo "   Список процессов выше. Освободите порт и повторите, либо:"
    echo "   - поставьте REQUIRE_FREE_443=no (тогда будет тихий откат на :8080);"
    echo "   - или ENABLE_443=no, если TLS терминирует хостовый nginx."
    exit 1
fi

# --- 6. Сносим старый контейнер, освобождая наши же порты --------------
echo "==> сносим предыдущий контейнер"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Наши же порты после сноса освободились, поэтому перемеряем. Без этого
# решение ниже опиралось бы на замер, сделанный пока контейнер ещё жил,
# и 443 не опубликовался бы повторно - то есть QUIC пропал бы после
# первого же деплоя.
if [ "$OURS_HOLDS_443" -eq 1 ]; then
    TCP443=0; UDP443=0
    port_in_use tcp 443 && TCP443=1
    port_in_use udp 443 && UDP443=1
    if [ "$TCP443" -eq 1 ] || [ "$UDP443" -eq 1 ]; then
        # Наш контейнер снесён, значит держать порт больше некому.
        echo "!! ПОСЛЕ СНОСА 443 всё ещё занят - это уже точно чужой процесс:"
        probe_cmd tcp 443 | sed 's/^/      /'
        probe_cmd udp 443 | sed 's/^/      /'
        FOREIGN_HOLDER=1
        if [ "$REQUIRE_FREE_443" = "yes" ]; then
            echo "!! ПРЕРЫВАЮ ДЕПЛОЙ (REQUIRE_FREE_443=yes). Прежний контейнер уже снесён."
            exit 1
        fi
    fi
fi

# --- 7. Сертификаты --------------------------------------------------
MOUNT_CERT=""
HAVE_CERT=0
if [ -n "$CERT_SRC" ]; then
    if [ -f "$CERT_SRC/fullchain.pem" ] && [ -f "$CERT_SRC/privkey.pem" ]; then
        HAVE_CERT=1
        MOUNT_CERT="-v $CERT_SRC:/etc/nginx/certs:ro"
        echo "==> сертификат: $CERT_SRC"
    else
        echo "    ВНИМАНИЕ: в $CERT_SRC нет fullchain.pem/privkey.pem - TLS не включится"
    fi
else
    echo "==> CERT_SRC пуст - деплой без TLS, фронт на :8080"
fi

# --- 8. Решаем, публиковать ли 443 ----------------------------------
PUBLISH_443=0
if [ "$ENABLE_443" = "yes" ]; then
    PUBLISH_443=1
    [ "$HAVE_CERT" -eq 0 ] && echo "    ВНИМАНИЕ: 443 публикуется принудительно, но сертификата нет - nginx уйдёт в HTTP-режим"
elif [ "$ENABLE_443" = "auto" ]; then
    if [ "$HAVE_CERT" -eq 1 ] && [ "$TCP443" -eq 0 ] && [ "$UDP443" -eq 0 ]; then
        PUBLISH_443=1
    fi
fi

if [ "$PUBLISH_443" -eq 1 ]; then
    echo "==> публикуем 443 (TLS + HTTP/2 + HTTP/3)"
else
    echo "==> 443 не публикуем:"
    [ "$HAVE_CERT" -eq 0 ] && echo "    - нет сертификата (задайте CERT_SRC)"
    [ "$TCP443" -eq 1 ] && echo "    - TCP/443 уже занят"
    [ "$UDP443" -eq 1 ] && echo "    - UDP/443 уже занят (без него не будет QUIC)"
    if [ "$TCP443" -eq 1 ] || [ "$UDP443" -eq 1 ]; then
        echo "    Вариант: пусть хостовый nginx терминирует TLS и проксирует на 127.0.0.1:8080"
    fi
fi

# --- 9. Запуск --------------------------------------------------------
# shellcheck disable=SC2086
ARGS=(
    -d --name "$CONTAINER"
    --restart unless-stopped
    -p 8080:8080
    -p 8090:8090
)
[ "$PUBLISH_443" -eq 1 ] && ARGS+=(-p 443:443 -p 443:443/udp)
[ "$PUBLISH_8070" = "yes" ] && ARGS+=(-p 8070:8070)
[ -n "$MOUNT_CERT" ] && ARGS+=($MOUNT_CERT)
ARGS+=(-v "$IMAGE-imgcache:/app/back/imgcache" -v "$IMAGE-logs:/app/back/logs")

echo "==> docker run ${ARGS[*]} $IMAGE:$TS"
docker run "${ARGS[@]}" "$IMAGE:$TS"

# --- 10. Проверка, что контейнер реально обслуживает трафик -----------
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

# --- 11. Проверяем, что QUIC действительно слушает ---------------------
# Порт 443 в hex это 01BB; смотрим /proc/net/udp, чтобы не зависеть от ss
# внутри образа. Это единственная проверка, которая ловит тихий сценарий
# "сертификат смонтирован, но h3 не поднялся".
if [ "$PUBLISH_443" -eq 1 ]; then
    if docker exec "$CONTAINER" sh -c "grep -qi ':01BB' /proc/net/udp" >/dev/null 2>&1; then
        echo "    QUIC слушает UDP/443 внутри контейнера (h3 включён)"
    else
        echo "    ВНИМАНИЕ: UDP/443 внутри контейнера не слушается - QUIC не работает."
        echo "    Проверьте, что сертификат не битый и образ собран из nginx:1.27 (нужен http_v3_module)."
    fi
fi

# --- 12. Откат -------------------------------------------------------
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

# --- 13. Чистим старые образы ----------------------------------------
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' \
    | grep -vE ":($TS|latest|rollback)$" \
    | xargs -r docker rmi -f >/dev/null 2>&1 || true

echo
echo "==> Деплой завершён"
if [ "$PUBLISH_443" -eq 1 ]; then
    echo "    https://<host>/           TLS + HTTP/2 + HTTP/3"
else
    echo "    http://<host>:8080/      без TLS и без QUIC"
fi
echo "    http://<host>:8090/      напрямую Node (для сравнения)"
REMOTE_SCRIPT
