# Gamja Market backend

Copy `.env.example` to `.env` and provide PostgreSQL credentials. The application starts without running migrations. Migration work is separate from service startup; check the target of `MIGRATION_DATABASE_URL` before running it, since it may point to Supabase.

```sh
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Run the backend test suite with the same environment configuration used by the application:

```sh
uv run pytest
```

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
