---
name: sdd-tdd-development
description: >-
  This is a procedural guide for developing software using SDD & TDD (Test-Driven Development) with OrcaOrchestration.
  It describes the orchestration workflow between the Designer Worker, Tester Worker, and Developer Worker.
  Load this skill when the user requests new feature development or complex modifications to existing functionality.
---
sdd(스펙 주도 개발) 과 tdd (테스트 주도 개발)을 위해 orca orchestration 을 사용하며(스킬명: `orchestration`) 사용자의 지시
사항을 해석하여 아래 패턴 중 하나를 적용한다. 단, 오타 수정 및 주석 추가 등 간단한 작업에 활용하지 않는다. 

# 패턴 유형

## 기본 개발 패턴

설계 문서를 생성해야 하는 경우 또는 설계가 크게 바뀌는 경우 적용하며 단순한 수정 건에는 designer worker, tester worker, ui tester는 생략한다.

1. 생성할 워커
   - designer worker
   - tester worker (RED 케이스 생성)
   - backend worker
   - front worker
   - secu_reviewer: 보안 Risk 위주 검토
   - perf_reviewer: 성능 Risk 위주 검토
   - ui tester

2. 작업 순서
orchestrator > designer(t1) > 사람 검토(t2) > tester(t3) > [backend, front](t4) > [secu_reviewer, perf_reviewer](t5) > 검토(orchestrator)(t6) > ui tester (t7)

 - 메인 오케스트레이터는 위 7개의 워커를 생성하며 backend worker와 front worker, secu_reviewer, perf_reviewer, ui tester worker는 상호 통신할 수 있도록 상호 dispatch_id를 알려준다.
 - t6 단계에서 메인 오케스트레이터는 보안, 성능 검토 결과를 종합하여 ui test를 진행할지, t4 단계로 되돌아 갈지를 결정한다. 

## 워커 에이전트 유형 및 사고 수준 정의

1. designer worker: --agent claude --model opus --effort high
2. tester worker: --agent codex --model gpt-6-luna --effort high
3. backend worker: --agent codex --model gpt-6-luna--effort high
4. front worker: --agent claude --model sonnet --effort high
5. secu_reviewer: --agent codex --model gpt-6-sol --effort high
6. perf_reviewer: --agent claude --model opus --effort high
7. ui worker: --agent codex --model sonnet --effort high

# Must to do(Orchestrator)

1. 각 터미널의 명칭으로 워커의 이름을 지정해준다. (ex: designer worker: designer, backend worker: backend)
2. 워커 터미널 작업이 종료되어도 터미널을 닫지 않는다.
3. 개발 작업 후 모든 검증 작업이 완료되면 작업 워크트리에서 commit 을 수행하고 develop 브랜치로 pr을 작성한다. 
4. orca orchestration run-create 명령을 할 때에는 --from 인자를 반드시 작성한다. 

# Must do to(Worker)

UI를 열어 브라우저를 검사할 때는 orca cli를 활용한다. 