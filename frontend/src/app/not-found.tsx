import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <div className="text-6xl" aria-hidden="true">🥔</div>
      <p className="mt-6 text-sm font-black text-potato-700">404 NOT FOUND</p>
      <h1 className="mt-2 text-3xl font-black text-stone-950">요청을 찾을 수 없어요</h1>
      <p className="mt-3 leading-7 text-stone-500">삭제되었거나 존재하지 않는 구매요청입니다.</p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-11 items-center justify-center rounded-xl bg-potato-400 px-5 py-2.5 text-sm font-bold text-stone-900 hover:bg-potato-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
      >
        구매요청 목록으로
      </Link>
    </div>
  );
}
