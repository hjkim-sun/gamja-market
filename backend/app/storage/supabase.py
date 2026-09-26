from __future__ import annotations

import httpx

from app.storage.base import StorageError


class SupabasePhotoStorage:
    def __init__(self, url: str, secret_key: str, bucket: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self.url, self._secret_key, self.bucket = url.rstrip("/"), secret_key, bucket
        self._transport = transport

    @property
    def namespace(self) -> tuple[str, str]:
        return ("supabase", self.bucket)

    def _headers(self) -> dict[str, str]:
        headers = {"apikey": self._secret_key}
        if not self._secret_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self._secret_key}"
        return headers

    def put(self, path: str, data: bytes, content_type: str) -> None:
        try:
            with httpx.Client(timeout=httpx.Timeout(10.0, connect=3.0), transport=self._transport) as client:
                response = client.post(
                    f"{self.url}/storage/v1/object/{self.bucket}/{path}", content=data,
                    headers={**self._headers(), "Content-Type": content_type, "x-upsert": "false", "cache-control": "3600"},
                )
                response.raise_for_status()
        except httpx.HTTPError:
            raise StorageError("storage write failed") from None

    def delete_many(self, paths: list[str]) -> set[str]:
        if not paths:
            return set()
        try:
            with httpx.Client(timeout=httpx.Timeout(10.0, connect=3.0), transport=self._transport) as client:
                response = client.request("DELETE", f"{self.url}/storage/v1/object/{self.bucket}", json={"prefixes": paths}, headers=self._headers())
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise StorageError("storage delete failed")
        except (httpx.HTTPError, ValueError):
            raise StorageError("storage delete failed") from None
        return set(paths)
