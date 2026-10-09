from __future__ import annotations

import threading

import httpx

from app.storage.base import StorageError

_shared_client: httpx.Client | None = None
_shared_client_lock = threading.Lock()


class SupabasePhotoStorage:
    def __init__(self, url: str, secret_key: str, bucket: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self.url, self._secret_key, self.bucket = url.rstrip("/"), secret_key, bucket
        self._transport = transport
        self._injected_client: httpx.Client | None = None

    def _client(self) -> httpx.Client:
        global _shared_client
        if self._transport is not None:
            if self._injected_client is None:
                self._injected_client = httpx.Client(
                    timeout=httpx.Timeout(10.0, connect=3.0), transport=self._transport
                )
            return self._injected_client
        if _shared_client is None:
            with _shared_client_lock:
                if _shared_client is None:
                    _shared_client = httpx.Client(
                        timeout=httpx.Timeout(10.0, connect=3.0),
                        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                    )
        return _shared_client

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
            response = self._client().post(
                    f"{self.url}/storage/v1/object/{self.bucket}/{path}", content=data,
                    headers={**self._headers(), "Content-Type": content_type, "x-upsert": "false", "cache-control": "3600"},
                )
            response.raise_for_status()
        except httpx.HTTPError:
            raise StorageError("storage write failed") from None

    def read(self, path: str) -> bytes:
        try:
            response = self._client().get(
                    f"{self.url}/storage/v1/object/authenticated/{self.bucket}/{path}",
                    headers=self._headers(),
                )
            if response.status_code == 404:
                raise FileNotFoundError("photo object not found")
            response.raise_for_status()
            return response.content
        except httpx.HTTPError:
            raise StorageError("storage read failed") from None

    def delete_many(self, paths: list[str]) -> set[str]:
        if not paths:
            return set()
        try:
            response = self._client().request("DELETE", f"{self.url}/storage/v1/object/{self.bucket}", json={"prefixes": paths}, headers=self._headers())
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise StorageError("storage delete failed")
        except (httpx.HTTPError, ValueError):
            raise StorageError("storage delete failed") from None
        return set(paths)
