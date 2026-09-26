import { afterEach, describe, expect, it, vi } from 'vitest';

import * as requestsApi from '@/lib/api/requests';
import { ApiError } from '@/types/api';

const summary = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '아이패드 프로를 구합니다',
  category: '디지털기기',
  condition: 'like_new' as const,
  priceMin: 600_000,
  priceMax: 800_000,
  region: '서울 강남구',
  status: 'open' as const,
  thumbnailUrl: null,
  applicantCount: 0,
  createdAt: '2026-09-21T08:30:00+00:00',
  isOwner: false,
};

const detail = {
  ...summary,
  description: 'M2 모델이며 상태가 깨끗한 제품을 찾고 있습니다.',
  updatedAt: summary.createdAt,
  buyer: {
    id: '00000000-0000-4000-8000-000000000010',
    maskedEmail: 'bu***@example.com',
  },
  photos: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('구매요청 API 클라이언트', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('목록 쿼리스트링을 계약대로 조립하고 빈 값은 생략한다', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { items: [summary], total: 1, page: 2, pageSize: 5 }),
    );

    await requestsApi.listRequests({
      q: ' 아이패드 ',
      category: '디지털기기',
      status: 'open',
      sort: 'price',
      page: 2,
      pageSize: 5,
    });

    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(input, 'http://localhost');
    expect(url.pathname).toBe('/api/requests');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: '아이패드',
      category: '디지털기기',
      status: 'open',
      sort: 'price',
      page: '2',
      pageSize: '5',
    });
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });

    await requestsApi.listRequests({ q: '  ', category: '', status: '', sort: 'latest' });
    const [emptyInput] = fetchMock.mock.calls[1] as [string, RequestInit];
    const emptyUrl = new URL(emptyInput, 'http://localhost');
    expect(emptyUrl.searchParams.has('q')).toBe(false);
    expect(emptyUrl.searchParams.has('category')).toBe(false);
    expect(emptyUrl.searchParams.has('status')).toBe(false);
  });

  it('등록 POST에 보안 헤더, same-origin 자격증명, no-store를 사용한다', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, detail));
    const payload = {
      title: detail.title,
      category: detail.category,
      description: detail.description,
      priceMin: detail.priceMin,
      priceMax: detail.priceMax,
      condition: detail.condition,
      region: detail.region,
    };

    await requestsApi.createRequest(payload);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/requests');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'gamja-market',
      },
    });
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it('빈 photoIds는 레거시와 같은 JSON을 보내고 상세 photos 누락은 빈 배열로 보완한다', async () => {
    const responseWithoutPhotos = { ...detail } as Record<string, unknown>;
    delete responseWithoutPhotos.photos;
    const fetchMock = stubFetch(async () => jsonResponse(201, responseWithoutPhotos));
    const payload = {
      title: detail.title,
      category: detail.category,
      description: detail.description,
      priceMin: detail.priceMin,
      priceMax: detail.priceMax,
      condition: detail.condition,
      region: detail.region,
      photoIds: [],
    };

    const created = await requestsApi.createRequest(payload);

    expect(created.photos).toEqual([]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: detail.title,
      category: detail.category,
      description: detail.description,
      priceMin: detail.priceMin,
      priceMax: detail.priceMax,
      condition: detail.condition,
      region: detail.region,
    });
  });

  it('안전하지 않은 이미지 URL은 노출하지 않고 안전한 URL만 보존한다', async () => {
    const unsafe = {
      ...detail,
      thumbnailUrl: 'javascript:alert(1)',
      photos: [
        { id: 'safe-relative', url: '/api/request-photos/files/00000000-0000-4000-8000-000000000001.jpg' },
        { id: 'safe-https', url: 'https://cdn.example.com/safe.jpg' },
        { id: 'data', url: 'data:image/png;base64,evil' },
        { id: 'scheme-relative', url: '//evil.example/photo.jpg' },
      ],
    };
    stubFetch(async () => jsonResponse(200, unsafe));

    const parsed = await requestsApi.getRequest(detail.id);

    expect(parsed.thumbnailUrl).toBeNull();
    expect(parsed.photos).toEqual(unsafe.photos.slice(0, 2));
  });

  it('photos 배열 항목의 계약이 깨지면 INTERNAL_ERROR를 던진다', async () => {
    stubFetch(async () => jsonResponse(200, { ...detail, photos: [{ id: 123, url: false }] }));

    const caught = await requestsApi.getRequest(detail.id).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('INTERNAL_ERROR');
  });

  it('서버 컴포넌트는 명시한 backend base URL로 공개 GET을 보낸다', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 12 }),
    );

    await requestsApi.listRequests({}, { baseUrl: 'http://backend:8000', cookie: 'gamja_session=token' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://backend:8000/api/requests');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      headers: { Cookie: 'gamja_session=token' },
    });
  });

  it('0이 아닌 applicantCount를 실제 집계 값으로 파싱한다', async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        items: [{ ...summary, applicantCount: 7 }],
        total: 1,
        page: 1,
        pageSize: 12,
      }),
    );

    const result = await requestsApi.listRequests({});

    expect(result.items[0].applicantCount).toBe(7);
  });

  it('404 응답을 NOT_FOUND ApiError로 변환한다', async () => {
    stubFetch(async () =>
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: '요청을 찾을 수 없습니다.', fields: {} },
      }),
    );

    const caught = await requestsApi.getRequest('missing').catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('NOT_FOUND');
    expect((caught as ApiError).status).toBe(404);
  });

  it('422 fields를 VALIDATION_ERROR에 보존한다', async () => {
    stubFetch(async () =>
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fields: { priceMax: '최대가는 최소가보다 크거나 같아야 합니다.' },
        },
      }),
    );

    const caught = await requestsApi
      .createRequest({
        title: detail.title,
        category: detail.category,
        description: detail.description,
        priceMin: 900_000,
        priceMax: 800_000,
        condition: detail.condition,
        region: detail.region,
      })
      .catch((error: unknown) => error);

    expect((caught as ApiError).code).toBe('VALIDATION_ERROR');
    expect((caught as ApiError).fields.priceMax).toBe(
      '최대가는 최소가보다 크거나 같아야 합니다.',
    );
  });

  it('fetch reject를 status 0 NETWORK_ERROR로 변환한다', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    const caught = await requestsApi.listRequests({}).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('NETWORK_ERROR');
    expect((caught as ApiError).status).toBe(0);
  });

  it.each([
    { ...summary, applicantCount: '0' },
    { ...detail, buyer: { id: detail.buyer.id } },
    { items: [summary], total: 1, page: 1 },
  ])('형태가 잘못된 성공 응답은 목업 대신 INTERNAL_ERROR를 던진다', async (invalid) => {
    stubFetch(async () => jsonResponse(200, invalid));

    const action = 'items' in invalid
      ? requestsApi.listRequests({})
      : requestsApi.getRequest(detail.id);
    const caught = await action.catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('INTERNAL_ERROR');
  });

  it('수정·삭제 API를 export하지 않는다', () => {
    expect('updateRequest' in requestsApi).toBe(false);
    expect('deleteRequest' in requestsApi).toBe(false);
  });

  it.each([
    '//example.com/image.jpg',
    'https://example.com/\\image.jpg',
    'https://example.com/\nimage.jpg',
    '/api/request-photos/files/../../auth/me',
    '/api/request-photos/files/%2e%2e/auth/me',
    'javascript:alert(1)',
  ])('안전하지 않은 사진 URL을 거부한다: %s', (url) => {
    expect(requestsApi.isSafeImageUrl(url)).toBe(false);
  });
});
