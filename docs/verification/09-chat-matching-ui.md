# 09. 채팅 매칭 UI 검증

검증일: 2026-10-07 (Asia/Seoul)
결과: 핵심 stage 6/7 흐름 통과. 모바일 브라우저도 Orca 뷰포트 에뮬레이션으로 확인했다.

## 환경

| 항목 | 값 |
| --- | --- |
| 브라우저 | Orca 내장 Chromium 브라우저, Orca CLI 1.4.222 |
| Frontend | `http://localhost:3000` |
| Backend | `http://127.0.0.1:8000` (Frontend API rewrite 사용) |
| DB | 기존 로컬 PostgreSQL `127.0.0.1:5432/gamja_market` |
| DB revision | 시작 전·검증 후 모두 `0005_chat_matching` (읽기 전용 조회) |
| Desktop viewport | 1206 × 969, device scale 1 |
| Mobile viewport | 390 × 844, `--mobile`, device scale 1 |
| 검증용 구매요청 | `eec1812d-ec88-4bff-9459-9ffefe224e8b` — “UI검증 폴링채팅 매칭 2026-10-07” |

로컬 서비스는 `python3 scripts/service.py start --frontend-port 3000 --backend-port 8000`으로 기동했다. 스크립트가 API rewrite 응답을 확인했다. 최초 `127.0.0.1:3000` 접속은 회원가입 origin 정책에 거부되어, 허용된 `localhost:3000`으로 다시 접속했다.

검증용 구매자 계정 1개와 판매자 계정 2개를 브라우저의 회원가입·지원 화면으로 만들고, 구매요청 1건·지원 2건·메시지 4건을 추가했다. 이 데이터는 로컬 DB에 남겨 두었다. DB 확인은 `default_transaction_read_only=on` 연결에서 `alembic_version` 및 검증용 요청의 상태·개수만 조회했다. DB나 스키마를 만들거나 초기화하지 않았고, 행 삭제·수정 쿼리를 실행하지 않았다.

## 검증 결과

| 흐름 | 실행 단계 및 관찰 결과 |
| --- | --- |
| Stage 6: 폴링 채팅 | 판매자 2가 채팅방에서 메시지를 보내 `201`을 받았다. 구매자가 다른 격리 브라우저 프로필에서 같은 방을 열어 둔 상태로 판매자 2가 새 메시지를 보내자, 구매자 화면이 다음 폴링에서 메시지를 표시했다. Backend 로그에서 `afterSeq=1` 조회 뒤 새 seq를 이어 받아 `afterSeq=2`로 진행하는 반복 GET을 확인했다. 메시지 순서는 화면에서 순서대로 표시됐다. |
| Buyer inbox | 구매자로 `/chats`에 들어가 두 지원 채팅방과 각각의 마지막 메시지를 확인했다. |
| Seller inbox scoping | 판매자 1의 `/chats`에는 자신이 지원한 채팅 1건만 나타났다. 다른 판매자 2의 방은 목록에 포함되지 않았다. |
| Privacy | 판매자 1 세션에서 판매자 2의 채팅방 URL을 직접 열었다. 화면은 `404 NOT FOUND`를 표시했고, room 조회와 초기 메시지 조회가 모두 `404`였다. 상대 이메일은 마스킹되어 표시됐다. |
| Buyer confirmation | 구매자가 판매자 2 방에서 “이 판매자로 확정”을 선택하고 되돌릴 수 없다는 확인 패널에서 “확정”을 눌렀다. `POST /api/requests/{id}/match`는 `200`이었다. 화면은 선택된 채팅방에 매칭 완료 안내를 표시했고, 이후 구매자 메시지 전송도 `201`로 성공했다. |
| Closed room | 판매자 1의 방에는 요청 `매칭됨`, 채팅 `마감` 배지와 “다른 판매자와 매칭되어 마감된 채팅방” 안내가 표시됐다. 입력창과 보내기 버튼은 비활성화됐다. |
| Mobile layout | Orca 뷰포트를 390 × 844 및 mobile 모드로 바꿔 선택된 채팅방을 확인했다. 구매자·판매자 정보 카드가 세로로 쌓이고, 메시지와 문장이 화면 폭에 맞춰 줄바꿈됐다. `document.documentElement.scrollWidth`는 390으로 viewport와 같아 가로 넘침이 없었다. 세로 스크롤로 메시지와 작성 영역을 확인했다. |

검증 종료 시 DB 조회 결과는 revision `0005_chat_matching`, 요청 `matched`, 지원 `accepted` 1건·`closed` 1건, 메시지 4건이었다. 이 문서 작성 중 테스트 스위트는 실행하지 않았다.

## 스크린샷

이미지는 이 문서와 함께 `docs/verification/09-chat-matching-ui/`에 저장했다.

- [판매자 채팅과 메시지 전송](09-chat-matching-ui/01-seller-chat-polling.png)
- [구매자 받은 편지함 — 두 방 범위 확인](09-chat-matching-ui/02-buyer-inbox-scoped.png)
- [되돌릴 수 없음 확인 패널](09-chat-matching-ui/03-buyer-confirmation-panel.png)
- [확정된 채팅방](09-chat-matching-ui/04-buyer-confirmed-chat.png)
- [판매자 받은 편지함 — 마감 상태와 본인 방만 표시](09-chat-matching-ui/05-seller-inbox-closed-scope.png)
- [마감된 방의 읽기 전용 입력 UI](09-chat-matching-ui/06-closed-room-read-only.png)
- [모바일 390 × 844 채팅 상단](09-chat-matching-ui/07-mobile-confirmed-chat.png)
- [모바일 메시지와 작성 영역](09-chat-matching-ui/08-mobile-chat-composer.png)
- [구매자 메시지를 포함한 모바일 확정 채팅](09-chat-matching-ui/09-mobile-confirmed-conversation.png)

## 제한 사항

모바일 화면은 실제 iOS/Android 기기가 아닌 Orca Chromium의 mobile viewport 에뮬레이션으로 확인했다. 390 × 844 화면 폭에서 줄바꿈과 가로 넘침은 확인했지만, 실제 기기별 폰트·키보드·safe area 동작은 이 검증에 포함하지 않았다.
