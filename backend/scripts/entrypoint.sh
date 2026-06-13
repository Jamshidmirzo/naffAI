#!/usr/bin/env bash
set -e

cd /app

echo "[entrypoint] applying migrations..."
python manage.py migrate --noinput

echo "[entrypoint] seeding base data (idempotent)..."
python manage.py seed_channels || true
python manage.py seed_tac --builtin || true

if [ -n "${DJANGO_SUPERUSER_USERNAME:-}" ]; then
  echo "[entrypoint] ensuring superuser ${DJANGO_SUPERUSER_USERNAME}..."
  python manage.py shell -c "
from django.contrib.auth import get_user_model
U = get_user_model()
u, created = U.objects.get_or_create(username='${DJANGO_SUPERUSER_USERNAME}', defaults={'is_superuser': True, 'is_staff': True, 'email': '${DJANGO_SUPERUSER_EMAIL:-}'})
if created or not u.has_usable_password():
    u.set_password('${DJANGO_SUPERUSER_PASSWORD:-admin}')
    u.is_superuser = True; u.is_staff = True
    u.save()
    print('superuser ready')
else:
    print('superuser already exists')
" || true
fi

echo "[entrypoint] collectstatic..."
python manage.py collectstatic --noinput --clear || true

if [ "${DJANGO_DEBUG:-0}" = "1" ]; then
  echo "[entrypoint] starting Django dev server on :8000"
  exec python manage.py runserver 0.0.0.0:8000
else
  echo "[entrypoint] starting gunicorn on :8000"
  exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 3 --access-logfile -
fi
