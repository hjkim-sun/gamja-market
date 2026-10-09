# Gamja Market backend

Copy the repository root `.env.example` to `.env` and set `POSTGRES_PASSWORD` to the current password used by the existing local volume. Keep the compose project name and `postgres_data` volume unchanged; the published port is loopback-only. The backend application starts without running migrations. Migration work is separate from service startup; verify `MIGRATION_DATABASE_URL` points to the local loopback database before applying migrations.

The example enables Git-ignored local photo storage at `backend/.local-storage`, so JPEG, PNG, and WebP uploads work in development. For production, set `PHOTO_STORAGE_DRIVER=supabase` together with the three server-only `SUPABASE_*` variables; never commit those credentials.

```sh
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Run the backend test suite with the same environment configuration used by the application. The test fixture forces Alembic to the local runtime database and refuses non-loopback hosts; it does not delete test data:

```sh
uv run pytest
```

For local development, run `uv run alembic upgrade head` only after verifying the resolved migration URL is the existing local loopback database. Never run migrations against a remote `MIGRATION_DATABASE_URL` as part of local verification. Tests use fixture-managed explicit revision targets and preserve existing test data.

The browser should reach this service through the frontend's same-origin `/api/auth/*` rewrite.  A direct smoke test must send the accepted origin and request header:

```sh
curl -i -c cookies.txt -X POST http://127.0.0.1:8000/api/auth/signup \
  -H 'Origin: http://localhost:3000' -H 'X-Requested-With: gamja-market' \
  -H 'Content-Type: application/json' \
  --data '{"email":"buyer@example.com","password":"potato-pass-123","password_confirmation":"potato-pass-123"}'
curl -i -b cookies.txt http://127.0.0.1:8000/api/auth/me
curl -i -b cookies.txt -X POST http://127.0.0.1:8000/api/auth/logout \
  -H 'Origin: http://localhost:3000' -H 'X-Requested-With: gamja-market' \
  -H 'Content-Type: application/json' --data '{}'
```
