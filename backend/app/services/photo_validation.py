from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageOps

MAX_BYTES = 3 * 1024 * 1024
MAX_PIXELS = 20_000_000
_FORMATS = {"image/jpeg": ("JPEG", "jpg"), "image/png": ("PNG", "png"), "image/webp": ("WEBP", "webp")}


class InvalidImage(Exception):
    pass


class ImageTooLarge(Exception):
    pass


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


def normalize_image(data: bytes, declared_content_type: str) -> NormalizedImage:
    if len(data) > MAX_BYTES:
        raise ImageTooLarge
    expected = _FORMATS.get(declared_content_type)
    if expected is None or _signature_type(data) != declared_content_type:
        raise InvalidImage
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format != expected[0] or source.width * source.height > MAX_PIXELS:
                raise InvalidImage
            if getattr(source, "is_animated", False) or getattr(source, "n_frames", 1) > 1:
                raise InvalidImage
            source.load()
            image = ImageOps.exif_transpose(source)
            # Palette PNG transparency lives in ``info['transparency']``. Make
            # it pixels first, because the metadata scrub below must remove it.
            if source.format == "PNG" and (image.mode == "P" or "transparency" in image.info):
                image = image.convert("RGBA")
            # Pillow may retain source metadata in ``info``; never pass it on.
            image.info.clear()
            width, height = image.size
            if width * height > MAX_PIXELS:
                raise InvalidImage
            output = _encode(image, source.format)
    except ImageTooLarge:
        raise
    except Exception as exc:
        if isinstance(exc, InvalidImage):
            raise
        raise InvalidImage from None
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
            options = {"optimize": True}
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
