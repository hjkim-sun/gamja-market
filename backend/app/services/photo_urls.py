from __future__ import annotations

from urllib.parse import quote
from uuid import UUID


def photo_url(namespace: tuple[str, str | None], storage_path: str, photo_id: UUID, ext: str, supabase_url: str | None = None) -> str | None:
    backend, bucket = namespace
    if backend in {"local", "memory"}:
        return f"/api/request-photos/files/{photo_id}.{ext}"
    if backend == "supabase" and bucket and supabase_url:
        return f"{supabase_url.rstrip('/')}/storage/v1/object/public/{quote(bucket, safe='')}/{quote(storage_path, safe='/')}"
    return None
