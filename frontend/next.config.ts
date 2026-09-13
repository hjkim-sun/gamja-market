import type { NextConfig } from 'next';

/**
 * 브라우저는 동일 출처 /api/auth/* 만 호출하고 Next.js가 FastAPI로 전달한다.
 * 경로를 이중으로 붙이지 않도록 trailing slash 없는 origin만 허용한다.
 */
function resolveBackendApiOrigin(): string {
  const origin = process.env.BACKEND_API_ORIGIN?.trim();

  if (!origin) {
    throw new Error(
      'BACKEND_API_ORIGIN 환경 변수가 필요합니다. frontend/.env.local에 예: http://127.0.0.1:8000 을 설정하세요(.env.example 참고).',
    );
  }

  if (origin.endsWith('/')) {
    throw new Error('BACKEND_API_ORIGIN 끝에 / 를 붙이지 마세요. 예: http://127.0.0.1:8000');
  }

  return origin;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const backendApiOrigin = resolveBackendApiOrigin();

    return [
      {
        source: '/api/auth/:path*',
        destination: `${backendApiOrigin}/api/auth/:path*`,
      },
    ];
  },
};

export default nextConfig;
