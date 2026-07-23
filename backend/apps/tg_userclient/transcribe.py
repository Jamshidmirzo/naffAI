"""
Voice message transcription interface.

Behind feature flag ``TG_TRANSCRIBE_VOICE`` (default False / off).
When enabled, downloads voice messages and sends them to Whisper.

Provider selection via ``settings.TG_TRANSCRIBE_PROVIDER``:
- ``openai`` — OpenAI Whisper API (whisper-1)
- ``local``  — placeholder for local whisper.cpp (not yet implemented)
"""

from __future__ import annotations

import logging
from pathlib import Path

from django.conf import settings

logger = logging.getLogger("apps.tg_userclient")


def transcribe(audio_path: str | Path) -> str:
    """
    Transcribe an audio file to text.

    Returns the transcript string. Raises on error.
    """
    provider = getattr(settings, "TG_TRANSCRIBE_PROVIDER", "openai")

    if provider == "openai":
        return _transcribe_openai(audio_path)
    raise NotImplementedError(f"Transcription provider '{provider}' not implemented")


def _transcribe_openai(audio_path: str | Path) -> str:
    """Transcribe via OpenAI Whisper API."""
    import httpx

    api_key = getattr(settings, "OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not configured for transcription")

    path = Path(audio_path)
    with path.open("rb") as f:
        resp = httpx.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (path.name, f, "audio/ogg")},
            data={"model": "whisper-1"},
            timeout=120,
        )
    resp.raise_for_status()
    return resp.json().get("text", "")
