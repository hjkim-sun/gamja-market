'use client';

import { FormEvent, useState } from 'react';

import { Button } from '@/components/ui/Button';
import type { ProductCondition } from '@/types/request';

type FieldName =
  | 'title'
  | 'category'
  | 'description'
  | 'priceMin'
  | 'priceMax'
  | 'condition'
  | 'region';

type FormErrors = Partial<Record<FieldName, string>>;

const categories = ['디지털기기', '가전', '가구/인테리어', '의류', '도서', '기타'];

const conditions: Array<{ value: ProductCondition; label: string; description: string }> = [
  { value: 'any', label: '상관없음', description: '어떤 상태든 제안받아요' },
  { value: 'new', label: '새상품', description: '미개봉 또는 미사용' },
  { value: 'like_new', label: '거의 새것', description: '사용감이 거의 없음' },
  { value: 'used', label: '중고', description: '사용감이 있어도 괜찮음' },
];

const inputClassName =
  'mt-2 min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-base text-stone-900 outline-none placeholder:text-stone-400 focus:border-potato-400 focus:ring-2 focus:ring-potato-200 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-100';

function ErrorMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-2 text-sm font-semibold text-red-600" role="alert">
      {message}
    </p>
  );
}

export function RequestForm() {
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(false);

    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const category = String(data.get('category') ?? '');
    const description = String(data.get('description') ?? '').trim();
    const priceMinRaw = String(data.get('priceMin') ?? '');
    const priceMaxRaw = String(data.get('priceMax') ?? '');
    const priceMin = Number(priceMinRaw);
    const priceMax = Number(priceMaxRaw);
    const condition = String(data.get('condition') ?? '');
    const region = String(data.get('region') ?? '').trim();
    const nextErrors: FormErrors = {};

    if (title.length < 2 || title.length > 60) {
      nextErrors.title = '제목은 2자 이상 60자 이하로 입력해 주세요.';
    }
    if (!category) nextErrors.category = '카테고리를 선택해 주세요.';
    if (description.length < 10 || description.length > 1000) {
      nextErrors.description = '원하는 스펙은 10자 이상 1000자 이하로 입력해 주세요.';
    }
    if (!priceMinRaw || !Number.isFinite(priceMin) || priceMin < 0) {
      nextErrors.priceMin = '최소가는 0원 이상으로 입력해 주세요.';
    }
    if (!priceMaxRaw || !Number.isFinite(priceMax) || priceMax < 0) {
      nextErrors.priceMax = '최대가는 0원 이상으로 입력해 주세요.';
    }
    if (!nextErrors.priceMin && !nextErrors.priceMax && priceMin > priceMax) {
      nextErrors.priceMax = '최대가는 최소가보다 크거나 같아야 합니다.';
    }
    if (!condition) nextErrors.condition = '희망 상태를 선택해 주세요.';
    if (!region) nextErrors.region = '거래 지역을 입력해 주세요.';

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      setSubmitted(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-8">
      {submitted ? (
        <div className="rounded-2xl border border-leaf-500/30 bg-leaf-50 p-4 text-sm font-semibold leading-6 text-leaf-700" role="status">
          입력 내용이 모두 확인됐어요. 아직 저장 기능이 없습니다(3단계 예정).
        </div>
      ) : null}

      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8" aria-labelledby="basic-info-heading">
        <h2 id="basic-info-heading" className="text-xl font-black text-stone-900">무엇을 찾고 있나요?</h2>
        <p className="mt-1 text-sm text-stone-500">판매자가 물건을 바로 알아볼 수 있게 구체적으로 적어주세요.</p>

        <div className="mt-7 space-y-6">
          <div>
            <label htmlFor="title" className="text-sm font-bold text-stone-700">제목 <span className="text-red-500" aria-hidden="true">*</span></label>
            <input
              id="title"
              name="title"
              type="text"
              minLength={2}
              maxLength={60}
              placeholder="예: 아이패드 프로 11인치 M2 구합니다"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? 'title-error' : undefined}
              className={inputClassName}
            />
            <ErrorMessage id="title-error" message={errors.title} />
          </div>

          <div>
            <label htmlFor="category" className="text-sm font-bold text-stone-700">카테고리 <span className="text-red-500" aria-hidden="true">*</span></label>
            <select
              id="category"
              name="category"
              defaultValue=""
              aria-invalid={Boolean(errors.category)}
              aria-describedby={errors.category ? 'category-error' : undefined}
              className={inputClassName}
            >
              <option value="" disabled>카테고리를 선택하세요</option>
              {categories.map((category) => <option key={category}>{category}</option>)}
            </select>
            <ErrorMessage id="category-error" message={errors.category} />
          </div>

          <div>
            <label htmlFor="description" className="text-sm font-bold text-stone-700">원하는 스펙 <span className="text-red-500" aria-hidden="true">*</span></label>
            <textarea
              id="description"
              name="description"
              rows={7}
              minLength={10}
              maxLength={1000}
              placeholder="모델, 색상, 용량, 꼭 필요한 구성품 등 원하는 조건을 알려주세요."
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'description-error' : 'description-help'}
              className={`${inputClassName} resize-y py-3 leading-7`}
            />
            <p id="description-help" className="mt-2 text-xs text-stone-400">10~1000자</p>
            <ErrorMessage id="description-error" message={errors.description} />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8" aria-labelledby="conditions-heading">
        <h2 id="conditions-heading" className="text-xl font-black text-stone-900">거래 조건을 알려주세요</h2>
        <div className="mt-7 space-y-7">
          <fieldset>
            <legend className="text-sm font-bold text-stone-700">희망 가격대 <span className="text-red-500" aria-hidden="true">*</span></legend>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
              <div>
                <label htmlFor="priceMin" className="sr-only">희망 최소가</label>
                <div className="relative">
                  <input
                    id="priceMin"
                    name="priceMin"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="최소가"
                    aria-invalid={Boolean(errors.priceMin)}
                    aria-describedby={errors.priceMin ? 'price-min-error' : undefined}
                    className={`${inputClassName} mt-0 pr-9`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-stone-400">원</span>
                </div>
              </div>
              <span className="text-stone-400" aria-hidden="true">~</span>
              <div>
                <label htmlFor="priceMax" className="sr-only">희망 최대가</label>
                <div className="relative">
                  <input
                    id="priceMax"
                    name="priceMax"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="최대가"
                    aria-invalid={Boolean(errors.priceMax)}
                    aria-describedby={errors.priceMax ? 'price-max-error' : undefined}
                    className={`${inputClassName} mt-0 pr-9`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-stone-400">원</span>
                </div>
              </div>
            </div>
            <ErrorMessage id="price-min-error" message={errors.priceMin} />
            <ErrorMessage id="price-max-error" message={errors.priceMax} />
          </fieldset>

          <fieldset aria-describedby={errors.condition ? 'condition-error' : undefined}>
            <legend className="text-sm font-bold text-stone-700">희망 상태 <span className="text-red-500" aria-hidden="true">*</span></legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {conditions.map((condition) => (
                <label key={condition.value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-4 transition hover:border-potato-300 has-[:checked]:border-potato-400 has-[:checked]:bg-potato-50">
                  <input type="radio" name="condition" value={condition.value} className="mt-1 size-4 accent-potato-500" />
                  <span>
                    <span className="block text-sm font-bold text-stone-800">{condition.label}</span>
                    <span className="mt-0.5 block text-xs text-stone-500">{condition.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <ErrorMessage id="condition-error" message={errors.condition} />
          </fieldset>

          <div>
            <label htmlFor="region" className="text-sm font-bold text-stone-700">거래 지역 <span className="text-red-500" aria-hidden="true">*</span></label>
            <input
              id="region"
              name="region"
              type="text"
              placeholder="예: 서울 강남구"
              aria-invalid={Boolean(errors.region)}
              aria-describedby={errors.region ? 'region-error' : undefined}
              className={inputClassName}
            />
            <ErrorMessage id="region-error" message={errors.region} />
          </div>

          <div>
            <span className="text-sm font-bold text-stone-700">사진</span>
            <button
              type="button"
              disabled
              title="사진 업로드는 5단계에서 지원합니다"
              className="mt-2 flex min-h-28 w-full cursor-not-allowed flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-50 px-4 text-center text-sm text-stone-400"
            >
              <span className="text-2xl" aria-hidden="true">📷</span>
              <span className="mt-2 font-semibold">사진 업로드 · 5단계에서 지원</span>
            </button>
          </div>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="reset" variant="secondary" className="sm:min-w-28" onClick={() => { setErrors({}); setSubmitted(false); }}>
          초기화
        </Button>
        <Button type="submit" className="sm:min-w-48">입력 내용 확인</Button>
      </div>
    </form>
  );
}
