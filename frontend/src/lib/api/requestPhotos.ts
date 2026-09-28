import { internalError, isRecord, request, toApiError } from '@/lib/api/http';
import type { UploadedRequestPhoto } from '@/types/request';

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다(설계서 3.4, 7.1).
 */
const REQUEST_PHOTOS_BASE = '/api/request-photos';

const REQUESTED_WITH = 'gamja-market';

function parseUploaded(value: unknown): UploadedRequestPhoto | null {
  if (!isRecord(value)) return null;

  const { id, contentType, byteSize, width, height, expiresAt } = value;
  if (
    typeof id !== 'string' ||
    typeof contentType !== 'string' ||
    typeof byteSize !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    typeof expiresAt !== 'string'
  ) {
    return null;
  }

  return { id, contentType, byteSize, width, height, expiresAt };
}

/**
 * 파일 바이트 자체를 본문으로 보낸다(multipart 아님, 설계서 3.1/7.1).
 * 원본 파일명은 어디에도 전달하지 않는다.
 */
export async function uploadRequestPhoto(
  file: File,
  signal?: AbortSignal,
): Promise<UploadedRequestPhoto> {
  const response = await request(
    '',
    {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': file.type,
        'X-Requested-With': REQUESTED_WITH,
      },
      signal,
    },
    REQUEST_PHOTOS_BASE,
  );

  if (!response.ok) throw await toApiError(response, []);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const uploaded = parseUploaded(body);
  if (!uploaded) throw internalError(response.status);
  return uploaded;
}

/**
 * 등록 전 업로드된 사진을 폐기한다. 실패해도 호출 측(PhotoPicker)은 무시할 수 있도록
 * 예외를 그대로 던진다(설계서 7.1).
 */
export async function deleteRequestPhoto(id: string): Promise<void> {
  const response = await request(
    `/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { 'X-Requested-With': REQUESTED_WITH },
    },
    REQUEST_PHOTOS_BASE,
  );

  if (!response.ok) throw await toApiError(response, []);
}
