import type { NextConfig } from 'next';

/**
 * 로컬에서 Next.js만 실행할 때는 BACKEND_API_ORIGIN을 지정해 FastAPI로 프록시한다.
 * Vercel에서는 루트 vercel.json이 /api/* 요청을 backend 서비스로 직접 전달한다.
 */
function resolveBackendApiOrigin(): string | undefined {
  if (process.env.VERCEL === '1') return undefined;

  const origin = process.env.BACKEND_API_ORIGIN?.trim();

  if (!origin) return undefined;

  if (origin.endsWith('/')) {
    throw new Error('BACKEND_API_ORIGIN 끝에 / 를 붙이지 마세요. 예: http://127.0.0.1:8000');
  }

  return origin;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const backendApiOrigin = resolveBackendApiOrigin();

    if (!backendApiOrigin) return [];

    return [
      {
        source: '/api/:path*',
        destination: `${backendApiOrigin}/api/:path*`,
      },
    ];
  },
  /** 다른 사이트가 우리 페이지를 iframe으로 감싸는 클릭재킹을 막는다(설계서 10 §6.2). */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
