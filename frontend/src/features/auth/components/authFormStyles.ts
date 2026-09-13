/** 구매요청 폼과 동일한 입력·오류 스타일을 인증 폼에서도 재사용한다. */
export const authInputClassName =
  'mt-2 min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-base text-stone-900 outline-none placeholder:text-stone-400 focus:border-potato-400 focus:ring-2 focus:ring-potato-200 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-100';

export const authLabelClassName = 'text-sm font-bold text-stone-700';

/** 비밀번호 정책: Unicode 코드 포인트 기준 8~128자. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;

export const PASSWORD_MISMATCH_MESSAGE = '비밀번호가 일치하지 않습니다.';

/** 서버 정규화가 최종 권위이므로 프론트는 편의 수준의 검증만 한다. */
export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (!email) return '이메일을 입력해 주세요.';
  if (email.length > EMAIL_MAX_LENGTH) return `이메일은 ${EMAIL_MAX_LENGTH}자 이하로 입력해 주세요.`;
  if (/\s/.test(email)) return '이메일에 공백을 넣을 수 없습니다.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '이메일 형식을 확인해 주세요.';
  return undefined;
}

/** 길이는 서버와 같게 Unicode 코드 포인트로 센다. trim·정규화를 하지 않는다. */
export function validatePassword(value: string, label = '비밀번호'): string | undefined {
  if (!value) return `${label}를 입력해 주세요.`;
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    return `${label}는 ${PASSWORD_MIN_LENGTH}자 이상 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`;
  }
  return undefined;
}
