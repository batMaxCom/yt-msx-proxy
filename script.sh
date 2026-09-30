#!/usr/bin/env bash
# Полная проверка маршрута client -> server:
# доступность/TTFB, лестница размеров, повторяемость, MTU-проба, стресс 8 МБ, вердикт.
set -u

HOST=''
PASS=''
PORT=8088
SP="$HOME/.local/bin/sshpass"
BASE=/tmp
SIZES=(4096 8192 12288 16384 32768 65536 131072 262144 524288 1048576)
STRESS_SIZE=8388608
WINDOW=30

hum () {
    local b=$1
    if   [ "$b" -ge 1048576 ]; then echo "$((b / 1048576)) МБ"
    elif [ "$b" -ge 1024 ];   then echo "$((b / 1024)) КБ"
    else echo "$b Б"
    fi
}

line () { printf '%s\n' '------------------------------------------------------------'; }
ok  () { printf ' [OK]  %s\n' "$1"; }
warn() { printf ' [!!]  %s\n' "$1"; }
info() { printf '  --   %s\n' "$1"; }

LADDER=1; REC=1; STRESS_FULL=0; HTTP_TTFB=000; MTU_RES="не проверен"; G=0; FAIL_SIZE=0

echo
echo "=== ДИАГНОСТИКА МАРШРУТА К $HOST (окно ${WINDOW} с) ==="
line

# ---------- 1. Подготовка ----------
echo " [1/7] Подготовка тест-файлов на сервере..."
if [ ! -x "$SP" ]; then warn "sshpass не найден: $SP"; exit 2; fi
SRC="cd $BASE && rm -f sp_*.bin && truncate -s $STRESS_SIZE sp_stress.bin && "
for s in "${SIZES[@]}"; do SRC+="truncate -s $s sp_$s.bin && "; done
SRC+="(setsid python3 -m http.server $PORT >/dev/null 2>&1 < /dev/null & echo \$! > httppid) && sleep 1"
SSHPASS="$PASS" "$SP" -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    root@$HOST "$SRC"
if [ $? -ne 0 ]; then warn "SSH к $HOST не удался."; exit 3; fi
ok "тест-сервер: http://$HOST:$PORT/sp_*.bin"
sleep 1

# ---------- 2. TTFB ----------
echo " [2/7] Проверка доступности и TTFB..."
M=$(curl -s -m 15 -r 0-999 -o /dev/null -w '%{http_code}|%{time_connect}|%{time_starttransfer}' \
      "http://$HOST:$PORT/sp_1048576.bin" 2>/dev/null)
HTTP_TTFB=$(echo "$M" | cut -d'|' -f1)
TTC=$(echo "$M" | cut -d'|' -f2)
TTFB=$(echo "$M" | cut -d'|' -f3)
if [ "$HTTP_TTFB" = "200" ]; then
    ok "HTTP=200 | connect=${TTC}s | ttfb=${TTFB}s"
    # если ttfb большой (>1 c), но мелкие качаются - это только задержка, не критично
else
    warn "сервер не отвечает (HTTP=${HTTP_TTFB:-нет})"
fi
line

# ---------- 3. Лестница размеров ----------
echo " [3/7] Лестница размеров (поиск точки обрыва)..."
printf '%-12s %-12s %-8s %-5s %s\n' 'РАЗМЕР' 'ПОЛУЧЕНО' 'СТАТУС' 'RC' 'ПРИЧИНА'
FAIL_SIZE=0
for s in "${SIZES[@]}"; do
    R=$(curl -s -m 12 -o /dev/null -w '%{http_code}|%{size_download}|%{exitcode}|%{errormsg}' \
        "http://$HOST:$PORT/sp_$s.bin" 2>/dev/null)
    H=$(echo "$R" | cut -d'|' -f1)
    G=$(echo "$R" | cut -d'|' -f2)
    E=$(echo "$R" | cut -d'|' -f3)
    M=$(echo "$R" | cut -d'|' -f4)
    if [ "$H" = "200" ] && [ "$G" -eq "$s" ]; then
        printf '%-12s %-12s %-8s %-5s %s\n' "$(hum $s)" "$(hum "$G")" 'OK' "$E" '-'
    else
        LADDER=0
        [ "$FAIL_SIZE" -eq 0 ] && FAIL_SIZE=$s
        printf '%-12s %-12s %-8s %-5s %s\n' "$(hum $s)" "$(hum "${G:-0}")" 'ПАДЕНИЕ' "$E" "$M"
        break
    fi
done
if [ "$LADDER" -eq 1 ]; then
    ok "все размеры (до 1 МБ) скачиваются целиком"
else
    warn "обрыв на размере >= $(hum $FAIL_SIZE)"
fi
line

# ---------- 4. Повторяемость ----------
echo " [4/7] Повторяемость (3 попытки по 1 МБ)..."
for i in 1 2 3; do
    G=$(curl -s -m 10 -o /dev/null -w '%{size_download}' "http://$HOST:$PORT/sp_1048576.bin" 2>/dev/null)
    if [ "$G" = "1048576" ]; then
        ok "попытка $i: 1.0 МБ целиком"
    else
        REC=0
        warn "попытка $i: получено $(hum "${G:-0}") из 1.0 МБ"
    fi
done
[ "$REC" -eq 1 ] && ok "стабильно: 3/3 полных передачи"
line

# ---------- 5. MTU-проба ----------
echo " [5/7] MTU-проба (ping с DF, payload 1472)..."
if ping -c 1 -W 3 -M do -s 1472 "$HOST" >/dev/null 2>&1; then
    MTU_RES="OK (≥1500) / путь не дробит пакеты"
    ok "$MTU_RES"
else
    # ping может быть закрыт ICMP - пробуем чуть меньше
    if ping -c 1 -W 3 -M do -s 1400 "$HOST" >/dev/null 2>&1; then
        MTU_RES="OK на 1400, падает на 1472 (MTU ~1450) - некритично"
        ok "MTU ~1450 (1472 не прошёл, 1400 прошёл)"
    else
        MTU_RES="ICMP-проверка недоступна (ping закрыт) - пропуск"
        info "$MTU_RES"
    fi
fi
line

# ---------- 6. Стресс 8 МБ ----------
if [ "$LADDER" -eq 1 ]; then STR_TR=$WINDOW; else STR_TR=10; fi
echo " [6/7] Стресс: передача $(hum $STRESS_SIZE) за ${STR_TR} с..."
R=$(curl -s -m $STR_TR -o /dev/null -w '%{http_code}|%{size_download}|%{time_total}|%{speed_download}|%{exitcode}' \
    "http://$HOST:$PORT/sp_stress.bin" 2>/dev/null)
H=$(echo "$R" | cut -d'|' -f1)
G=$(echo "$R" | cut -d'|' -f2)
T=$(echo "$R" | cut -d'|' -f3)
S=$(echo "$R" | cut -d'|' -f4)
E=$(echo "$R" | cut -d'|' -f5)
if [ "$G" = "$STRESS_SIZE" ]; then
    STRESS_FULL=1
    ok "получено $(hum "$G") из $(hum $STRESS_SIZE) за ${T} с (~$(( S / 1024 )) КБ/с)"
else
    warn "получено $(hum "${G:-0}") из $(hum $STRESS_SIZE) за ${T} с (rc=$E)"
fi
line

# ---------- 7. Уборка ----------
echo " [7/7] Уборка..."
SSHPASS="$PASS" "$SP" -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    root@$HOST "cd $BASE && fuser -k $PORT/tcp 2>/dev/null; rm -f sp_*.bin httppid" >/dev/null 2>&1
ok "завершено"
line

# ---------- ИТОГ ----------
echo "=== ИТОГОВЫЙ ВЫВОД ==="
if [ "$HTTP_TTFB" != "200" ]; then
    warn "Сервер $HOST НЕДОСТУПЕН с этого канала. Переносить бессмысленно."
elif [ "$LADDER" -eq 1 ] && [ "$REC" -eq 1 ] && [ "$STRESS_FULL" -eq 1 ]; then
    KBPS=$(( S / 1024 ))
    if   [ "$KBPS" -ge 1500 ]; then ok "ОТЛИЧНО: ~${KBPS} КБ/с, все проверки зелёные. Сервер пригоден."
    elif [ "$KBPS" -ge 500 ];  then ok "ХОРОШО: ~${KBPS} КБ/с, все проверки зелёные. Сервер пригоден."
    else                            warn "СТАБИЛЬНО, но медленно (~${KBPS} КБ/с). Формально пригоден."
    fi
    info "Проверки: TTFB ✓ | лестница до 1 МБ ✓ | повторяемость 3/3 ✓ | MTU: $MTU_RES"
elif [ "$STRESS_FULL" -eq 0 ] && [ "$G" -le 12288 ]; then
    warn "МАРШРУТ РЕЖЕТ ПЕРЕДАЧУ: потолок ~$(hum "$G") на соединение."
    info "Типичный признак «пробки» ~11-12 КБ. Нужен хостинг на ином маршруте (RU) либо VPN."
else
    warn "НЕСТАБИЛЬНО/МЕДЛЕННО: часть проверок провалена (лестница=$LADDER, повторяемость=$REC, стресс=${STRESS_FULL})."
    info "Лучше протестировать другой хостинг."
fi
line