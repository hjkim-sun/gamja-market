# 판매자 지원 검증 기록

설계: [06-seller-applications-chat-rooms.md](../specs/06-seller-applications-chat-rooms.md). 사용자 설계 승인: 2026-09-26, “진행해”.

## 실행 범위

- worktree: `curriculum-04-seller-applications`, branch `hjkim-sun/curriculum-04-seller-applications`
- 로컬 frontend 3104 / backend 8104. 사진 작업의 3105 / 8105와 분리한다.
- 공유 로컬 PostgreSQL과 기존 데이터를 보존한다. 검증 DB 생성, 데이터 정리 DELETE/TRUNCATE, 실제 downgrade/drop/reset/stamp는 실행하지 않는다.
- 테스트의 migration 연결은 runtime 로컬 DB로 강제한다. 복사된 환경 파일의 별도 원격 migration URL은 사용하지 않는다.
- 기존 로그아웃·만료 세션 삭제 검증은 모의 세션/저장소로 수행한다. 실제 DB에서 세션 삭제를 검증한 것으로 해석하면 안 된다.
- 사진 업로드, 채팅 메시지 송수신, 매칭 확정은 범위 밖이다.

## Orca 실행 이력

Run: `run_dc698b6875e0`. 워커 터미널은 종료 후에도 보존한다.

| 역할 | 모델 / effort | Dispatch | 결과 |
| --- | --- | --- | --- |
| designer | Claude opus / high | `ctx_80cd80c59e60`, 보완 `ctx_8863617004aa` | 설계 작성 및 검토 보완 완료 |
| tester | Codex gpt-5.6-sol / high | `ctx_d9306f703428` | 데이터 보존 전환, 기존 GREEN, 새 기능 RED 완료 |
| tester 추가 검증 | 동일 터미널 / 동일 모델 | `ctx_d47af904bef9` | C8/R4 및 DB 제약/no-store RED 완료, retain/ack 완료 |
| backend | Codex gpt-5.6-terra / high | `ctx_011f99aefc5e`, 보완 `ctx_1c05fe8b3157` | 구현 및 커밋 전 DTO 검증 보완 완료, retained |
| front | Claude sonnet / high | `ctx_7fb0ed37ad97` | 구현/타입/lint/build 완료, retained |
| tester 경계 검증 | Codex gpt-5.6-sol / high | `ctx_8d57925cf549` | DTO 실패 원자성/이모지 회귀 GREEN, retained |
| ui tester | Codex gpt-5.6-terra / high | `ctx_0aa53e315fca` | 핵심 UI 증거 완료, retained; 일부 제한은 coordinator 추가 검증으로 해소 |

Backend 최초 시도 `ctx_fa44003524a3`는 작업 전달 전 agent readiness 시간 초과로 실패했다. 요청 모델이 정상 실행된 동일 터미널을 확인하고 재사용해 새 dispatch에서 작업 시작을 확인했다. 중복 구현 워커는 실행하지 않았다.

UI의 빈 폼 오류 표시 관측을 조사하기 위해 front 후속 `ctx_a718d5905dca`를 같은 터미널에 배정했으나 Claude 세션 사용 한도에 걸려 조사하지 못했다. 해당 dispatch는 `worker-abandon`으로 fence하고 터미널은 보존했다. Coordinator가 Orca CLI로 화면 밖 버튼 클릭 문제를 확인하고 스크롤 후 빈 제출 오류 및 ARIA 연결이 정상임을 검증했다. 제품 수정은 필요하지 않았다.

## RED 이전 기준선

Tester 보고 및 실행 결과 확인:

- 안전하게 전환한 기존 backend 회귀 및 migration guard: **67 passed**.
- 기존 frontend baseline: **75 passed**.
- 새 backend 표본 RED: **6 failed** — 미구현 route, schema, repository, 잠금 경로.
- 새 frontend RED: **7개 파일 실패** — 미구현 application API/컴포넌트, 이전 props, logout SSR refresh 누락.

실제 기능 구현 후 전체 테스트와 UI 검증 결과를 아래에 추가한다. 위 RED 실패를 기능 완료 또는 최종 통과로 해석하지 않는다.

추가 RED: backend 48개 수집/fixture 검증. C8은 3개 요청에 같은 판매자 6명이 지원하는 18개 독립 TestClient 동시 작업이다. R4는 판매자 8명 중 교대로 실제 PostgreSQL FK 오류를 주입하여 실패한 지원/방의 원자적 롤백과 재시도를 검증한다. 복합 FK 불일치, 가격 범위, 방 유일 제약, 성공/실패 no-store도 포함한다. 구현 전 집중 실행에서는 404 및 저장소 미구현으로 실패했다.

## 최종 검증

2026-09-26 coordinator 직접 실행:

- `cd backend && uv run pytest -q`: **116 passed**, 39.38초. 기존 의존성의 Starlette/httpx 및 AnyIO deprecation warning 2개.
- `cd frontend && npm test -- --run`: **20 files, 111 passed**, 7.43초.
- `git diff --check`: 통과.
- front worker: `tsc --noEmit`, `eslint --max-warnings=0`, `next build` 통과. UI 서버와 build는 동시에 실행하지 않았다.
- 응답 DTO 검증을 커밋 이전으로 옮겼다. 실제 방 INSERT 후 잘못된 created_at을 반환하는 테스트에서 HTTP 500, 지원/방 모두 미커밋, 재시도 201을 확인했다.
- 이모지 1개는 1자로 계산해 거부하고 2개는 허용한다. 브라우저와 Python/PostgreSQL의 코드포인트 기준을 맞췄다.

Orca UI 결과와 스크린샷은 [UI 검증 기록](06-seller-applications-ui.md)에 있다. 실제 가입/요청 생성, 판매자별 독립 방, 참여자 권한, 본인 지원 차단, 중복5회 중1회 성공, 되돌아간 화면의 최신 지원 수, 정렬, 빈 제출 오류/ARIA, backend 중단 시 입력 보존과 복구 후 재시도, 390px 화면을 확인했다.

제한: 실기기 터치/모바일 UA, backend 전체 중단 상태의 SSR 상세 오류/재시도 버튼 경로는 별도로 검증하지 않았다. 기존 로그아웃/세션 만료의 실제 DB 삭제 경로는 데이터 보존 지침에 따라 모의 검증이다. 스크린샷은 로컬 임시 파일이므로 영구 CI artifact가 아니다. 사진 worktree와의 최종 migration graph 병합은 이후 통합 시 수행해야 한다.

사진/메시지 송수신/매칭 기능은 추가하지 않았다. 검증 데이터는 보존하고 이 작업 소유 서버만 종료했다. 워커 터미널은 역할 이름으로 유지한다. merge와 deploy는 실행하지 않았다.
