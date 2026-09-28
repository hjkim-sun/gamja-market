# 판매자 지원 UI 검증 기록

검증일: 2026-09-26. 설계: [06-seller-applications-chat-rooms.md](../specs/06-seller-applications-chat-rooms.md).

**최종 상태:** 아래 초기 worker 제한 중 정렬, 빈 제출 오류/ARIA, 제출 장애 후 재시도, 390px 반응형 화면은 coordinator가 실제 Orca CLI로 추가 검증했다. 상세 결과는 마지막 보충 절을 따른다.

## 환경과 안전 경계

- worktree: `/Users/hjkim/orca/workspaces/gamja-market/curriculum-04-seller-applications`
- Orca run/dispatch: `run_dc698b6875e0` / `ctx_0aa53e315fca`
- 시작 전 `lsof -nP -iTCP:{3104,8104} -sTCP:LISTEN`으로 두 포트가 비어 있음을 확인했다. 이후 아래의 인라인 환경만 사용해 이 worktree 소유 서비스만 시작했다.

  ```sh
  AUTH_ALLOWED_ORIGINS='["http://127.0.0.1:3104","http://localhost:3104"]' \
  BACKEND_API_ORIGIN='http://127.0.0.1:8104' \
  ./scripts/start.sh --frontend-port 3104 --backend-port 8104
  ```

- 준비 결과: frontend `3104`, backend `8104`, rewrite `/api/auth/me` → `401 UNAUTHENTICATED`.
- 생성한 데이터는 공유 로컬 PostgreSQL에 보존했다. DB/schema 변경, `DELETE`, `TRUNCATE`, `DROP`, reset, stamp, downgrade는 실행하지 않았다.
- 각 사용자마다 Orca isolated profile을 새로 만들었다: buyer, seller-a, seller-b, seller-c, visitor. 로그아웃/재로그인은 수행하지 않았다.
- 비밀번호·쿠키·세션 토큰·네트워크 request body는 이 문서와 스크린샷에 기록하지 않았다.

## 실제 UI 결과

검증 요청: `7ecf689e-acce-4b13-a861-8af9aca17a36` (`ui4-20260926 seller applications request`).

| 항목 | Orca page/profile | 관측 결과 | 상태 |
| --- | --- | --- | --- |
| U1 | 시작 스크립트 | 동일 출처 `/api/auth/me` rewrite가 backend `401 UNAUTHENTICATED`를 반환 | 통과 |
| U2 | buyer `4ede726e-2b79-4beb-898d-aae7f1e07136` | 가입 후 요청을 UI로 생성, 상세에 `지원한 판매자 0명` 및 owner 안내 표시 | 통과 |
| U3 | visitor `cca2c2a3-cb7d-48ec-8b6d-44f0a16133af` | 지원 폼 없이 `/login?next=/requests/{id}` 대상의 `로그인하고 지원하기` 링크 표시 | 통과 |
| U4/U5 | seller-a `6aa37a98-1088-4209-8442-fab145688e9c` | UI 지원 성공 방 `1e1402a8-b414-4c73-978b-50b738329cfc`; 방의 요청 링크를 클릭해 hard reload 없이 상세로 돌아오면 `지원 완료`/자기 방 링크와 실제 3명 count 표시 | 통과 |
| U6 | seller-a → seller-b 방 | seller-b 방 `6416eb00-0587-4861-87a2-e47280f982d1` 직접 URL이 404 화면으로 응답 | 통과 |
| U7 | buyer | 3개 지원(제시가, 메시지, 마스킹 이메일, 방 링크)을 표시. buyer가 seller-b 방과 seller-c 방 링크를 실제로 열어 참여자 메타데이터를 확인 | 통과 |
| U8 | buyer `orca eval` 동일 출처 fetch | 자기 요청 지원 POST의 상태 `403` | 통과 |
| U9 | seller-c `884e0a33-c90d-4345-8976-d4de9d2837ab` `Promise.all` | 같은 body의 POST 5개가 `[409,409,201,409,409]`: 정확히 1×201, 4×409. 새로고침 후 seller-c의 유일한 방 `2f1ca39a-2bcc-4532-985b-690fc379954c` 표시 | 통과 |
| 방 셸/범위 | seller-a, seller-b, buyer 방 스냅샷 | 제시가·지원 메시지·참여자·요청 링크만 보이며 `textbox`와 `보내기` 버튼이 없음. 다만 안내 문구는 설계의 `메시지 기능은 6단계에서 열립니다.` 대신 `메시지 기능을 준비하고 있어요.`로 관측됨 | 기능 통과, 문구 차이 |
| 접근성(확인 가능 범위) | 모든 UI 스냅샷 | 로그인/채팅방 링크와 지원 폼의 입력·제출 버튼은 접근 가능한 이름으로 노출. 빈 지원폼 제출 뒤의 오류 `aria-invalid`/`aria-describedby`는 브라우저 연결이 끊겨 안정적으로 재관측하지 못함 | 부분 통과/미검증 |

## 정렬·오류·모바일의 제한

U10(실제 `sort=applicants` 화면), U11(backend 중지 뒤 상세 오류/재시도), 그리고 모바일 viewport는 통과로 기록하지 않는다. Orca 내장 브라우저는 이 검증 중 `runtime_unavailable`로 연결을 세 차례 종료했다(각 시도 뒤 `orca status --json`은 runtime `ready`/`connected`를 보고했지만 다음 snapshot/wait가 다시 불안정했다). 로드한 Orca browser reference에는 viewport resize 또는 mobile emulation 명령도 없었으므로, 데스크톱 접근성 스냅샷이 모바일 검증을 대체하지 않는다.

초기 빈 지원 폼의 즉시 스냅샷은 오류 DOM이 렌더되기 전 상태였고, 그 뒤 `wait --text`를 수행하려던 시점에 runtime 연결이 종료되었다. 따라서 이를 제품 결함으로 단정하지 않았으며, 해당 접근성 오류 경로는 **미검증**으로 남긴다.

## 브라우저 증거

아래 PNG는 저장소 밖의 로컬 임시 경로에만 저장했으며, UI 상태만 포함하고 인증 비밀값은 포함하지 않는다.

- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/buyer-request-created.png`
- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/visitor-login-link.png`
- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/seller-b-room.png`
- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/seller-a-denied-seller-b-room.png`
- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/seller-a-existing-room-state.png`
- `/var/folders/4_/v3ld0_j56sxb2y_m6f7vzszh0000gn/T/gamja-item4-ui-20260926/buyer-three-applications.png`

## 콘솔과 후속

관측 가능한 console 출력에는 Next 개발 모드의 Fast Refresh 및 smooth-scroll 안내 warning만 있었고, 기능 JavaScript error는 보지 못했다. 이후 runtime disconnect 때문에 최종 console 재수집은 불가능했다. Coordinator가 별도로 완료한 회귀 결과(backend 116 passed, frontend 111 passed)는 이 실제 UI 검증의 미완료 항목을 대체하지 않는다.

## Coordinator 추가 검증 (14:08~14:12 UTC)

Worker 종료 후 3104/8104가 비어 있음을 확인하고 동일 설정으로 이 worktree 서버만 재시작했다. 다른 워커와 브라우저 조작을 동시에 수행하지 않았다. 추가 요청 `a83149c1-4288-4b3f-88b1-fb20cb4f5eed`는 기존 검증 구매자 프로필에서 동일 출처 POST로 생성했고 보존했다.

- **빈 제출/접근성 통과:** 새 요청에서 seller-a의 빈 폼을 확인했다. 화면 아래 버튼을 대상으로 한 `orca click`은 성공 응답에도 제출을 발생시키지 않았다. `orca scroll --direction down --amount 1100` 후 화면 안에 들어온 제출 버튼을 클릭하자 두 오류가 렌더됐다. 실제 DOM에서 두 필드 모두 `aria-invalid="true"`, `aria-describedby`의 유효한 오류 요소 연결을 확인했다. 초기 escalation은 제품 결함으로 재현되지 않았으며 코드 변경 없이 해소됐다.
- **U10 정렬 통과:** `/?q=ui4-20260926&sort=applicants`의 실제 snapshot에서 `지원자 많은순` 선택과 기존 지원 3명 요청 → 새 지원 0명 요청 순서를 확인했다. 공유 DB의 다른 테스트 데이터를 지우지 않고 검색 범위를 한정했다.
- **U11 제출 장애/재시도 통과:** 입력값 50000 / `Coordinator retry validation offer`를 채운 뒤 PID·시작 시각·cwd 소유권을 확인해 이 작업의 backend만 중지했다. 제출 시 `잠시 후 다시 시도해 주세요.` alert, 입력값 보존, 제출 버튼 재활성화를 확인했다. backend 복구 후 같은 버튼으로 재시도하여 방 `f95b5fba-381e-4089-ada8-486e6038bfd4`에 진입했고 정확한 제시가/메시지를 확인했다. 이 검사는 제출 오류 경로이며, backend 전체 중단 상태의 SSR 상세 페이지 오류/재시도 버튼 경로는 별도 검증하지 않았다.
- **390px 반응형/오류 연결 통과:** `orca exec --page <id> --command 'set viewport 390 844'`가 지원됨을 확인했다. 방과 seller-b의 지원 폼에서 `innerWidth=390`, `scrollWidth=375`로 가로 넘침이 없었다. 390px에서도 빈 제출 오류·label·ARIA 연결을 확인하고 스크린샷을 직접 열어 점검했다. 실제 휴대기기 터치/모바일 UA 에뮬레이션 검증은 아니다(`mobile:false`).
- 추가 console 점검에서 React 개발 도구/Fast Refresh 및 기존 smooth-scroll 안내만 관측했다. 의도적으로 backend를 중지한 동안의 네트워크 실패는 장애 시나리오에 해당한다.

추가 증거(저장소 밖, 인증 비밀값 없음):

- [빈 제출 오류](/tmp/gamja-item4-empty-errors.png)
- [지원자 수 정렬](/tmp/gamja-item4-sort.png)
- [backend 중지 시 오류/입력 보존](/tmp/gamja-item4-backend-down.png)
- [복구 후 재시도 채팅방](/tmp/gamja-item4-retry-room.png)
- [390px 채팅방](/tmp/gamja-item4-room-390.png)
- [390px 지원 폼 오류](/tmp/gamja-item4-form-390.png)
