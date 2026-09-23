---
name: pr-merge
description: >-
  Use this skill before merging a branch into master to review production-impacting changes.
---
master 브랜치로 merge 를 수행하기 전 아래 사항들을 점검하여 운영 환경으로 반영한다.
1. 테이블 DDL
 - 추가된 테이블 DDL 내역이 있다면 운영 환경의 데이터베이스 환경에 DDL을 직접 반영한다. 
2. 환경 변수
 - 추가되거나 삭제된 환경변수가 있다면 운영 환경에 동일하게 반영한다.

위 작업이 완료되면 pr merge를 수행한다. 