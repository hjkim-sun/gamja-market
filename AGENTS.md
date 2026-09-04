# 프로젝트 설명

이 프로젝트는 감자마켓 프로젝트로 물건을 사려는 구매 예정자가 구매를 원하는 물건의 스펙과 예상 가격대를 입력하면 판매하려는 사람이 지원하여 매칭하는 프
로젝트이다. (당근마켓과 유사하나 구매자 중심으로 진행되는 플랫폼)

# 프로젝트 기술 구조

본 프로젝트는 Next.js와 FastAPI 기반의 풀스택 웹 애플리케이션이다.

- Frontend: Next.js + TypeScript
- Backend: FastAPI + Python (uv)
- Database: Docker Postgres container(Dev), Supabase PostgreSQL(Prod)
- Deployment: Vercel

## 프로젝트 디렉토리 구조

frontend/
  ├── public/
  ├── src/  
  │    ├── app/  
  │    ├── components/  
  │    ├── features/  
  │    ├── lib/  
  │    └── types/  
  ├── tests/  
  └── logs/
backend/  
  ├── app/  
  │    ├── main.py  
  │    ├── api/  
  │    ├── schemas/  
  │    ├── services/  
  │    ├── repositories/  
  │    ├── db/  
  │    └── core/  
  ├── tests/  
  └── logs/
docs/

## 설계문서 저장
docs/specs 디렉토리안에 구현 단계별로 순번을 붙여 md 파일로 저장한다.