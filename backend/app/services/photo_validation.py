from __future__ import annotations

import io
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from collections.abc import Iterator

from PIL import Image, ImageOps

from app.core.config import get_settings

MAX_BYTES = 3 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_EDGE = 1600
NORMALIZE_CONCURRENCY = 2
IMAGE_NORMALIZE_CONCURRENCY = NORMALIZE_CONCURRENCY
_normalize_slots = threading.BoundedSemaphore(NORMALIZE_CONCURRENCY)
_wait_seconds_override: ContextVar[float | None] = ContextVar("image_normalize_wait_seconds", default=None)
_FORMATS = {"image/jpeg": ("JPEG", "jpg"), "image/png": ("PNG", "png"), "image/webp": ("WEBP", "webp")}


class InvalidImage(Exception):
    pass


class ImageTooLarge(Exception):
    pass


class ImageNormalizationBusy(Exception):
    pass


@contextmanager
def normalization_wait_limit(seconds: float) -> Iterator[None]:
    token = _wait_seconds_override.set(seconds)
    try:
        yield
    finally:
        _wait_seconds_override.reset(token)


@dataclass(frozen=True)
class NormalizedImage:
    data: bytes
    content_type: str
    ext: str
    width: int
    height: int


def _signature_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def normalize_image(
    data: bytes,
    declared_content_type: str,
    *,
    wait_seconds: float | None = None,
) -> NormalizedImage:
    if len(data) > MAX_BYTES:
        raise ImageTooLarge
    expected = _FORMATS.get(declared_content_type)
    if expected is None or _signature_type(data) != declared_content_type:
        raise InvalidImage
    # Inspect headers before taking a scarce decode slot so invalid and oversized
    # files do not block valid uploads waiting to be normalized.
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format != expected[0] or source.width * source.height > MAX_PIXELS:
                raise InvalidImage
            if getattr(source, "is_animated", False) or getattr(source, "n_frames", 1) > 1:
                raise InvalidImage
    except Exception as exc:
        if isinstance(exc, InvalidImage):
            raise
        raise InvalidImage from None

    if wait_seconds is None:
        wait_seconds = _wait_seconds_override.get()
    if wait_seconds is None:
        wait_seconds = get_settings().image_normalize_wait_seconds
    acquired = _normalize_slots.acquire(timeout=wait_seconds)
    if not acquired:
        raise ImageNormalizationBusy
    try:
        try:
            with Image.open(io.BytesIO(data)) as source:
                source.load()
                image = ImageOps.exif_transpose(source)
                if max(image.size) > MAX_EDGE:
                    image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
                # Palette PNG transparency lives in info; make it pixels before scrubbing.
                if source.format == "PNG" and (image.mode == "P" or "transparency" in image.info):
                    image = image.convert("RGBA")
                image.info.clear()
                width, height = image.size
                output = _encode(image, source.format)
        except ImageTooLarge:
            raise
        except Exception as exc:
            if isinstance(exc, InvalidImage):
                raise
            raise InvalidImage from None
    finally:
        _normalize_slots.release()
    if len(output) > MAX_BYTES:
        raise ImageTooLarge
    return NormalizedImage(output, declared_content_type, expected[1], width, height)


def _encode(image: Image.Image, image_format: str) -> bytes:
    qualities = (85, 75, 65) if image_format in {"JPEG", "WEBP"} else (None,)
    for quality in qualities:
        candidate = image
        options: dict[str, object] = {}
        if image_format == "JPEG":
            if candidate.mode not in {"RGB", "L"}:
                candidate = candidate.convert("RGB")
            options = {"quality": quality, "optimize": True, "progressive": True}
        elif image_format == "PNG":
            options = {"compress_level": 6}
        else:
            if candidate.mode not in {"RGB", "RGBA"}:
                candidate = candidate.convert("RGBA" if "A" in candidate.getbands() else "RGB")
            options = {"quality": quality, "method": 4}
        output = io.BytesIO()
        candidate.save(output, format=image_format, **options)
        data = output.getvalue()
        if len(data) <= MAX_BYTES:
            return data
    raise ImageTooLarge
