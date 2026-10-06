# 2016YouTubeTV — вход в аккаунт Google, история, главная из подписок

## Задача

Заменить историю по `profile_id` из `localStorage` на историю, привязанную к
аккаунту Google, и построить главную страницу из подписок этого аккаунта.

Данные YouTube Data API v3 для этого недостаточно: истории просмотров там нет
(`activities.list` не отдаёт home activity, `playlists.list` не показывает
Watch Later). Поэтому личность и список подписок берутся из Data API, видео —
из InnerTube, а журнал просмотра живёт на сервере.

## Решения

| Вопрос                 | Решение                                                                |
|------------------------|------------------------------------------------------------------------|
| Ключ истории           | Google `sub` из `userinfo`, а не то, что прислал клиент                |
| Где хранится           | `back/history/<sub>.json`, в томе `history`                            |
| Анонимный доступ       | ни чтения, ни записи; пустой ответ, не ошибка                          |
| Сессия                 | HMAC-подписанная cookie `yt_sess`, `HttpOnly`, `SameSite=Lax`, 30 дней |
| Идентификатор в cookie | только `sub` — ни токена, ни email, ни имени                           |
| Список каналов         | `subscriptions.list?mine=true` (Data API, 1 unit / 50 каналов)         |
| Видео канала           | InnerTube `browse` по вкладке Videos — квоту не тратит                 |
| Старые `profile_id`    | перестали быть ключом; файлы остаются на диске                         |

Почему нельзя проще: `playlistItems.list` требует playlist ID, `search.list` не
сортирован по дате загрузки и стоит 100 единиц на вызов. InnerTube спрашивает
ровно то, что спрашивало приложение 2016 года, и бесплатно по квоте.

---

## Сделано

### Секреты и утечки

- [x] `back/oauth_api_v3_api.js`: из логов убраны `client_secret`, `device_code`,
      `access_token`, `refresh_token`; добавлен SHA-256 fingerprint
- [x] Полные дампы browse-ответов только при `YT_DUMP_BROWSE=1`
- [x] `.dockerignore`: `/back/viewer_auth.env` и `/back/accounts/`
- [x] `.gitignore`: `/back/accounts/`
- [x] `docker-compose.yml`: `env_file: ./back/viewer_auth.env`, том `accounts`
- [x] Проверено: реального секрета нет ни в образе, ни в FS контейнера;
      ключи приходят только через environment

### Вход через OAuth (Plan B)

- [x] `back/viewer_accounts.js` (690 строк): конфиг, device flow, `sub`,
      refresh, HMAC-сессии, отзыв сессий, sign-out с revoke у Google
- [x] Scope: `openid` + `youtube.readonly`. Значение из окружения **добавляется**
      к обязательным, а не заменяет их, — устаревший env-файл не срежет `openid`
- [x] `device_code` хранится только в памяти сервера; браузер получает
      `user_code` + `login_id` (opaque) + URL + интервал
- [x] Файлы аккаунтов `back/accounts/<sub>.json`, права 600
- [x] Файлы роутов: `POST /api/auth/login`, `/api/auth/poll`, `/api/auth/whoami`,
      `/api/auth/logout`, `/api/auth/signout_local`

### Исправленные ошибки device flow

Все три были в коде этого репозитория, не в Google:

- [x] `code=` → `device_code=`. Имя из authorization-code flow; Google отвечал
      `Missing required parameter: device_code`. Проверено curl'ом в обе стороны
- [x] `oauthinfo.googleapis.com` и `userinfo.googleapis.com` → 404;
      верный хост `openidconnect.googleapis.com`. Отличие полезно: 401 = нет
      токена (адрес жив), 404 = опечатка в URL
- [x] Окно кода обрезалось до 15 минут, Google даёт 30 (`expires_in`)

### Журнал по аккаунту

- [x] `ENABLED = true` в `back/history_store.js`
- [x] `historyAccount(req)` в `back/server.js` — единственный источник ключа
- [x] Роуты `/api/history/play`, `/api/history`, `/api/history/affinity`,
      `/api/history/stats` переведены на `sub`
- [x] `profile_id` из клиента больше не влияет ни на что
- [x] Аноним → пустой ответ 200, не 401: heartbeat клиента не должен падать
- [x] **Отзыв сессий при выходе.** `signout_local` стирал токен, но подпись
      cookie оставалась валидной 30 дней — выход не закрывал журнал

### Главная из подписок

- [x] `back/subscriptions_feed.js` (345 строк)
- [x] `GET /api/auth/subscriptions`: 401 анонимно, 401 без токена
- [x] Токен берётся из модуля аккаунтов, не из запроса — клиент не может
      указать чужие подписки
- [x] Обход дерева в глубину вместо жёсткого пути + защита от циклов:
      YouTube переименовывает обёртки, точный путь молча отдаёт пустоту
- [x] Пул из 4 параллельных запросов: 300 подписок не должны валить процесс
- [x] Битые строки подписок отбрасываются, мёртвый канал пропускается,
      ошибка на второй странице не отменяет первую
- [x] `SHORTS` не считается длительностью

### Клиент

- [x] Панель входа `#yt-auth-panel` в углу, `display:none` до первого действия
- [x] `signIn()` / `signOut()` / `getAuth()` / `refreshAuth()`
- [x] Опрашивает `/api/auth/poll` с интервалом от Google, до 30 минут
- [x] Ничего не блокирует: без входа ТВ работает как раньше
- [x] Версия плеера `20261002j` → `20261002k`, cache-bust в `index.html`

### Профиль в гайде

- [x] `#user-info-background` в левой панели: аватар и имя аккаунта под ним
- [x] `Ui.gN` читает `topbar.guideSectionRenderer.items[].guideAccountEntryRenderer` —
      в ответе 2016 года нет `accountListHeader`, заголовок там `simpleText`,
      а не `runs`; старые `console.log` перед `if` роняли весь рендер
- [x] Биндинги `userAvatar` / `userName` / `unlimitedStatus` больше не читают
      несуществующее `model.stuff`: раньше панель оставалась пустой
- [x] `.logged-in` ставится, если `authService.ic()` **или** `whoami` видит
      сессию; без него `#user-info-background` остаётся `display:none`
- [x] Тайл **Avatar source** в настройках: `channel` — аватар YouTube-канала из
      гайда, `google` — картинка аккаунта Google; выбор в `yt_avatar_source`
- [x] `YTCustomPlayer`: `isSignedIn` / `sidebarAvatar` / `sidebarName` /
      `avatarSource` / `setAvatarSource` / `noteGuideAccount` / `refreshSidebar`
- [x] Кэш-баст `index.html`: плеер `20261006b`, бандл `20261006d`

### Деплой

- [x] `deploy.sh`: том `accounts`, миграция состояния, `--env-file` с `chmod 600`
- [x] Отсутствие `viewer_auth.env` не валит деплой — вход просто отключён
- [x] `back/viewer_auth.env.example` с корректным scope

---

## Не сделано

### Требует вас

- [ ] **Живой обмен `device_code` на токен.** Параметры и хосты выверены curl'ом
      (`device_code` → `authorization_pending`), но настоящий токен не получен ни
      разу. Вход в панели работает, код доходит, опрос идёт — обрыв на последнем
      шаге. Нужен браузер: `http://127.0.0.1:8080/` → **Sign in** → код на
      `https://www.google.com/device`
- [ ] **Ротация client secret.** Он был опубликован в чате
- [ ] **Consent screen → In production.** Пока Testing, refresh-токен живёт 7 дней
- [ ] **Test users.** Если приложение останется в Testing, нужен список аккаунтов

### Код

- [ ] **Репозиторий на ТВ.** Главная по подпискам отдаётся отдельным роутом, но
      2016-клиент её не запрашивает — надо встроить вызов в навигацию
- [ ] **История в UI.** `FEhistory` отдаёт полки по сессии (проверено: анонимно
      пусто, в сессии — полка `Today`), но вкладка «История» может брать данные
      своим путём — надо проверить на реальном ТВ
- [ ] **Кэш и квота.** Каждая загрузка главной тратит `subscriptions.list`
      (1 unit / 50 каналов) плюс N запросов InnerTube. При 10k units/сутки и
      большом числе зрителей нужен кэш по `sub`
- [ ] **Квота на подписку 200 каналов** — параметр сейчас фиксирован, не из
      конфига
- [ ] **Миграция `back/history/default.json`** (9 записей, 3.4 КБ). Лежит на
      диске, больше не обслуживается. Решить: оставить сиротой или назначить
      первому вошедшему аккаунту
- [ ] **Старый `profile_id`-cookie** (`yt_profile_id`) в клиенте: стал ярлыком,
      но код в `assets/custom-player.js` ещё его пишет
- [ ] **`/o/oauth2/token`** (legacy TV-OAuth) принимает credentials в body.
      Не ломаем — им пользуется `assets/app-prod.js`, но аудит не сделан
- [ ] **Двойной префикс `/assets/assets/app-prod.js`.** В `index.html:291`
      `appRoot = "/assets/"`, а `live.js:24` склеивает `appRoot + label`, где
      `label = "assets"`. Плюс `tv_binary` начинается со слэша. Работает только
      благодаря редиректу `assets/:folder/*` → `assets/*` в `server.js:395`,
      который срезает `?v=` у части запросов → кэш-баст может не доехать
- [ ] **`tv_binary` → `/app-prod.js` отдаёт 404.** Путь в `index.html:220`
      абсолютный и не проходит через `appRoot`; в логах 14 таких запросов перед
      успешным. Тот же вопрос к `tv_css` → `/app-prod.css`

### Инфраструктура

- [ ] **SIGTERM игнорируется.** Контейнер дважды убивался `docker stop`: SIGTERM
      → 10 с → SIGKILL, exit `137`. Не OOM. `deploy/entrypoint.sh` не пробрасывает
      сигналы процессу node
- [ ] **`back/viewer_auth.env` на сервере деплоя** — файл должен быть создан вручную
      с правами 600
- [ ] **Резервная копия тома `accounts`** — там refresh-токены; потеря тома = все
      зрители проходят device flow заново

---

## Тесты

Все зелёные на момент записи.

| Набор                         | Что проверяет                                                                               | Итог  |
|-------------------------------|---------------------------------------------------------------------------------------------|-------|
| `viewer_accounts` (unit)      | mint/verify сессии, отзыв, повторный вход, изоляция аккаунтов                               | 5/5   |
| `subscriptions_feed` (разбор) | обход дерева, дедуп, форматы, `SHORTS`, пул, циклы                                          | 21/21 |
| `subscriptions_feed` (сеть)   | частичные сбои, квота, пагинация, чужой `browseId`                                          | 16/16 |
| headless Chrome               | панель, код, ссылка на Google, старт опроса, `getAuth`                                      | 7/7   |
| HTTP-регрессия                | `home` 200 / `FEwhat_to_watch` 200 / `FEsubscriptions` 200 / `FEhistory` 200, анонимные 401 | ок    |

Три ошибки были в тестах, не в коде: зашитый формат кода `XXXX-XXXX-XXXX`
(Google выдаёт `3-3-3` и `4-3`), забытый `Network.enable` в CDP, и модуль,
захвативший настоящий `axios` до установки mock.

Живой путь `device_code` → токен → `sub` не покрыт: требует браузера.

---

## Ограничения, которые не обойти

- Историю нельзя записать в аккаунт YouTube через Data API v3. Серверный
  журнал — единственный вариант. Видео, просмотренные до установки сборки, в
  аккаунте не появятся.
- Главная — это подписки, а не рекомендации YouTube. Персонализация
  рекомендаций привязана к browser-сессионным cookie, которых у ТВ нет.
- OAuth app в Testing → refresh-токен 7 дней. Без In production это придётся
  повторять регулярно.

## Файлы

Изменены: `back/server.js`, `back/history_store.js`, `back/exp_browse_api.js`,
`back/oauth_api_v3_api.js`, `assets/custom-player.js`, `index.html`,
`docker-compose.yml`, `deploy.sh`, `.gitignore`, `.dockerignore`.

Добавлены: `back/viewer_accounts.js`, `back/subscriptions_feed.js`,
`back/viewer_auth.env.example`.

Секреты: `back/viewer_auth.env` (mode 600, gitignored, вне build context).

Коммит не делался по требованию.