# 04. 로그인·회원가입 배포 복구

## 재현과 원인

- 2026-09-15 기준 Production alias `https://gamja-market-pi.vercel.app`에서 `/login`과 `/signup` 화면은 열리지만, `/api/auth/me`가 FastAPI 계약의 401 JSON 대신 Vercel의 404 HTML을 반환한다. 헤더는 복원 오류를 표시하고 인증 링크를 숨긴다.
- Vercel 프로젝트 `gamja-market`의 Root Directory는 `frontend`, Framework Preset은 `Next.js`였다. 따라서 저장소 루트 `vercel.json`의 `services`와 `/api/*` 라우팅이 배포에 적용되지 않고 프론트엔드만 빌드됐다. `Ready`는 인증 백엔드가 준비됐다는 의미가 아니다.
- 백엔드 `Settings`가 앱 시작 시 마이그레이션 전용 `MIGRATION_DATABASE_URL`도 필수로 요구했다. 이는 인증 요청 실행과 Alembic 실행을 불필요하게 결합한다.
- 새 Services 배포에서 FastAPI가 `DATABASE_URL`의 기본 PostgreSQL 드라이버인 `psycopg2`를 찾으려다 시작에 실패했다. 백엔드 의존성은 `psycopg` 3이다.
- 2026-09-15 새 배포의 `/api/auth/me`는 정상적인 401 JSON으로 복구됐으나, 운영 회원가입은 503이다. 내부 로그는 `OperationalError`, `sqlstate=None`, `endpoint=supabase_direct`를 기록했다. 로그와 Supabase 연결 안내에 비춰 Vercel의 IPv4 네트워크에서 직접 연결(IPv6)을 사용하는 것이 가장 유력한 원인이다. 운영 런타임 URL을 IPv4 풀러 주소로 변경하고 가입 요청으로 확인해야 한다.

## 코드 동작

- `/me`의 404는 인증 API 경로가 없다는 배포 오류로 보존한다. 이 경우 헤더는 복원 오류 및 재시도와 함께 로그인·회원가입 화면 링크를 표시한다. 401만 비로그인으로 판단하고, 다른 실패는 기존처럼 불확실한 인증 상태로 유지한다.
- 앱 런타임은 `DATABASE_URL`을 사용한다. `MIGRATION_DATABASE_URL`이 없으면 Alembic도 같은 URL을 사용한다. 별도 DDL 연결이 필요하면 이를 명시적으로 설정한다. 비밀번호·세션 원문은 응답·로그·문서에 남기지 않는다.
- `postgres://` 및 `postgresql://` DB URL은 설정 로딩 시 `postgresql+psycopg://`로 정규화한다. 이미 명시된 드라이버나 다른 DB URL은 유지한다.
- DB 장애 로그는 작업명, 예외 종류, SQLSTATE 및 주소·실패 범주만 기록한다. 연결 문자열과 자격 증명은 기록하지 않는다.

## 배포 절차

1. Vercel 프로젝트 Root Directory를 저장소 루트로, Framework Preset을 `Services`로 설정한다. 루트 `vercel.json`이 FastAPI와 Next.js를 함께 빌드하고 `/api/*`를 backend 서비스로 전달하는지 배포 출력에서 확인한다.
2. 배포 환경마다 `DATABASE_URL`, 정확한 프론트 HTTPS 출처를 담은 `AUTH_ALLOWED_ORIGINS`, `SESSION_COOKIE_SECURE=true`를 설정한다. Vercel에서 Supabase를 사용할 때 런타임 URL은 대시보드 Connect의 **Session pooler** (IPv4, 포트 5432) 연결 문자열을 사용한다. Production과 Preview는 출처가 다르므로 각각 지정한다. 변수 변경 후 새 배포가 필요하다.
3. 배포 전에 대상 DB를 확인하고 DDL 가능한 연결로 `uv run alembic upgrade head`를 실행한다. `MIGRATION_DATABASE_URL`이 없으면 `DATABASE_URL`을 대상으로 하므로 대상과 권한을 먼저 확인한다. 운영 DB에 대한 migration은 런타임 서비스 시작과 분리한다.
4. 새 배포에서 `/api/auth/me`가 쿠키 없이 401 JSON 및 `Cache-Control: no-store`를 반환하는지 확인한다. 이어 화면에서 회원가입→새로고침→로그아웃→재로그인과 쿠키 복원을 검증한다. 공개 Production alias와 보호된 Preview는 접근 방식이 다르므로 검증 URL을 구분한다.

기존 공개 구매요청 목록·상세·등록 목업 기능은 변경하지 않는다.

[Supabase의 연결 모드 및 IPv4 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)를 참고한다.
