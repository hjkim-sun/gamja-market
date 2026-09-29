---
name: pr-merge
description: >-
  Use this skill before merging a branch into develop or master to review production-impacting changes.
---
해당 pr 이 develop 대상인지 master 대상인지 확인한다. 

# master 브랜치 대상인 경우
master 브랜치는 vercel 및 supabase에 배포되어 운영된다. 
master 브랜치로 merge 를 수행하기 전 아래 사항들을 점검하여 운영 환경으로 반영한다.
1. 테이블 DDL
 - 추가된 테이블 DDL 내역이 있다면 운영 환경의 데이터베이스(supabase) 환경에 DDL을 직접 반영한다. 
2. 환경 변수
 - 추가되거나 삭제된 환경변수가 있다면 운영 환경(vercel)에 동일하게 반영한다.

# develop 브랜치 대상인 경우 
develop 워크트리는 ~/gamja-market에 존재한다.
develop 브랜치로 merge 를 수행하기 전 아래 사항들을 점검하여 개발 환경으로 반영한다.
1. 환경변수
 - 해당 워크트리의 .env 에 추가/변경된 환경변수를 반영한다. 
2. 라이브러리 반영
 - 개발 중 라이브러리가 설치/변경된 경우 develop 브랜치에도 동일하게 반영한다. 

위 작업이 완료되면 pr merge를 수행한다. 