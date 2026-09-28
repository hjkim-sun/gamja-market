# 08. 구매요청 사진 버킷 비공개 전환

> 07 설계의 사진 업로드·연결 구현을 확장한다. 사람 검토 단계의 승인 근거는 사용자 요청(2026-09-28)의 설계부터 구현까지 전체 변경 승인이다. 검토 결정: 비로그인 목록·상세 정책과 attached 공개 범위를 유지하고, 버킷을 private로 전환한다.

## 결정

- `SUPABASE_STORAGE_BUCKET`은 **private** 버킷이다. 업로드·삭제는 기존 FastAPI 서버 전용 secret key를 사용한다. 브라우저에 키나 Supabase 객체 URL을 보내지 않는다.
- 목록 `thumbnailUrl`과 상세 `photos[].url`은 모두 `/api/request-photos/files/{photoId}.{ext}` 상대 URL이다. 기존 응답 필드·정렬·사진 없는 요청의 `null`/`[]`는 유지한다. 목록·상세 데이터 API는 Storage를 호출하지 않는다.
- 사진 GET은 인증 없는 공개 라우트다. 현재 목록·상세가 공개이므로 attached 사진만 누구나 볼 수 있다. DB에서 현재 드라이버의 `(storage_backend, storage_bucket)`, `status=attached`, 확장자를 확인한 뒤 저장된 `storage_path`로 읽는다. 요청 URL을 Storage 경로로 해석하지 않는다. pending·discarded·다른 이름공간·잘못된 확장자는 404다.
- `local`은 기존 파일 제공을 유지한다. `supabase`는 서버에서 인증된 `GET /storage/v1/object/authenticated/{bucket}/{path}`를 실행한다([Supabase private 다운로드 문서](https://supabase.com/docs/guides/storage/serving/downloads)). Storage 404는 404, 전송 오류·그 외 상태는 안전한 503으로 응답한다. 성공 사진은 기존 `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=3600`을 유지한다. 오류는 `no-store`다. 사진은 연결 후 수정되지 않으므로 1시간 캐시는 적합하다.
- signed URL은 만료 시 이미 열린 목록·상세의 이미지가 깨지고, 토큰이 브라우저와 공유 링크에 남는다. 프록시는 요청마다 DB 상태를 확인하고 안정된 URL을 제공한다. 사진당 최대 3MiB의 백엔드 전송 비용은 이 UX·접근 제어의 대가로 수용한다.
- 프런트는 새 상대 URL을 허용하고, 더 이상 임의의 절대 HTTP(S) 이미지 URL을 허용하지 않는다. 표시 컴포넌트의 계약은 그대로다.

## 검증 및 운영

- RED: private namespace의 업로드→연결→공개 목록·상세→사진 GET, 미연결/다른 namespace/확장자 404, Supabase MockTransport의 인증 GET·404·5xx, 프런트 URL 허용 목록.
- 로컬 기존 DB를 그대로 사용하고 데이터는 삭제하지 않는다. 실제 Supabase 설정이 없으면 HTTP 모의 테스트만 완료로 표시한다.
- Supabase 대시보드에서 버킷을 **Public OFF**로 생성 또는 기존 버킷을 private로 전환한다. 허용 MIME은 JPEG/PNG/WebP, 파일 상한은 3,145,728바이트다. 익명 `storage.objects` 읽기 정책을 추가하지 않는다. `PHOTO_STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`은 백엔드 환경에만 둔다. 기존 공개 버킷 전환 시 공개 CDN 캐시가 만료되기 전의 노출은 별도 운영 확인이 필요하다.
- 배포 후 비로그인 목록·상세의 사진 표시, pending 사진 404, 직접 `/storage/v1/object/public/...` 접근 거절, 삭제·정리, 서버 로그/번들의 키 비노출을 확인한다.
