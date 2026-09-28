'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/Button';
import { applyToRequest } from '@/lib/api/applications';
import { formatPrice } from '@/lib/format';
import { ApiError } from '@/types/api';

const MIN_MESSAGE_LENGTH = 2;
const MAX_MESSAGE_LENGTH = 500;
const MAX_OFFER_PRICE = 1_000_000_000;

interface ApplyFormProps {
  requestId: string;
  priceMin: number;
  priceMax: number;
}

function isIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * 서버(Python len()/PostgreSQL char_length)는 유니코드 코드포인트 수로 길이를 센다.
 * JS 문자열의 `.length`는 UTF-16 code unit 수라서 서로게이트 쌍(이모지 등)을 2로 센다.
 * `Array.from`으로 코드포인트 단위로 분해해 서버와 같은 기준으로 맞춘다(설계서 6.1, D13).
 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function ApplyForm({ requestId, priceMin, priceMax }: ApplyFormProps) {
  const router = useRouter();
  const offerPriceId = useId();
  const offerPriceErrorId = useId();
  const messageId = useId();
  const messageErrorId = useId();

  const [offerPriceInput, setOfferPriceInput] = useState('');
  const [message, setMessage] = useState('');
  const [offerPriceError, setOfferPriceError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [showLoginLink, setShowLoginLink] = useState(false);

  const loginHref = `/login?next=/requests/${requestId}`;

  const trimmedMessage = message.trim();
  const parsedOfferPrice = isIntegerString(offerPriceInput) ? Number(offerPriceInput) : null;
  const outOfPriceRange =
    parsedOfferPrice !== null &&
    parsedOfferPrice >= 0 &&
    parsedOfferPrice <= MAX_OFFER_PRICE &&
    (parsedOfferPrice < priceMin || parsedOfferPrice > priceMax);

  function validate(): { offerPrice: number; message: string } | null {
    let hasError = false;

    if (parsedOfferPrice === null || parsedOfferPrice < 0 || parsedOfferPrice > MAX_OFFER_PRICE) {
      setOfferPriceError('제시가는 0원 이상 10억원 이하의 정수로 입력해 주세요.');
      hasError = true;
    } else {
      setOfferPriceError(null);
    }

    const trimmedLength = codePointLength(trimmedMessage);
    if (trimmedLength < MIN_MESSAGE_LENGTH || trimmedLength > MAX_MESSAGE_LENGTH) {
      setMessageError('지원 메시지는 2자 이상 500자 이하로 입력해 주세요.');
      hasError = true;
    } else {
      setMessageError(null);
    }

    if (hasError || parsedOfferPrice === null) return null;
    return { offerPrice: parsedOfferPrice, message: trimmedMessage };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const payload = validate();
    if (!payload) return;

    setSubmitting(true);
    setAlertMessage(null);
    setShowLoginLink(false);

    try {
      const result = await applyToRequest(requestId, payload);
      router.push(`/chats/${result.chatRoom.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setAlertMessage(caught.message);
        if (caught.code === 'ALREADY_APPLIED' || caught.code === 'REQUEST_NOT_OPEN') {
          router.refresh();
        }
        if (caught.code === 'UNAUTHENTICATED') {
          setShowLoginLink(true);
        }
        if (caught.code === 'VALIDATION_ERROR') {
          if (caught.fields.offerPrice) setOfferPriceError(caught.fields.offerPrice);
          if (caught.fields.message) setMessageError(caught.fields.message);
        }
      } else {
        setAlertMessage('잠시 후 다시 시도해 주세요.');
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={offerPriceId} className="block text-sm font-bold text-stone-700">
            제시가
          </label>
          <input
            id={offerPriceId}
            name="offerPrice"
            type="number"
            inputMode="numeric"
            value={offerPriceInput}
            onChange={(event) => setOfferPriceInput(event.target.value)}
            aria-invalid={offerPriceError ? 'true' : undefined}
            aria-describedby={offerPriceError ? offerPriceErrorId : undefined}
            className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-2.5 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          />
          {offerPriceError ? (
            <p id={offerPriceErrorId} className="mt-1 text-sm font-semibold text-red-600">
              {offerPriceError}
            </p>
          ) : null}
          {outOfPriceRange ? (
            <p className="mt-1 text-sm text-stone-500">
              {`희망가 범위 밖(${formatPrice(priceMin)} ~ ${formatPrice(priceMax)})의 제시가예요. 제출은 가능해요.`}
            </p>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={messageId} className="block text-sm font-bold text-stone-700">
            지원 메시지
          </label>
          <textarea
            id={messageId}
            name="message"
            rows={4}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={messageError ? 'true' : undefined}
            aria-describedby={messageError ? messageErrorId : undefined}
            className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-2.5 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500"
          />
          <div className="mt-1 flex items-center justify-between text-xs text-stone-400">
            <span>{codePointLength(message)}/{MAX_MESSAGE_LENGTH}</span>
          </div>
          {messageError ? (
            <p id={messageErrorId} className="mt-1 text-sm font-semibold text-red-600">
              {messageError}
            </p>
          ) : null}
        </div>
      </div>

      {alertMessage ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-red-600">
          {alertMessage}
        </p>
      ) : null}

      {showLoginLink ? (
        <Link href={loginHref} className="mt-2 inline-block text-sm font-bold text-leaf-700 underline">
          다시 로그인하기
        </Link>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Button type="submit" disabled={submitting} className="w-full sm:w-auto sm:min-w-48">
          {submitting ? '제출 중…' : '지원 제출'}
        </Button>
      </div>
    </form>
  );
}
