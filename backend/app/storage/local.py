from __future__ import annotations

from pathlib import Path


class LocalPhotoStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def namespace(self) -> tuple[str, None]:
        return ("local", None)

    def _path(self, path: str) -> Path:
        candidate = (self.root / path).resolve()
        if self.root not in candidate.parents:
            raise ValueError("unsafe photo path")
        return candidate

    def put(self, path: str, data: bytes, content_type: str) -> None:
        target = self._path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def delete_many(self, paths: list[str]) -> set[str]:
        deleted: set[str] = set()
        for path in paths:
            target = self._path(path)
            if target.exists():
                target.unlink()
            deleted.add(path)
        return deleted

    def read(self, path: str) -> bytes:
        return self._path(path).read_bytes()
