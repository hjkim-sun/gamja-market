# 03. 로컬 서비스 쉘

## 목적과 범위

`scripts/start.sh`, `scripts/restart.sh`, `scripts/stop.sh`는 **현재 Git worktree**의 Next.js 개발 서버와 FastAPI 개발 서버를 함께 제어한다. 기본 주소는 각각 `http://127.0.0.1:3000`, `http://127.0.0.1:8000`이다. Python 표준 라이브러리 기반 `scripts/service.py`가 PID 확인, 포트 충돌 판별, 자식 프로세스 종료, HTTP readiness, 로그를 담당한다. DB 컨테이너나 migration은 이 서비스 제어의 범위 밖이며 앱에 필요한 DB는 별도로 준비한다.

## 전제조건과 사용법

- macOS 또는 `ps`, `lsof`, `git`과 Python 3가 설치된 호환 환경; `uv`, `npm` 설치.
- `cd frontend && npm ci`, `cd backend && uv sync` 완료.
- `backend/.env.example`을 `backend/.env`로 복사하여 실제 DB 연결 정보와 `AUTH_ALLOWED_ORIGINS`를 설정. 기본 frontend origin은 `http://localhost:3000`이다. `backend/.env`가 없으면 start는 변경 없이 실패한다.
- 서비스 기동 시 Alembic migration은 실행하지 않는다. 현재 `MIGRATION_DATABASE_URL`이 Supabase를 가리키므로, DB가 필요한 인증 요청을 시험할 때는 `DATABASE_URL`의 대상 DB를 별도로 준비한다.

저장소 루트에서:

```sh
./scripts/start.sh
./scripts/restart.sh
./scripts/stop.sh
./scripts/start.sh --frontend-port 3100 --backend-port 8100 --timeout 90
./scripts/start.sh --help
```

`restart.sh`는 상태 파일에 기록된 현재 worktree 서비스를 중지한 뒤 다시 시작한다. `stop.sh`는 그 상태 파일의 PID가 시작 시각, 명령, 작업 디렉터리까지 일치하는 경우에만 종료한다. stale PID는 제거하고 다른 프로세스는 건드리지 않는다. 사용자 지정 포트는 시작 및 재시작 시 지정한다.

## 충돌과 실패 처리

시작 전에 두 포트의 모든 TCP listener PID를 확인한다. PID와 그 조상에서 실제 실행 파일(`uv`, `node`/`npm`), **명령 시작 부분**(`uv run uvicorn app.main:app`, `npm run dev`/`next dev`)과 `frontend/` 또는 `backend/` 작업 디렉터리를 확인하고, `git worktree list`에 있는 **같은 저장소의 다른 worktree**로 확인한 서비스만 종료한다. Python `-c` 같은 임의 명령의 뒤쪽 인수에 서비스 이름을 넣어도 서비스로 인정하지 않는다. 한 포트라도 소속을 알 수 없거나 다른 프로젝트이면 어떤 점유 프로세스도 종료하지 않고 오류로 끝난다. 현재 worktree 서비스가 이미 살아 있으면 `restart.sh` 사용을 안내한다. 서비스 launcher와 그 작업 디렉터리의 자식 프로세스를 함께 종료하며, 종료 후 포트가 비지 않으면 추가 PID를 임의로 종료하지 않는다.

backend는 `/openapi.json`, frontend는 `/`의 HTTP 200과 listener를 기다린다. 이어 frontend의 `/api/auth/me`가 FastAPI의 `401 UNAUTHENTICATED`를 반환하는지 확인해 rewrite를 검증한다. `BACKEND_API_ORIGIN`은 실행 시 선택한 backend 포트로 명시해 `frontend/.env.local`의 다른 값보다 우선하며, `VERCEL`은 local 개발 실행에서 제거한다. 대기 시간 내 readiness가 실패하면 이 실행에서 기동한 양쪽 서비스를 정리한다.

PID와 시작 시각은 `scripts/.state/service.json`, 잠금은 `scripts/.state/lock`에 저장되고 Git에서 제외된다. 로그는 `frontend/logs/backend.log`, `frontend/logs/frontend.log`에 append되며 Git에서 제외된다. 포트가 점유되었는데 lsof가 PID나 작업 디렉터리를 확인할 수 없으면 안전하게 실패하므로 해당 포트는 운영자가 직접 조사해야 한다.

## 독립 검증 절차

검증 워커는 위 전제조건을 갖춘 다음 `bash -n scripts/{start,restart,stop}.sh`, `python3 -m py_compile scripts/service.py`, 각 스크립트의 `--help`를 실행한다. `start.sh` 후 두 HTTP 주소와 frontend `/api/auth/me`를 확인하고, `restart.sh` 후 PID가 새로 생성되는지, `stop.sh` 후 두 listener가 없어지는지 확인한다. 다른 프로젝트나 식별 불가능한 listener를 테스트할 때는 포트 점유 프로세스가 그대로 살아 있고 start가 실패하는지 확인한다. 실제 DB가 없으면 인증 요청의 DB 동작 검증은 하지 않는다.
