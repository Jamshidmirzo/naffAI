"""
Attendance photo face-detection + perceptual-hash + anti-dup helpers.

Design notes:

- We only check "photo contains a face" (presence). No identification vs
  operator avatar — that is out of scope. MediaPipe is optimal (~10 MB,
  ~150 MB RSS warm) and gives good confidence on selfies.
- If MediaPipe (or its native libs) can't import for any reason we fall
  back to OpenCV's Haar cascade — same «is there a face?» question, way
  smaller image size, tolerates missing libgl1. If neither is available,
  `detect_face` returns True (no false negatives) but logs a warning so
  operators aren't blocked.
- Perceptual hash via `imagehash.phash` — 64-bit → 16 hex chars. Two
  photos are "the same" if hamming distance ≤ 5 within a 24h window per
  operator. Threshold is intentionally strict-ish; tune via
  `is_photo_recent_duplicate` args if false-positives appear.
- All functions accept raw `bytes` so callers stay simple (multipart
  upload, Telegram photo download — both give bytes).
"""

from __future__ import annotations

import datetime as dt
import io
import logging
from typing import Optional

from django.utils import timezone

logger = logging.getLogger("attendance.face")


_MP_DETECTOR = None
_MP_LEGACY_DETECTOR = None
_MP_INIT_FAILED = False


def _get_mediapipe_detector():
    """
    Lazy MediaPipe face detector singleton.

    Tries the modern Tasks API first (MediaPipe 0.10+ / ARM64 wheels).
    Falls back to the legacy `mp.solutions.face_detection` for older
    wheels. Returns (detector, is_tasks_api) or None.
    """
    global _MP_DETECTOR, _MP_LEGACY_DETECTOR, _MP_INIT_FAILED
    if _MP_INIT_FAILED:
        return None
    if _MP_DETECTOR is not None:
        return _MP_DETECTOR, True
    if _MP_LEGACY_DETECTOR is not None:
        return _MP_LEGACY_DETECTOR, False
    # Try modern Tasks API first — 0.10+ wheels sometimes only ship this.
    try:
        import mediapipe as mp  # type: ignore

        if hasattr(mp, "tasks"):
            from mediapipe.tasks.python import vision  # type: ignore
            from mediapipe.tasks.python.core import base_options as _bo  # type: ignore

            # Prefer BlazeFace short-range model. Tasks API needs an on-disk
            # model file; MediaPipe bundles nothing by default, so we
            # bootstrap it lazily from a URL when missing. Cache under
            # /tmp — no persistence needed between deployments.
            import os
            import urllib.request

            model_dir = "/tmp/mediapipe-models"
            model_path = os.path.join(model_dir, "blaze_face_short_range.tflite")
            if not os.path.exists(model_path):
                os.makedirs(model_dir, exist_ok=True)
                url = (
                    "https://storage.googleapis.com/mediapipe-models/"
                    "face_detector/blaze_face_short_range/float16/latest/"
                    "blaze_face_short_range.tflite"
                )
                try:
                    urllib.request.urlretrieve(url, model_path)  # noqa: S310
                    logger.info("Downloaded MediaPipe face model to %s", model_path)
                except Exception as exc:
                    logger.warning("Face model download failed: %s", exc)
                    raise
            opts = vision.FaceDetectorOptions(
                base_options=_bo.BaseOptions(model_asset_path=model_path),
                min_detection_confidence=0.6,
            )
            _MP_DETECTOR = vision.FaceDetector.create_from_options(opts)
            logger.info("MediaPipe FaceDetector (Tasks API) initialised")
            return _MP_DETECTOR, True
        # Fallback: legacy Solutions API (0.9.x + some 0.10.x wheels).
        if hasattr(mp, "solutions") and hasattr(mp.solutions, "face_detection"):
            _MP_LEGACY_DETECTOR = mp.solutions.face_detection.FaceDetection(
                model_selection=0, min_detection_confidence=0.7
            )
            logger.info("MediaPipe FaceDetection (legacy Solutions API) initialised")
            return _MP_LEGACY_DETECTOR, False
        raise RuntimeError("mediapipe has neither .tasks nor .solutions.face_detection")
    except Exception as exc:
        _MP_INIT_FAILED = True
        logger.warning("MediaPipe unavailable, will fall back: %s", exc)
        return None


def _detect_with_mediapipe(image_bytes: bytes) -> Optional[bool]:
    """Return True/False if MediaPipe processed the image, None on error."""
    pair = _get_mediapipe_detector()
    if pair is None:
        return None
    detector, is_tasks_api = pair
    try:
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        arr = np.asarray(img)
        if is_tasks_api:
            import mediapipe as mp  # type: ignore

            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)
            result = detector.detect(mp_image)
            return bool(getattr(result, "detections", None))
        # Legacy Solutions API.
        result = detector.process(arr)
        return bool(getattr(result, "detections", None))
    except Exception as exc:
        logger.warning("MediaPipe detection error: %s", exc)
        return None


def _detect_with_opencv(image_bytes: bytes) -> Optional[bool]:
    """Fallback face detector via Haar cascade — much smaller runtime cost."""
    try:
        import cv2  # type: ignore
        import numpy as np

        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.15, minNeighbors=5, minSize=(60, 60)
        )
        return len(faces) > 0
    except Exception as exc:
        logger.warning("OpenCV detection error: %s", exc)
        return None


def detect_face(image_bytes: bytes) -> bool:
    """
    Return True if the image contains at least one face.

    Strategy: MediaPipe first (accurate), OpenCV Haar cascade fallback
    (lightweight), permissive True if neither library is importable so
    operators aren't blocked from checking in when the deployment is
    misconfigured. Ops should watch logs for "no face detector available".
    """
    if not image_bytes:
        return False

    result = _detect_with_mediapipe(image_bytes)
    if result is not None:
        return result

    result = _detect_with_opencv(image_bytes)
    if result is not None:
        return result

    logger.warning(
        "no face detector available — returning True permissively "
        "(install mediapipe or opencv-python-headless)"
    )
    return True


def perceptual_hash(image_bytes: bytes) -> str:
    """
    Return a 16-char hex perceptual hash of the image.

    Uses `imagehash.phash` (64-bit DCT hash). Returns empty string on
    failure so the caller can just skip anti-dup checks rather than
    crashing the scan.
    """
    if not image_bytes:
        return ""
    try:
        import imagehash  # type: ignore
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes))
        return str(imagehash.phash(img))
    except Exception as exc:
        logger.warning("perceptual_hash failed: %s", exc)
        return ""


def _hex_hamming(a: str, b: str) -> int:
    """Bit-level Hamming distance between two equal-length hex strings."""
    if not a or not b or len(a) != len(b):
        return 999
    try:
        ia = int(a, 16)
        ib = int(b, 16)
    except ValueError:
        return 999
    return bin(ia ^ ib).count("1")


def is_photo_recent_duplicate(
    *,
    operator,
    phash: str,
    hours: int = 24,
    hamming_threshold: int = 5,
) -> bool:
    """
    Return True if this operator uploaded a "same enough" photo within
    the last `hours` window (checkin or checkout), by Hamming distance
    on their phash set.
    """
    if not phash:
        return False

    from .models import AttendanceLog

    since = timezone.now() - dt.timedelta(hours=hours)
    qs = (
        AttendanceLog.objects.filter(operator=operator)
        .filter(checked_in_at__gte=since)
        .values_list("checkin_photo_phash", "checkout_photo_phash")
    )
    for cin_h, cout_h in qs:
        if cin_h and _hex_hamming(cin_h, phash) <= hamming_threshold:
            return True
        if cout_h and _hex_hamming(cout_h, phash) <= hamming_threshold:
            return True
    return False


class PhotoValidationError(Exception):
    """Raised when a photo fails face detection or duplicate check."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def validate_and_hash_photo(
    *,
    operator,
    image_bytes: bytes,
    require_face: bool,
    max_size_mb: int,
) -> str:
    """
    Run the full photo-validation pipeline. Returns the perceptual hash on
    success, raises PhotoValidationError otherwise. Keeps the code path
    identical for HTTP scan endpoint and Telegram bot.
    """
    if not image_bytes:
        raise PhotoValidationError("photo_missing", "Фото не приложено")

    size_mb = len(image_bytes) / (1024 * 1024)
    if size_mb > max_size_mb:
        raise PhotoValidationError(
            "photo_too_large",
            f"Фото слишком большое (>{max_size_mb} МБ). Попробуйте ещё раз.",
        )

    if require_face and not detect_face(image_bytes):
        raise PhotoValidationError(
            "no_face", "На фото не найдено лицо, попробуйте ещё раз"
        )

    phash = perceptual_hash(image_bytes)
    if phash and is_photo_recent_duplicate(operator=operator, phash=phash):
        raise PhotoValidationError(
            "photo_duplicate",
            "Эта фотка уже использовалась, сделайте новую",
        )
    return phash
