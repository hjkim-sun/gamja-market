import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Footer } from '@/components/layout/Footer';
import { Header } from '@/components/layout/Header';
import { AuthProvider } from '@/features/auth/AuthProvider';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '감자마켓 | 사고 싶은 물건을 먼저 올려보세요',
    template: '%s | 감자마켓',
  },
  description: '구매자가 원하는 물건과 희망가를 올리면 판매자가 찾아오는 중고거래 서비스',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col">
        <AuthProvider>
          <Suspense fallback={<div className="h-[126px] border-b border-stone-200 bg-[#fbfaf7] lg:h-[69px]" />}>
            <Header />
          </Suspense>
          <main className="flex-1">{children}</main>
        </AuthProvider>
        <Footer />
      </body>
    </html>
  );
}
