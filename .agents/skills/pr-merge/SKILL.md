---
name: pr-merge
description: >-
  Use this skill before merging a branch into develop or master to review production-impacting changes.
---
해당 pr 이 develop 대상인지 master 대상인지 확인한다. 

# master 브랜치 대상인 경우
master 브랜치는 vercel 및 supabase에 배포되어 운영된다. 
master 브랜치 pr 리뷰를 위해 `orchestration` 스킬을 활용해 아래 검증을 수행한다. 

1. 생성할 워커
 - secu_reviewer: 보안 Risk 위주 검토
 - perf_reviewer: 성능 Risk 위주 검토
 
2. 작업 순서
orchestrator > [secu_reviwer, perf_reviewer] > 리뷰 의견 종합/결정(orchestrator) > merge(orchestrator)

3. 워커 에이전트 유형 및 사고 수준 정의
 - secu_reviewer --agent codex --model gpt-6-sol --effort high
 - perf_reviewer: --agent claude --model opus --effort high

## 리뷰 의견 종합/결정 단계
 - orchestrator는 리뷰 의견을 종합하여 부결/승인을 결정한다.
 - 만약 부결로 판단한 경우 사유를 pr에 변경 요청 리뷰를 남긴다. 
 - 승인으로 판단한 경우 merge 단계를 수행한다. 

## merge 단계
 - merge 단계에서는 아래 작업을 수행한다. 
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