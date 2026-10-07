# Multi-stage: компилятор и -dev заголовки живут только в builder,
# в рантайм-образ уходит готовый venv. Зависимости ставятся строго по
# uv.lock, отдельным слоем — правка кода не пересобирает mediapipe/opencv.

FROM python:3.12-slim AS builder

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl \
        # MediaPipe / OpenCV runtime deps (attendance photo face-check).
        libgl1 libglib2.0-0 \
        # DejaVu TTF — reportlab PDF (payroll) кириллице нужен настоящий
        # unicode-шрифт, иначе Helvetica рендерит русский/узбекский как ■■■.
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY . /app
RUN chmod +x /app/scripts/entrypoint.sh

EXPOSE 8000

CMD ["/app/scripts/entrypoint.sh"]
