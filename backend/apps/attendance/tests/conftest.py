"""
Attendance tests-level conftest.

Автомокаем `IsAttendancePinVerified` для всех тестов attendance-app'a,
чтобы legacy-тесты (написанные до PIN-gate) не разлетелись на 401 —
менеджеры/тимлиды получают проход без явного verify.

Единственное исключение — `test_pin.py`: там сам PIN-gate под покрытием,
и мокать нельзя. Файл сам себя opt-out'ит через `pytest.mark`.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _autopass_attendance_pin(request, monkeypatch):
    """По умолчанию считаем PIN-сессию валидной — legacy-тесты не в курсе
    новой gate'ы. Тесты PIN-gate'a должны сами отменить это, отметив
    `@pytest.mark.pin_gate` на функции или модуле."""
    if request.node.get_closest_marker("pin_gate"):
        return
    monkeypatch.setattr(
        "apps.attendance.permissions.attendance_pin_session_is_valid",
        lambda _user: True,
    )
