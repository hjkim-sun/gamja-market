from __future__ import annotations

import argparse
from datetime import datetime, timezone

from app.api.deps import make_photo_storage
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.request_photos import PhotoUnavailable, sweep_request_photos


def main() -> int:
    parser = argparse.ArgumentParser(description="Sweep expired purchase-request photos (dry-run by default).")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 1000:
        parser.error("--limit must be between 1 and 1000")
    storage = make_photo_storage(get_settings())
    if storage is None:
        print("photo storage is disabled; refusing sweep")
        return 2
    db = SessionLocal()
    try:
        result = sweep_request_photos(db, storage, storage.namespace, now=datetime.now(timezone.utc), limit=args.limit, dry_run=not args.apply)
    finally:
        db.close()
    print(f"dry_run={not args.apply} candidates={result['candidates']} deleted={result['deleted']} skipped={result['skipped']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
