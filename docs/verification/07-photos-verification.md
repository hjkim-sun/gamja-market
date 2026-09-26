# 구매요청 사진 첨부 검증 기록

## 범위와 승인

- 작업 워크트리: `curriculum-05-request-photos`, 기준 `origin/master` (`bab6411`).
- 설계: `docs/specs/07-purchase-request-photos.md`. 2026-09-26 사용자 “진행해” 승인 후 구현 시작.
- 판매자 지원·채팅은 별도 작업이며 이 작업에 포함하지 않는다.
- frontend `3105`, backend `8105`. 공유 로컬 PostgreSQL 사용, 새 검증 DB/스키마 생성 및 데이터 정리 목적의 삭제·TRUNCATE·DROP·reset 금지.
- 실제 환경 파일은 변경하거나 출력하지 않는다. 서버 설정은 실행 프로세스에 주입한다.

## Orca 실행 기록

- Run: `run_621e57ccf665`.
- Designer: Claude Opus/high. 최초 `ctx_e8089717276f`, 검토 보완 `ctx_135a19a69f4b` 완료, 터미널 보존.
- Tester: Codex gpt-5.6-sol/high. 최초 `ctx_25ddf0a8daa6`은 readiness timeout으로 작업 미시작; 동일 터미널 재사용 `ctx_770754e3cbb7`에서 실제 작업 시작 확인.
- 초기 Orca 호출의 상속된 terminal identity가 원본 checkout을 가리키는 문제는 이 워크트리 안 전용 `photos-coordinator` 터미널에 Run을 바인딩하여 해결했다. 기존 다른 Run을 재바인딩하지 않았다.
- Backend: Codex gpt-5.6-terra/high, `ctx_436118360ce2` 시작 확인.
- Front: Claude Sonnet/high, `ctx_ae5321c4afcc` 시작 확인. backend/front dispatch ID 상호 공유 완료.
- 코드 검토 후 같은 역할 터미널을 재사용: Backend `ctx_ce0cb692bfd1`, Front `ctx_829e9a1ae1e7`. 변경된 dispatch ID도 상호 공유했다.
- Front 후속 작업 중 Claude 세션 한도가 실제 transcript에서 확인되었다. 해당 dispatch는 abandon 처리하고 터미널은 보존했다. 이미 완료된 Sonnet 구현을 책임자가 인계받아 남은 보완과 검증을 마무리했다.
- UI tester: Codex gpt-5.6-terra/high. 최초 `ctx_988b5eff2921` readiness timeout 후 같은 `ui tester` 터미널을 재사용한 `ctx_3b2c3f45d8ed`에서 실제 작업 수행을 transcript로 확인했다. 시작 영수증은 `turn_start_unobserved`였으므로 중복 실행하지 않았다. UI에 backend/front ID를 전달하고, 완료된 두 역할의 보존된 터미널 mailbox에도 세 역할의 ID를 공유했다.
- 소비형 orchestration 명령은 `photos-coordinator`에서 실행한다. Designer는 실제 파일 작업 경로를 사진 워크트리로 고정했다.

## 현재 확인 사항

- 구현 전 환경 파일에 Supabase 설정이 없음. 실제 Supabase 연동은 미검증.
- 필요한 설정 이름: `PHOTO_STORAGE_DRIVER`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`.
- 모의 UI 검증에는 `PHOTO_STORAGE_DRIVER=local`, `PHOTO_LOCAL_STORAGE_DIR` 사용. 실서비스 Storage 성공으로 간주하지 않는다.
- 구현 전 공유 DB 읽기 확인: `alembic_version=0002_create_purchase_requests`; 기존 테이블 존재 확인. 데이터 변경 없음.
- 기존 테스트의 파괴적 fixture를 발견해 수정 전 pytest 실행을 금지했다.
- 준비: `uv sync --frozen`, `npm ci --ignore-scripts` 실행. npm은 기존 잠금파일 기준 취약점 4건(중간 2, 높음 2)을 보고했으며, 이번 기능과 관계없는 강제 의존성 업그레이드는 수행하지 않았다.

## 검증 결과

- 구현 전 프런트 기준: `npm test -- --reporter=dot` 75/75 통과, `npm run lint` 통과.
- 테스트 기반 변경 후 기존 백엔드 회귀: 61/61 통과.
- [RED 테스트 인계](07-photos-red.md): 백엔드 16 failed/12 errors, 프런트 76 passed/10 failed/1 failed suite. 사진 기능 미구현을 확인했으며, 테스트 도구 결함은 front 구현 단계에서 보정한다.
- 구현 및 자동·UI 검증을 완료했다. 실제 Supabase와 모바일 화면은 아래 제한에 포함한다.
- 백엔드 보완 후 책임자 독립 재실행: `uv run python -m pytest -q` **103 passed**, 8.99초. Starlette/httpx 및 AnyIO의 기존 deprecation warning 2건. [백엔드 상세 기록](07-photos-backend.md).
- 프런트 보완 후 책임자 재실행: `npm test -- --run` **104 passed / 19 suites**, `npm run lint`, `npm run build`, `npx tsc --noEmit` 모두 통과. [프런트 상세 기록](07-photos-frontend.md).
- [실제 Orca UI 검증](07-photos-ui.md): 로컬 드라이버로 JPEG/PNG/WebP 업로드, 사진 첨부/무사진 등록, 목록 대표 사진, 상세 갤러리와 키보드 선택, 잘못된 형식·크기·손상 파일, 제거·초기화 확인. 스크린샷 6개를 보존했다.
- 책임자 추가 Orca 검증: 사진 POST에만 503 응답을 주입하여 전용 안내 확인 → 원래 fetch 복원 → 화면 안의 재시도 클릭으로 실제 업로드 복구 확인. 업로드 Promise 지연 중 등록 버튼 `disabled=true`와 대기 안내 확인 후 실제 요청으로 전달하고 원상복구했다.
- `git diff --check` 통과. 실제 환경 파일과 로컬 저장 파일은 변경 목록에 포함하지 않았다. 공유 DB 데이터와 역할/서버 터미널은 보존했으며 merge/push/deploy는 수행하지 않았다.

## 최종 제한과 확인 경로

- 실제 Supabase는 설정 미제공으로 미검증이다. 서버 전용 `PHOTO_STORAGE_DRIVER`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`이 필요하다. 버킷 설정과 배포 시 정리 작업 운영 절차는 설계 문서를 따른다.
- Supabase 어댑터는 MockTransport로 검증했고 브라우저 저장은 local 드라이버다. 503 및 pending 브라우저 시나리오는 응답/지연 주입으로 명확히 구분한다.
- 모바일 실제 뷰포트 검증은 이번 Orca CLI에서 수행하지 못했다. 데스크톱 검증을 모바일 검증으로 간주하지 않는다.
- 로컬 확인: `http://localhost:3105/requests/515e3c30-cf9a-447b-a538-c3787e30371f` (검증용 세 사진 요청). 서버는 frontend 3105/backend 8105로 유지했다.

## 코드 검토에서 보완한 항목

- React StrictMode의 effect 재실행, 여러 번 파일 선택과 재시도의 순차 업로드, 업로드 중 제출 차단, 요청 저장 중 사진 변경 방지.
- DB 커밋 성공 여부가 불확실한 경우 독립 세션에서 상태 확인, 폐기 확정 이전 Storage 삭제 금지, 삭제 실패 재시도.
- PNG 투명도 보존과 메타데이터 제거, 서버 오류 응답의 예외 처리, 사진 연결의 소유권·만료·상태·동시성 회귀 검증.

## 실행 참고

로컬 UI는 저장소 모의 드라이버로 실행한다. 실제 환경 파일을 수정하지 않고 각 프로세스에 설정을 전달한다.

```sh
# backend 디렉터리
PHOTO_STORAGE_DRIVER=local PHOTO_LOCAL_STORAGE_DIR="$PWD/.local-storage" AUTH_ALLOWED_ORIGINS='["http://localhost:3105"]' uv run uvicorn app.main:app --host 127.0.0.1 --port 8105

# frontend 디렉터리
BACKEND_API_ORIGIN=http://127.0.0.1:8105 npm run dev -- -p 3105
```

공유 DB에서는 테스트 지원 도구가 사진 migration의 additive upgrade만 적용하고 Alembic 버전 상태를 보존한다. 4번 기능과 브랜치를 통합할 때는 migration head를 별도로 조정해야 한다. 이 작업에서는 병합하거나 배포하지 않는다.
