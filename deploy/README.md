# Запуск Jhin как сервиса

Общая информация по запуску и quickstart — в [README.md](../README.md). Здесь: сервисный запуск, рестарт-луп `/admin/reload`, TLS/проксирование, бэкап, обновление.

## Запуск jar

```bash
java -jar jhin-backend-0.1.0-SNAPSHOT.jar
```

Каталог данных — `JHIN_HOME` (дефолт `~/.jhin`): `jhin.db`, `keystore/`, `plugins/`, `mcp.json`. TLS — самоподписанный, генерируется при первом старте (фингерпринт в логе).

## systemd

Generic unit для Linux (`User=jhin` или любой юзер с правами на `JHIN_HOME`):

```ini
[Unit]
Description=Jhin hub
After=network.target

[Service]
User=jhin
Environment=JHIN_HOME=/var/lib/jhin
ExecStart=/usr/bin/java -jar /opt/jhin/jhin-backend-0.1.0-SNAPSHOT.jar
Restart=always

[Install]
WantedBy=multi-user.target
```

Каталог `/var/lib/jhin` создайте заранее и отдайте юзеру сервиса. `Restart=always` обязателен, если вы планируете `/admin/reload` (см. ниже).

## /admin/reload и рестарт-луп

`POST /admin/reload` (Bearer-токен) — graceful restart: активные runs переводятся в `INTERRUPTED`, SSE-стримы закрываются, процесс делает `System.exit(0)` через `jhin.reload.exit-delay-millis` (2000 мс). Сам процесс **не перезапускается** — нужен внешний рестартер:

- **systemd** (`Restart=always`) — обычный выбор: юнит сам поднимет процесс после выхода.
- **`deploy/run.sh`** — минимальный рестарт-луп без systemd:

  ```bash
  ./run.sh /opt/jhin/jhin-backend-0.1.0-SNAPSHOT.jar
  ```

  Скрипт запускает jar и через 1 секунду после любого выхода запускает снова.

Разница: systemd даёт supervision (журнал, лимиты, рестарт после крашей), `run.sh` — только «поднять снова»; оба варианта обслуживают `/admin/reload`. SSE-клиенты при рестарте реконнектятся сами (resume по `fromSeq`), разрыва не видят.

## TLS и проксирование

Hub по умолчанию работает с самоподписанным сертификатом: `keystore/server.p12` + `keystore/server.p12.password` (0600) в `$JHIN_HOME`, SHA-256-фингерпринт пишется в лог (`AA:BB:…`, 95 символов) и пинится клиентами при первом подключении (TOFU).

**Свой сертификат/keystore через `server.ssl.*` в MVP не поддерживается.** Два варианта:

1. Оставить самоподписанный серт и раздать фингерпринт клиентам (io-клиенты пинят его; web полагается на решения браузера).
2. **Escape hatch** `server.ssl.enabled=false` — hub поднимается на обычном HTTP за reverse-proxy с терминацией TLS (Traefik, nginx). Reverse-proxy в MVP не входит, но ставить hub за него осознанно можно: туннель/VPN/localhost — ваша зона ответственности.

## Бэкап

Данные живут в `$JHIN_HOME`; бэкапить нужно две вещи:

1. **`jhin.db`** (+ файлы `jhin.db-wal` / `jhin.db-shm`, если процесс жив — SQLite в режиме WAL):
   - остановить сервис и скопировать `jhin.db*`, либо
   - при живом процессе — через sqlite3: `sqlite3 $JHIN_HOME/jhin.db ".backup '/backup/jhin.db'"`.
2. **`keystore/`** (`server.p12` + `server.p12.password`) — отдельно и обязательно: при потере keystore следующий старт сгенерирует новый серт, клиенты с TOFU-pinningом откажутся подключаться.

Таблицы БД: `accounts`, `devices`, `enrollment_codes`, `sessions`, `events`, `runs`, `providers`, `workers`. Токены устройств и enrollment-коды в БД — только SHA-256-хеши; `api_key` провайдеров — plaintext-ом (см. раздел безопасности README).

## Обновление

1. Остановить сервис.
2. Заменить jar на новую версию.
3. Запустить сервис.

Миграции схемы идемпотентны (версия схемы в БД, `V*.sql` применяются по порядку) — повторный старт ничего не ломает. `JHIN_HOME` не пересоздаётся; файлы данных и keystore остаются на месте.
