import { afterEach, describe, expect, it, vi } from 'vitest';

import { completeTransaction, createReview, getTransactionReviews } from '@/lib/api/reviews';
import { ApiError } from '@/types/api';

const requestId = '00000000-0000-4000-8000-000000000001';
const reviewId = '00000000-0000-4000-8000-000000000011';
const review = {
  id: reviewId,
  reviewerRole: 'buyer',
  rating: 5,
  body: '빠르고 친절한 거래였어요.',
  createdAt: '2026-10-12T10:00:00.000000Z',
};
const transactionReviews = {
  requestId,
  requestStatus: 'completed',
  completedAt: '2026-10-12T10:00:00.000000Z',
  items: [{ reviewerRole: 'buyer', rating: 5, body: review.body, createdAt: review.createdAt }],
  viewerRole: null,
  canWrite: false,
  mine: null,
  received: null,
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

describe('reviews API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('완료 POST uses same-origin protections and parses response', async () => {
    const result = {
      request: { id: requestId, status: 'completed', completedAt: transactionReviews.completedAt },
      acceptedApplicationId: 'application-1',
      chatRoomId: 'room-1',
    };
    const fetchMock = stubFetch(async () => jsonResponse(200, result));

    await expect(completeTransaction(requestId)).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/requests/${requestId}/complete`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gamja-market' },
    });
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('공개 GET forwards optional cookie/baseUrl and accepts null viewer fields', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, transactionReviews));
    await expect(
      getTransactionReviews(requestId, { baseUrl: 'http://backend:8104', cookie: 'gamja_session=token' }),
    ).resolves.toEqual(transactionReviews);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://backend:8104/api/requests/${requestId}/reviews`);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', headers: { Cookie: 'gamja_session=token' } });
  });

  it.each([
    { ...transactionReviews, items: [{ ...transactionReviews.items[0], id: reviewId }] },
    { ...transactionReviews, items: [transactionReviews.items[0], transactionReviews.items[0], transactionReviews.items[0]] },
    { ...transactionReviews, items: [{ ...transactionReviews.items[0], rating: 6 }] },
    { ...transactionReviews, items: [{ reviewerRole: 'admin', rating: 5, body: 'x', createdAt: review.createdAt }] },
    { ...transactionReviews, items: [{ reviewerRole: 'buyer', rating: 5, body: 'x' }] },
    { ...transactionReviews, viewerRole: 'outsider' },
    { ...transactionReviews, canWrite: 'yes' },
    { ...transactionReviews, mine: { ...review, reviewerId: 'user-secret' } },
  ])('rejects malformed public/participant response instead of weakening the public view', async (body) => {
    stubFetch(async () => jsonResponse(200, body));
    await expect(getTransactionReviews(requestId)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('POST sends only rating and body and returns created true for 201', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, { review }));
    await expect(createReview(requestId, { rating: 5, body: review.body })).resolves.toEqual({ review, created: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/requests/${requestId}/reviews`);
    expect(init).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gamja-market' },
    });
    expect(JSON.parse(String(init.body))).toEqual({ rating: 5, body: review.body });
  });

  it('POST retry returns created false for 200 and preserves structured API errors', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { review }));
    await expect(createReview(requestId, { rating: 5, body: review.body })).resolves.toEqual({ review, created: false });
    fetchMock.mockImplementationOnce(async () => jsonResponse(409, { error: { code: 'ALREADY_REVIEWED', message: '이미 작성했어요.', fields: {} } }));
    const error = await createReview(requestId, { rating: 4, body: '다른 후기' }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ALREADY_REVIEWED');
  });
});
