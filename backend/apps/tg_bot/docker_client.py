"""
Read-only async httpx client to Docker Engine API via `tecnativa/docker-socket-proxy`.

Bот использует его для двух вещей:
  * `list_containers()` — таблица «что запущено, кто перезапускался,
    какие OOM'нулись» → рендерится в /health.
  * `tail_logs(name, n)` — последние N строк логов конкретного контейнера
    (`/logs distribute-watcher 50`).

Proxy настроен в docker-compose как отдельный сервис — CONTAINERS=1,
всё остальное запрещено, `/var/run/docker.sock` монтируется read-only.
Даже если бота компрометируют — управлять хостом через docker API
нельзя (POST/exec/create/start/stop/kill — все заблокированы прокси).

Docker API endpoints:
  - GET /containers/json?all=1
  - GET /containers/{id}/json      (inspect → RestartCount, OOMKilled)
  - GET /containers/{id}/logs?...  (returns 8-byte framed multiplexed stream)

Log frame format (docker docs):
  header = 8 bytes:
    [0]   stream type (0=stdin, 1=stdout, 2=stderr)
    [1-3] padding
    [4-7] payload length (big-endian uint32)
  payload = <length> bytes
"""

from __future__ import annotations

import logging
import os
import struct
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)


DOCKER_PROXY_URL = os.getenv("DOCKER_PROXY_URL", "http://docker-proxy:2375").rstrip("/")
DEFAULT_TIMEOUT = float(os.getenv("DOCKER_PROXY_TIMEOUT", "5.0"))

# Whitelist контейнеров, откуда бот вообще имеет право читать логи.
# Полный запрет на всё вне списка — даже если пользователь угадает имя,
# не даём вытащить логи, где могут лежать секреты (например, `db`).
LOG_WHITELIST: frozenset[str] = frozenset(
    {
        "distribute-watcher",
        "sheet-sync",
        "morning-splitter",
        "scheduler",
        "reports-scheduler",
        "userclient",
        "bot",
        "web",
        "lesson-generator",
        "ops-nightly",
    }
)


@dataclass
class ContainerInfo:
    """Slim view of a docker container — только то, что нужно /health."""

    id: str
    name: str  # без слэша и без compose-префикса, если удалось откусить
    raw_name: str  # полное имя как отдаёт docker (`/naffai-web-1`)
    image: str
    state: str  # running / exited / restarting / …
    status: str  # человекочитаемая («Up 2 hours», «Exited (137) 5 minutes ago»)
    restart_count: int
    oom_killed: bool


def _short_name(raw: str) -> str:
    """
    Docker имена вида `/naffai-web-1` → `web`.
    Убираем ведущий `/`, компоуз-префикс (первый сегмент) и trailing `-N`.
    """
    n = raw.lstrip("/")
    parts = n.split("-")
    if len(parts) >= 3 and parts[-1].isdigit():
        # `naffai-web-1` → срединные сегменты
        return "-".join(parts[1:-1]) or n
    if len(parts) >= 2 and parts[-1].isdigit():
        return "-".join(parts[:-1])
    return n


async def _get_json(client: httpx.AsyncClient, path: str, params: dict | None = None):
    resp = await client.get(path, params=params or {})
    resp.raise_for_status()
    return resp.json()


async def list_containers() -> list[ContainerInfo]:
    """
    GET /containers/json?all=1 + inspect на каждый — иначе RestartCount
    и OOMKilled недоступны. Timeout соблюдается для всей операции; при
    сбое возвращаем пустой список и пишем предупреждение (бот не должен
    падать, если proxy временно недоступен).
    """
    result: list[ContainerInfo] = []
    try:
        async with httpx.AsyncClient(
            base_url=DOCKER_PROXY_URL, timeout=DEFAULT_TIMEOUT
        ) as client:
            listing = await _get_json(client, "/containers/json", params={"all": "1"})
            for item in listing:
                cid = item.get("Id") or ""
                names = item.get("Names") or []
                raw_name = names[0] if names else cid[:12]
                short = _short_name(raw_name)
                image = item.get("Image") or ""
                state = item.get("State") or ""
                status = item.get("Status") or ""

                restart_count = 0
                oom_killed = False
                try:
                    inspect = await _get_json(client, f"/containers/{cid}/json")
                    restart_count = int(inspect.get("RestartCount", 0) or 0)
                    st = inspect.get("State") or {}
                    oom_killed = bool(st.get("OOMKilled", False))
                except Exception:
                    # inspect может отвалиться на удалении контейнера
                    # прямо в момент опроса — не ломаем всю таблицу.
                    log.debug("inspect failed for %s", cid, exc_info=True)

                result.append(
                    ContainerInfo(
                        id=cid,
                        name=short,
                        raw_name=raw_name,
                        image=image,
                        state=state,
                        status=status,
                        restart_count=restart_count,
                        oom_killed=oom_killed,
                    )
                )
    except Exception:
        log.warning("docker-proxy unreachable at %s", DOCKER_PROXY_URL, exc_info=True)
        return []
    return result


def demultiplex_log_frames(raw: bytes) -> list[str]:
    """
    Docker returns log stream as concatenated 8-byte-header + payload frames.
    Вытаскиваем и склеиваем в текст, разбитый по строкам.

    Frame:
      B0: stream (0=stdin/1=stdout/2=stderr)
      B1..B3: padding (нули)
      B4..B7: uint32 big-endian — длина payload

    Если docker отдал tty=true, поток не мультиплексирован — тогда
    первый байт может быть чем угодно и uint32 длины не совпадёт с
    остатком. В этом случае просто декодируем как plain text.
    """
    if not raw:
        return []
    out: list[str] = []
    i = 0
    n = len(raw)
    while i + 8 <= n:
        header = raw[i : i + 8]
        stream = header[0]
        # sanity: только 0,1,2 валидны, остальные — значит формат не multiplexed
        if stream not in (0, 1, 2):
            break
        (length,) = struct.unpack(">I", header[4:8])
        if length < 0 or i + 8 + length > n:
            break
        payload = raw[i + 8 : i + 8 + length]
        try:
            out.append(payload.decode("utf-8", errors="replace"))
        except Exception:
            out.append(payload.decode("latin-1", errors="replace"))
        i += 8 + length

    if not out:
        # Fallback: не multiplexed / TTY-режим — декодируем как есть.
        try:
            out.append(raw.decode("utf-8", errors="replace"))
        except Exception:
            out.append(raw.decode("latin-1", errors="replace"))

    text = "".join(out)
    # Разбиваем по строкам, убираем пустые в хвосте.
    lines = text.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


async def tail_logs(name: str, n: int = 50) -> tuple[list[str], str]:
    """
    Хвост логов контейнера. `name` — короткое имя (`web`, `bot`,
    `distribute-watcher`); резолвим в id через `list_containers()`.

    Returns (lines, error). При успехе error=="".
    """
    n = max(1, min(int(n or 50), 200))
    short = (name or "").strip().lower()
    if short not in LOG_WHITELIST:
        return (
            [],
            f"❌ Логи контейнера «{short}» недоступны боту. "
            f"Разрешено: {', '.join(sorted(LOG_WHITELIST))}.",
        )

    containers = await list_containers()
    hit: ContainerInfo | None = None
    for c in containers:
        if c.name.lower() == short:
            hit = c
            break
    if hit is None:
        return ([], f"❌ Не нашёл запущенный контейнер «{short}».")

    try:
        async with httpx.AsyncClient(
            base_url=DOCKER_PROXY_URL, timeout=DEFAULT_TIMEOUT
        ) as client:
            resp = await client.get(
                f"/containers/{hit.id}/logs",
                params={
                    "stdout": "1",
                    "stderr": "1",
                    "tail": str(n),
                    "timestamps": "0",
                },
            )
            resp.raise_for_status()
            raw = resp.content
    except Exception as exc:
        log.warning("docker log fetch failed for %s: %s", short, exc)
        return ([], f"❌ Не смог получить логи: {exc}")

    lines = demultiplex_log_frames(raw)
    return (lines, "")


# --------------------------------------------------------------------------
# Convenience wrappers used by runner (sync fallback for testing)
# --------------------------------------------------------------------------


async def crash_snapshot() -> list[dict]:
    """
    Лёгкий snapshot для crash_watch loop: только имя + state + restarts +
    oom, без inspect на каждый (нужен для сравнения между тиками).
    """
    infos = await list_containers()
    return [
        {
            "name": c.name,
            "state": c.state,
            "status": c.status,
            "restart_count": c.restart_count,
            "oom_killed": c.oom_killed,
        }
        for c in infos
    ]
