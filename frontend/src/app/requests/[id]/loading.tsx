export default function RequestDetailLoading() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-9 sm:px-6 sm:py-12">
      <div className="h-[480px] animate-pulse rounded-2xl border border-stone-200 bg-white" aria-label="구매요청 상세 불러오는 중" role="status" />
    </div>
  );
}
