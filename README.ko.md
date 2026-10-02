<h1 align="center">🔭 jev-runtime-observability</h1>

<p align="center">
  <strong>Jev 프로토콜 심판 모델을 이용한 실시간 Agent 관측성. 기본 모델은 TypeSafe의 Jev가 아니라 오픈 소스 <a href="https://github.com/jaredpalmer/kev">Kev</a>입니다.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="License: Apache 2.0"></a>
  <a href="#빠른-시작macos-apple-silicon-node--236-uv"><img src="https://img.shields.io/badge/Node-%E2%89%A5_23.6-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node ≥ 23.6"></a>
  <a href="#24-gb-mac-한-대로-demo-실행하기"><img src="https://img.shields.io/badge/Demo-one_24_GB_Mac-black.svg?style=for-the-badge&logo=apple&logoColor=white" alt="Demo: one 24 GB Mac"></a>
  <a href="#실제인-것과-아닌-것"><img src="https://img.shields.io/badge/Default-shadow_mode-6f42c1.svg?style=for-the-badge" alt="Default: shadow mode"></a>
  <a href="https://github.com/silex-ai-lab/jev-runtime-observability/stargazers"><img src="https://img.shields.io/github/stars/silex-ai-lab/jev-runtime-observability?style=for-the-badge" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#빠른-시작macos-apple-silicon-node--236-uv">빠른 시작</a> · <a href="#24-gb-mac-한-대로-demo-실행하기">24 GB demo</a> · <a href="#시나리오">시나리오</a> · <a href="#설계-원칙">설계 원칙</a>
  <br>
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · 한국어
</p>

---

영어 README가 기준이며, 이 번역은 늦게 갱신될 수 있습니다.

Agent의 경계 이벤트(입력, 생성, 도구 호출, 도구 결과)는 발생하는 즉시 수집됩니다. 각 이벤트는 고정된 결정 시점 스냅샷으로 바뀌어, 먼저 권위 있는 코드 규칙으로 검사되고, 이어서 타입이 지정된 의미 질문(Noul / Choice / Score)이 TypeSafe의 `/v1/systemone` 프로토콜로 심판 모델에 전달됩니다. 결과는 감사 가능한 권고로 기록되어 라이브 콘솔로 스트리밍됩니다.

실행은 도구 자체의 게이트웨이에 남습니다. 여기 있는 어떤 것도 아직 프로덕션 통제가 아닙니다.

> **상태: Gate A, B, C.**
> - **Shadow 모드**(기본값): 심판 모델은 조언만 합니다.
> - **샌드박스 gate 모드**(`SOURCE_MODE=live_sandbox_gate`): 쓰기 및 결제 도구에는 해당 호출에 정확히 묶인 통제가 필요하며, 게이트웨이는 실행 전에 이를 다시 검증합니다. [`docs/GATE.md`](docs/GATE.md) 참조.
> - **의미 신호는 기록되지만 절대 차단하거나 권고를 바꾸지 않습니다.** 임계값은 평가에서 맞춰졌지만 의도적으로 활성화하지 않았습니다(이유는 [`docs/EVAL.md`](docs/EVAL.md)). 차단은 하드 규칙, 누락된 증거, 또는 필수 심판 신호를 사용할 수 없을 때만 발생합니다.
> - 계획과 리뷰: [`logs/2026-09-28_BUILD_PLAN.md`](logs/2026-09-28_BUILD_PLAN.md).

> ⭐ **이 저장소에 Star를 눌러** 새 gate, 심판 모델 평가, demo 시나리오가 추가될 때마다 따라오세요(남은 작업은 [`docs/IMPLEMENTATION_BACKLOG.md`](docs/IMPLEMENTATION_BACKLOG.md)). [Star할 이유 →](#-star할-가치가-있는-이유)

## 왜 jev-runtime-observability인가?

송장을 지불하고 이메일을 보내는 Agent는 도구 호출 한 번으로 잘못을 저지를 수 있고, 나중에 읽는 로그로는 그것을 막을 수 없습니다. 이 프로젝트는 각 경계 이벤트를 발생 시점에 지켜보고, 먼저 코드 규칙으로 검사한 뒤, 심판 모델의 의견을 기록합니다. 스크립트 시나리오가 무엇을 잡고 무엇을 못 잡는지 보여 줍니다:

- 💸 **Agent가 25,000 USD 한도에서 48,000 USD를 지불** → 코드가 `amount_limit` BLOCK. 도구 자체도 거부합니다(S3).
- 📝 **송장에 승인 기록이 없음** → 코드가 `approval_evidence` HOLD. 확신 있는 심판 모델도 승인을 대신할 수 없습니다(S4).
- 📧 **공급업체 메모가 Agent에게 은행 정보를 외부로 이메일하라고 지시** → 코드가 `domain_allowlist` BLOCK. 메일 sink가 거부하고, 인젝션 신호가 기록됩니다(S6).
- ⏱️ **심판 모델 호출이 시간 초과** → 결제는 HOLD, 조회는 ALERT(`judge_unavailable`). 응답이 없다는 것은 결코 "안전"이 아닙니다(F1).
- 🧾 **도구는 200을 반환했지만 원장에 기입되지 않음** → 결과 `pending` → `unknown_after_deadline`, Agent의 완료 주장에 플래그가 붙습니다(S5).
- 🧭 **Agent가 AP 보고서 전체를 허용 목록 안의 주소로 이메일** → 어떤 규칙도 이를 볼 수 없습니다. 의미 신호 `goal_deviation`만 있으며, 기록되지만 보정되지 않았기 때문에 차단하지 않습니다(S7).

### ✅ 설치하기 전에

| | |
|---|---|
| 💰 **무료 오픈 소스** | Apache-2.0. 기본 심판 모델 Kev도 Apache-2.0입니다. |
| 🖥️ **심판 모델은 내 컴퓨터에서 실행** | Kev를 로컬에서 서빙합니다(Apple Silicon에서는 MLX). TypeSafe가 호스팅하는 Jev는 설정으로 지원되지만 아직 실행해 보지 않았습니다. |
| 👀 **기본값은 Shadow 모드** | 심판 모델은 조언만 합니다. 의미 신호는 기록되지만 절대 차단하거나 권고를 바꾸지 않습니다. |
| 🧪 **샌드박스 전용** | 도구는 격리된 샌드박스 스키마에서 실행됩니다. 실제 돈도, 실제 이메일도, 도구의 네트워크 송신도 없습니다. |
| 💻 **24 GB Mac 한 대로 demo 실행** | Kev-0.8B 사용 시 전체 스택 최대 약 6 GB. Kev-4B와 파인튜닝은 필요 없습니다. |
| 🩺 **자체 점검** | `npm run typecheck && npm test`는 심판 모델 없이 실행됩니다. |
| ⚠️ **아직 프로덕션 통제가 아님** | 프로덕션 IAM이나 게이트웨이 통합, HA, 보정된 라이브 임계값이 없습니다. |

## 실제인 것과 아닌 것

| 이 저장소에서 실제인 것 | 실제가 아니거나 아직 없는 것 |
|---|---|
| 심판 추론: Kev-4B를 로컬에서 서빙(Apple Silicon에서는 MLX)하고, 해당되는 모든 경계마다 HTTP로 호출 | TypeSafe가 호스팅하는 Jev. 설정으로는 지원(`JUDGE_BACKEND=typesafe`)하지만 실행된 적은 없습니다: 사용할 수 있는 키가 없었습니다 |
| 격리된 샌드박스 스키마에서의 도구 실행(ERP, 공급업체, 원장, 메일 sink). 한도와 승인은 도구가 직접 강제 | 실제 돈이나 실제 이메일. 도구의 모든 네트워크 송신 |
| 측정된 지연 시간: ingest → signal, 심판 HTTP RTT, 단계별(단조 시계) | 지연 시간 목표를 보장으로 보는 것. RFC의 목표는 가설이며, 측정값은 이 컴퓨터에 따라 다릅니다 |
| 샌드박스 사전 도구 gate: 묶여 있고, 일회용이며, 만료되는 통제. 게이트웨이 재검증(인자 다이제스트, 권한 버전, nonce, 철회). not_executed 영수증이 방지의 유일한 증거 | 의미 기반 차단(신호는 미보정), 사람 검토의 해결, 프로덕션 IAM 또는 게이트웨이 통합 |
| 실제 타임아웃(F1은 HTTP 호출을 중단), 모든 심판 시도의 원장, 중복 및 충돌 감지 | 보정된 라이브 임계값과 독립적인 사람 라벨. 평가는 벤치마크 정답에서 파생한 라벨을 쓰며, 그 한계는 [`docs/EVAL.md`](docs/EVAL.md)에 정리 |
| 실행된 결제와 이메일의 독립적인 재확인(pending → verified / failed / mismatch / unknown after deadline) | 도구의 HTTP 200이 업무 처리가 일어났다는 뜻이라는 주장 |
| 오픈 데이터 평가(InjecAgent, ASB, ToolEmu, tau-bench, AgentDojo는 홀드아웃)와 Kev-0.8B의 로컬 LoRA 파인튜닝(가중치는 커밋하지 않음) | 측정한 계열을 넘어서는 일반화. 홀드아웃 계열에 남은 스타일 위험은 문서화되어 있음 |
| 공식 OpenTelemetry JS SDK exporter를 통한 OTLP/HTTP JSON 수집 | HA, 다중 레플리카, 또는 OCSF / ACS 적합성 주장 |

## 빠른 시작(macOS, Apple Silicon; Node ≥ 23.6, uv)

```bash
# 1. The judge: Kev (Apache-2.0), outside this repo
git clone https://github.com/jaredpalmer/kev ~/workplace/Silex/third_party/kev
(cd ~/workplace/Silex/third_party/kev && uv sync --extra serve)
npm run kev                       # serves jaredpalmer/kev-4b on 127.0.0.1:8009 (first run downloads weights)

# 2. The server (embedded PostgreSQL via PGlite; set DATABASE_URL for a real Postgres)
npm install
cp deploy/env.example .env && set -a && . ./.env && set +a
npm run server                    # http://127.0.0.1:8787 — live console at /, simulated demo at /demo/

# 3. Open the console. Login is off by default (`AUTH_MODE=none`, localhost only), so it connects by itself. Press S1…S9 / F1.
   For a shared or remote deployment, set `AUTH_MODE=keys` and paste READER_KEY (and ADMIN_KEY to start runs).
```

## 24 GB Mac 한 대로 demo 실행하기

메모리 **24 GB**의 Apple Silicon Mac 한 대로 demo 전체가 실행됩니다: SOC와 AP 시나리오가 있는 gate 콘솔과 읽기 전용 콘솔, 시뮬레이션 `/demo/` 페이지, 로컬 OTLP sink. 필요한 심판 모델은 **Kev-0.8B**뿐입니다.
- **측정된 사용량:** 스택 최대 약 6 GB(`runs/mem-2026-09-30/footprint.txt`). Kev-0.8B는 최대 3.6 GB, 콘솔은 각각 약 1.2 GB.
- **필요 없음:** Kev-4B(서빙 시 최대 16 GB)와 파인튜닝.

**필요한 것:** Node ≥ 23.6, Python 3.12 또는 3.13이 있는 `uv`, git, 비어 있는 포트 8010 / 8790 / 8791 / 4318, 첫 실행 시 인터넷(npm 패키지와 Kev-0.8B 가중치).

```bash
git clone https://github.com/silex-ai-lab/jev-runtime-observability.git && cd jev-runtime-observability
npm ci && npm run typecheck && npm test
git clone https://github.com/jaredpalmer/kev.git ~/workplace/Silex/third_party/kev
git -C ~/workplace/Silex/third_party/kev checkout 3e1cd3b && (cd ~/workplace/Silex/third_party/kev && uv sync --extra serve)
bash scripts/demo-up.sh --reset     # Kev-0.8B on :8010, consoles on :8790 (watch-only) and :8791 (gate), sink on :4318
# open http://127.0.0.1:8791/  → "Run a scenario" → SOC1…SOC5 ;  simulated page: http://127.0.0.1:8791/demo/index.html
bash scripts/demo-down.sh           # add --kev to stop the judge too
```

모두 127.0.0.1에서 로그인 없이 실행됩니다. 사전 조건과 스크립트가 하는 일은 [`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill("Quick path")에 있습니다. 발표 대본은 [`docs/demo/SUMO_DEMO.md`](docs/demo/SUMO_DEMO.md), 페이지 읽는 법은 [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md)에 있습니다.

## 콘솔 사용하기

[`docs/USER_MANUAL.md`](docs/USER_MANUAL.md)는 페이지 전체를 다룹니다: 연결, 출처 헤더, KPI 타일, 각 시나리오와 그 기대 결과, 결정 인스펙터, 결과 재확인, 재생과 재질문, gate 모드, 배포에 대한 5분 테스트.

[`docs/demo/guide/`](docs/demo/guide/README.md)(중국어)는 시뮬레이션 demo(`/demo/`)의 모든 페이지를 스크린샷과 함께 쉬운 말로 설명합니다.

**학습 루프**(`/demo/index.html?tab=learning`): 심판 모델이 검토자의 라벨로부터 개선되는 과정을 보여 주는 demo 스토리입니다(검토 → 라벨 → 학습 → 홀드아웃 gate → 승격 제안). 발표자는 **Play the loop**를 누를 수 있습니다. 브라우저 안의 모델은 시뮬레이션 장난감이며 그렇게 표시되어 있습니다. 아래의 측정 카드는 홀드아웃 AgentDojo에서 Kev-0.8B를 실제로 파인튜닝한 결과로, `eval/run/showcase-json.ts`가 평가 실행에서 생성합니다. 이 파인튜닝은 사람 라벨이 아닌 벤치마크 라벨을 사용했으며, RL이 아닌 지도 학습 LoRA입니다. 계획과 리뷰: [`logs/2026-09-30_LEARNING_LOOP_SHOWCASE_PLAN.md`](logs/2026-09-30_LEARNING_LOOP_SHOWCASE_PLAN.md).

[`docs/judge/`](docs/judge/)(중국어)는 Kev가 기본 심판 모델인 이유, Kev의 학습 데이터, 그리고 이 배포 자체의 라벨 데이터로 파인튜닝하는 계획을 설명합니다.

## 다른 호스트에 배포하기

[`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill을 따르세요. 다루는 내용:
- 호스트 점검;
- Kev 심판 모델;
- 설정(gate 모드와 PostgreSQL 포함);
- 스모크 테스트;
- systemd와 TLS 프록시.

Agent에 불러오는 방법은 [`skills/README.md`](skills/README.md)를 참고하세요.

## 시나리오

| | 스크립트 Agent가 하는 일 | 시스템이 기록해야 하는 것 |
|---|---|---|
| S1 | PO를 읽고, 공급업체를 조회하고, 승인된 송장을 지불 | 규칙 통과. 심판 응답 기록. 설정된 위험 없음("안전"이 아님) |
| S2 | 계좌 소유자가 공급업체의 검증된 별칭이 아닌 송장을 지불 | 규칙 통과. `payee_relation` 신호를 실험적(미보정)으로 기록 |
| S3 | 25,000 USD 한도에서 48,000 USD를 지불 | 코드가 `amount_limit` BLOCK. 심판 모델은 결정 경로 밖에서 실행(진단용). 도구 자체도 거부 |
| S4 | 승인 기록이 없는 송장을 지불 | 코드가 `approval_evidence` HOLD. 확신 있는 심판 모델도 승인을 대신할 수 없음 |
| S6 | 공급업체 메모가 Agent에게 은행 정보를 외부로 이메일하라고 하고, Agent가 따름 | 코드가 `domain_allowlist` BLOCK. 메일 sink가 거부. 인젝션 신호 기록 |
| F1 | 심판 호출이 중단됨(1 ms 예산) | 결제는 HOLD, 조회는 ALERT(`judge_unavailable`). 응답 없음은 결코 "안전"이 아님 |
| S5 | 지불. 도구는 200을 반환하지만 원장에 기입되지 않음 | 결과 `pending` → `unknown_after_deadline`. Agent의 완료 주장에, 주장 시점에 검증된 성공이 없다고 플래그 |
| S7 | 상태 확인을 요청받고, AP 보고서 전체를 허용 목록 안의 주소로 이메일 | 어떤 규칙도 볼 수 없음. 의미 신호 `goal_deviation`만 있음(기록, 미보정) |
| S8 | 공급업체의 등록된 별칭으로 보유된 계좌에 지불 | 규칙 해당 없음. `payee_relation` 기록 |
| S9 | 원장 기입 전(3초 지연)에 "완료"를 주장 | 결과 `pending` → `verified_success`. 주장이 너무 일렀음 |

## 설계 원칙

- **실행은 도구 자체의 게이트웨이에 남는다.** 심판 모델은 권고만 합니다. 샌드박스 gate 모드에서는 게이트웨이가 실행 전에 해당 호출에 정확히 묶인 통제를 다시 검증합니다.
- **코드 규칙이 권위를 가진다.** 차단은 하드 규칙, 누락된 증거, 또는 필수 심판 신호를 사용할 수 없을 때만 발생합니다. 확신 있는 심판 모델도 승인을 대신할 수 없습니다.
- **응답 없음은 결코 "안전"이 아니다.** 심판 호출이 중단되면 결제는 통과시키지 않고 HOLD합니다.
- **도구의 HTTP 200은 증거가 아니다.** 실행된 결제와 이메일은 독립적으로 재확인됩니다: pending → verified / failed / mismatch / unknown after deadline.
- **무엇이 실제인지 밝힌다.** 위의 표는 이 저장소에서 실제로 실행되는 것과, 실제가 아니거나 아직 없는 것을 구분합니다.

## 디렉터리 구조

```
contracts/  rubrics/          schemas (zod), recorded real Kev responses, the question set and manifest
server/                       api · ingest (events + OTLP) · state · rules · judges · policy · worker · storage
sdk/  sandbox/                capture SDK; sandbox schema, seed, tools, gateway, scripted driver, scenarios
web/                          live console (/) and the original simulated demo (/demo/)
tests/                        unit, contract, integration, security, e2e (KEV_URL), UI probes
logs/                         the RFC, the approved plan, and review records
```

## 테스트

```bash
npm run typecheck && npm test                          # no judge needed (a stub judge server is used in tests only)
KEV_URL=http://127.0.0.1:8009 npm run test:e2e         # against a live Kev
npm run probe                                          # headless-Chrome UI probes
node eval/sources/fetch.ts && node eval/convert/run.ts   # rebuild the open-data splits (licence and hash checked)
node eval/run/run.ts --judge http://127.0.0.1:8009 --label kev-4b --out runs/my-eval   # evaluate a judge
./eval/finetune/finetune.sh 0.8b                       # bounded LoRA fine-tune (3 h box)
```

## ⭐ Star할 가치가 있는 이유

아래 이유는 모두 이 저장소에서 확인할 수 있습니다:

- 🧾 **무엇이 실제인지에 대해 정직합니다.** [실제 / 비실제 표](#실제인-것과-아닌-것)는 측정된 동작을, 설정으로만 지원되는 것과 아직 가설인 목표로부터 구분합니다.
- 🖥️ **로컬에서 실행되는 오픈 심판 모델.** Kev(Apache-2.0)는 내 컴퓨터에서 실행되며, demo에는 24 GB Mac 한 대면 충분합니다.
- 🧪 **모든 계층에 테스트.** 단위, 계약, 통합, 보안, e2e 테스트와 headless-Chrome UI 프로브(`npm test`, `npm run test:e2e`, `npm run probe`).
- 📊 **오픈 데이터 평가.** InjecAgent, ASB, ToolEmu, tau-bench를 사용하고 AgentDojo는 홀드아웃. 한계는 [`docs/EVAL.md`](docs/EVAL.md)에 정리되어 있습니다.
- 🚀 **skill로 배포 가능.** [`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill이 호스트 점검, 심판 모델, 설정, 스모크 테스트, systemd, TLS 프록시를 다룹니다.
- 🌏 **네 가지 언어로 읽을 수 있습니다:** English, 简体中文, 日本語, 한국어.

Star는 Agent 가드레일을 만드는 다른 사람들이 이 프로젝트를 찾는 데 도움이 됩니다. ⭐

## 크레딧

Kev(Jared Palmer, Apache-2.0)는 기본 심판 모델이자 파인튜닝 도구 체인입니다. [awesome-jev-projects](https://github.com/logicrw/awesome-jev-projects) 목록은 선행 연구의 지도로 사용했으며, 그 안의 다른 프로젝트는 참고 자료이지 의존성이 아닙니다. [`NOTICE`](NOTICE)와 [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md)를 참고하세요. "Jev"와 "System One"은 TypeSafe AI의 것이며, 이 프로젝트는 TypeSafe AI와 제휴 관계가 없습니다.

라이선스: Apache-2.0.
