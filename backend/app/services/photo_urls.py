from __future__ import annotations

from uuid import UUID


def photo_url(namespace: tuple[str, str | None], photo_id: UUID, ext: str) -> str | None:
    backend, bucket = namespace
    if backend in {"local", "memory", "supabase"} and (backend != "supabase" or bucket):
        return f"/api/request-photos/files/{photo_id}.{ext}"
    return None
