import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteRequestPhoto, uploadRequestPhoto } from '@/lib/api/requestPhotos';
import { ApiError } from '@/types/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('구매요청 사진 API 클라이언트', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('파일 자체를 raw body와 이미지 Content-Type으로 업로드한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, {
      id: '00000000-0000-4000-8000-000000000123',
      contentType: 'image/jpeg',
      byteSize: 4,
      width: 8,
      height: 6,
      expiresAt: '2026-09-27T03:10:00+00:00',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'private-name.jpg', {
      type: 'image/jpeg',
    });

    const result = await uploadRequestPhoto(file);

    expect(result.id).toBe('00000000-0000-4000-8000-000000000123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/request-photos');
    expect(init).toMatchObject({
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Requested-With': 'gamja-market',
      },
    });
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [409, 'PHOTO_LIMIT_EXCEEDED'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [422, 'INVALID_IMAGE'],
    [503, 'PHOTO_STORAGE_UNAVAILABLE'],
  ])('%i 오류를 %s 코드로 보존한다', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(status, {
      error: { code, message: 'server message', fields: {} },
    })));
    const caught = await uploadRequestPhoto(
      new File(['photo'], 'photo.png', { type: 'image/png' }),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe(code);
  });

  it('삭제는 본문 없이 보안 헤더가 있는 DELETE를 사용한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteRequestPhoto('00000000-0000-4000-8000-000000000123');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/request-photos/00000000-0000-4000-8000-000000000123',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'gamja-market' },
      }),
    );
  });
});
