from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class FakePhotoStorage:
    """Failure-injectable in-memory implementation of the documented driver API."""

    objects: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    calls: list[tuple[str, object]] = field(default_factory=list)
    fail_put: bool = False
    fail_delete: bool = False
    put_raises_then_late_write: bool = False
    put_delay: float = 0.0

    @property
    def namespace(self) -> tuple[str, None]:
        return ("memory", None)

    def put(self, path: str, data: bytes, content_type: str) -> None:
        self.calls.append(("put", path))
        if self.put_delay:
            time.sleep(self.put_delay)
        if self.put_raises_then_late_write:
            self.objects[path] = (data, content_type)
            raise RuntimeError("injected ambiguous storage failure")
        if self.fail_put:
            raise RuntimeError("injected storage failure")
        self.objects[path] = (data, content_type)

    def delete_many(self, paths: list[str]) -> set[str]:
        self.calls.append(("delete_many", tuple(paths)))
        if self.fail_delete:
            return set()
        for path in paths:
            self.objects.pop(path, None)
        return set(paths)
