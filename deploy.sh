#!/bin/bash

# Настройки подключения
SERVER_USER="root"
SERVER_IP="194.41.113.178"

# Команды для выполнения на сервере
ssh "${SERVER_USER}@${SERVER_IP}" << 'EOF'
    cd projects/yt-msx-proxy/ || { echo "Папка не найдена"; exit 1; }

    echo "Обновляем репозиторий..."
    git pull

    echo "Собираем Docker-образ..."
    docker build -t 2016youtubetv .

    echo "Перезапускаем контейнер..."
    docker rm -f yt2016 2>/dev/null
    docker run -d --name yt2016 \
      -p 8090:8090 \
      -p 8070:8070 \
      --restart unless-stopped \
      2016youtubetv

    echo "Деплой успешно завершен!"
EOF