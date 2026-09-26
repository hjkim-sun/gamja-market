from __future__ import annotations

from typing import Protocol


class StorageError(Exception):
    pass


class PhotoStorage(Protocol):
    @property
    def namespace(self) -> tuple[str, str | None]: ...
    def put(self, path: str, data: bytes, content_type: str) -> None: ...
    def delete_many(self, paths: list[str]) -> set[str]: ...
