"""
IMEI lookup: local TAC table is the source of truth; an optional online
provider is consulted only if enabled in settings and the local lookup misses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from django.conf import settings

from apps.common.validators import extract_tac, is_valid_imei

from .selectors import tac_get


@dataclass(frozen=True)
class ImeiLookupResult:
    valid: bool
    brand: str = ""
    model: str = ""
    source: Literal["local", "online", "none"] = "none"

    def as_dict(self) -> dict:
        return {
            "valid": self.valid,
            "brand": self.brand,
            "model": self.model,
            "source": self.source,
        }


def imei_lookup(imei: str) -> ImeiLookupResult:
    if not is_valid_imei(imei):
        return ImeiLookupResult(valid=False)

    tac = extract_tac(imei)
    local = tac_get(tac)
    if local:
        return ImeiLookupResult(valid=True, brand=local.brand, model=local.model, source="local")

    if getattr(settings, "IMEI_ONLINE_LOOKUP_ENABLED", False):
        online = _imei_lookup_online(imei)
        if online:
            return online

    return ImeiLookupResult(valid=True, source="none")


def _imei_lookup_online(imei: str) -> ImeiLookupResult | None:
    """
    Pluggable, deliberately defensive: any failure falls back to manual entry.
    """
    try:
        import httpx
    except ImportError:
        return None

    url = settings.IMEI_ONLINE_API_URL
    key = settings.IMEI_ONLINE_API_KEY
    if not url or not key:
        return None
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, params={"imei": imei, "api_key": key})
            if resp.status_code != 200:
                return None
            data = resp.json()
            brand = (data.get("brand") or "").strip()
            model = (data.get("model") or "").strip()
            if not brand and not model:
                return None
            return ImeiLookupResult(valid=True, brand=brand, model=model, source="online")
    except Exception:
        return None
