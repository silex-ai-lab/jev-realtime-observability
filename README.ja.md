<h1 align="center">🔭 jev-runtime-observability</h1>

<p align="center">
  <strong>Jev プロトコルのジャッジによる、リアルタイムの Agent 可観測性。デフォルトのモデルは TypeSafe の Jev ではなく、オープンソースの <a href="https://github.com/jaredpalmer/kev">Kev</a> です。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="License: Apache 2.0"></a>
  <a href="#クイックスタートmacosapple-siliconnode--236uv"><img src="https://img.shields.io/badge/Node-%E2%89%A5_23.6-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node ≥ 23.6"></a>
  <a href="#24-gb-の-mac-1台で-demo-を動かす"><img src="https://img.shields.io/badge/Demo-one_24_GB_Mac-black.svg?style=for-the-badge&logo=apple&logoColor=white" alt="Demo: one 24 GB Mac"></a>
  <a href="#本物と本物でないもの"><img src="https://img.shields.io/badge/Default-shadow_mode-6f42c1.svg?style=for-the-badge" alt="Default: shadow mode"></a>
  <a href="https://github.com/silex-ai-lab/jev-runtime-observability/stargazers"><img src="https://img.shields.io/github/stars/silex-ai-lab/jev-runtime-observability?style=for-the-badge" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#クイックスタートmacosapple-siliconnode--236uv">クイックスタート</a> · <a href="#24-gb-の-mac-1台で-demo-を動かす">24 GB demo</a> · <a href="#シナリオ">シナリオ</a> · <a href="#設計原則">設計原則</a>
  <br>
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 日本語 · <a href="README.ko.md">한국어</a>
</p>

---

英語版 README が正です。この翻訳は更新が遅れることがあります。

Agent の境界イベント（入力、生成、ツール呼び出し、ツール結果）は発生した時点で取り込まれます。各イベントは凍結された判断時点のスナップショットに変換され、まず権威あるコードルールで検査され、次に型付きの意味的な質問（Noul / Choice / Score）が TypeSafe の `/v1/systemone` プロトコルでジャッジに送られます。結果は監査可能な推奨として記録され、ライブコンソールに配信されます。

実行はツール自身のゲートウェイに残ります。ここにあるものは、まだ本番の制御ではありません。

> **ステータス：Gate A、B、C。**
> - **Shadow モード**（デフォルト）：ジャッジは助言のみを行います。
> - **サンドボックス gate モード**（`SOURCE_MODE=live_sandbox_gate`）：書き込みと支払いのツールには、その呼び出しに束縛された制御が必要で、ゲートウェイは実行前にそれを再検証します。[`docs/GATE.md`](docs/GATE.md) を参照。
> - **意味的シグナルは記録されますが、ブロックも推奨の変更も決してしません。** しきい値は評価で調整済みですが、意図的に有効化していません（理由は [`docs/EVAL.md`](docs/EVAL.md)）。ブロックはハードルール、証拠の欠如、または必須のジャッジシグナルが利用できない場合にのみ発生します。
> - 計画とレビュー：[`logs/2026-09-28_BUILD_PLAN.md`](logs/2026-09-28_BUILD_PLAN.md)。

> ⭐ **このリポジトリに Star を**。新しい gate、ジャッジの評価、demo シナリオが入るたびに追えます（今後の作業は [`docs/IMPLEMENTATION_BACKLOG.md`](docs/IMPLEMENTATION_BACKLOG.md)）。[Star する理由 →](#-star-する価値がある理由)

## なぜ jev-runtime-observability なのか？

請求書を支払い、メールを送る Agent は、ツール呼び出し 1 回で間違いを起こしえます。後で読むログでは止められません。このプロジェクトは境界イベントを発生時に監視し、まずコードルールで検査し、ジャッジの見解を記録します。スクリプト化されたシナリオが、何を捕まえ、何を捕まえられないかを示します：

- 💸 **Agent が 25,000 USD の上限に対して 48,000 USD を支払う** → コードが `amount_limit` BLOCK。ツール自身も拒否します（S3）。
- 📝 **請求書に承認記録がない** → コードが `approval_evidence` HOLD。どれほど確信のあるジャッジでも承認の代わりにはなりません（S4）。
- 📧 **仕入先のメモが Agent に銀行情報を外部へメールさせる** → コードが `domain_allowlist` BLOCK。メール sink が拒否し、インジェクションのシグナルが記録されます（S6）。
- ⏱️ **ジャッジの呼び出しがタイムアウトする** → 支払いは HOLD、照会は ALERT（`judge_unavailable`）。回答がないことは決して「安全」ではありません（F1）。
- 🧾 **ツールは 200 を返したが、元帳に計上されない** → 結果は `pending` → `unknown_after_deadline` となり、Agent の完了報告にフラグが立ちます（S5）。
- 🧭 **Agent が AP レポート全体を許可リスト内のアドレスへ送る** → どのルールにも見えません。見えるのは意味的シグナル `goal_deviation` だけで、記録はされますが未較正なのでブロックはしません（S7）。

### ✅ インストールする前に

| | |
|---|---|
| 💰 **無料のオープンソース** | Apache-2.0。デフォルトのジャッジ Kev も Apache-2.0 です。 |
| 🖥️ **ジャッジはあなたのマシンで動く** | Kev をローカルで提供します（Apple Silicon では MLX）。TypeSafe のホスト版 Jev は設定上サポートされていますが、まだ実行していません。 |
| 👀 **デフォルトは Shadow モード** | ジャッジは助言のみ。意味的シグナルは記録されますが、ブロックも推奨の変更もしません。 |
| 🧪 **サンドボックスのみ** | ツールは隔離されたサンドボックススキーマで動きます。本物のお金もメールもなく、ツールからのネットワーク送信もありません。 |
| 💻 **24 GB の Mac 1 台で demo が動く** | Kev-0.8B でスタック全体のピークは約 6 GB。Kev-4B もファインチューニングも不要です。 |
| 🩺 **セルフチェック** | `npm run typecheck && npm test` はジャッジなしで動きます。 |
| ⚠️ **まだ本番の制御ではない** | 本番の IAM やゲートウェイとの統合、HA、較正済みのライブしきい値はありません。 |

## 本物と本物でないもの

| このリポジトリで本物のもの | 本物でない、またはまだないもの |
|---|---|
| ジャッジ推論：Kev-4B をローカルで提供（Apple Silicon では MLX）し、対象となる境界ごとに HTTP で呼び出す | TypeSafe のホスト版 Jev。設定ではサポート（`JUDGE_BACKEND=typesafe`）していますが、キーがなかったため未実行です |
| 隔離されたサンドボックススキーマでのツール実行（ERP、仕入先、元帳、メール sink）。上限と承認はツール自身が強制 | 本物のお金や本物のメール。ツールからのあらゆるネットワーク送信 |
| 実測レイテンシ：ingest → signal、ジャッジの HTTP RTT、ステージごと（単調時計） | レイテンシ目標を保証とみなすこと。RFC の目標は仮説であり、実測値はこのマシンに依存します |
| サンドボックスの事前ツール gate：束縛され、1 回限りで、期限付きの制御。ゲートウェイの再検証（引数ダイジェスト、権限バージョン、nonce、失効）。not_executed レシートが防止の唯一の証拠 | 意味的ブロック（シグナルは未較正）、人によるレビューの解決、本番の IAM やゲートウェイとの統合 |
| 本物のタイムアウト（F1 は HTTP 呼び出しを中断）、すべてのジャッジ試行の台帳、重複と競合の検出 | 較正済みのライブしきい値と独立した人手ラベル。評価はベンチマークの正解から導いたラベルを使い、その限界は [`docs/EVAL.md`](docs/EVAL.md) に記載 |
| 実行された支払いとメールの独立した読み戻し（pending → verified / failed / mismatch / unknown after deadline） | ツールの HTTP 200 が業務処理の発生を意味するという主張 |
| オープンデータ評価（InjecAgent、ASB、ToolEmu、tau-bench、AgentDojo はホールドアウト）と、Kev-0.8B のローカル LoRA ファインチューニング（重みはコミットしない） | 測定したファミリーを超える汎化。ホールドアウトのファミリーに残るスタイル上のリスクは文書化済み |
| 公式 OpenTelemetry JS SDK エクスポーターによる OTLP/HTTP JSON の受け入れ | HA、マルチレプリカ、OCSF / ACS 準拠の主張 |

## クイックスタート（macOS、Apple Silicon；Node ≥ 23.6、uv）

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

## 24 GB の Mac 1台で demo を動かす

メモリ **24 GB** の Apple Silicon Mac 1 台で demo 全体が動きます：SOC と AP のシナリオを含む gate コンソールと閲覧専用コンソール、シミュレーションの `/demo/` ページ、ローカルの OTLP sink。必要なジャッジは **Kev-0.8B** だけです。
- **実測フットプリント：** スタックのピークは約 6 GB（`runs/mem-2026-09-30/footprint.txt`）。Kev-0.8B のピークは 3.6 GB、各コンソールは約 1.2 GB。
- **不要なもの：** Kev-4B（提供時のピーク 16 GB）とファインチューニング。

**必要なもの：** Node ≥ 23.6、Python 3.12 または 3.13 の `uv`、git、空きポート 8010 / 8790 / 8791 / 4318、初回実行時のインターネット接続（npm パッケージと Kev-0.8B の重み）。

```bash
git clone https://github.com/silex-ai-lab/jev-runtime-observability.git && cd jev-runtime-observability
npm ci && npm run typecheck && npm test
git clone https://github.com/jaredpalmer/kev.git ~/workplace/Silex/third_party/kev
git -C ~/workplace/Silex/third_party/kev checkout 3e1cd3b && (cd ~/workplace/Silex/third_party/kev && uv sync --extra serve)
bash scripts/demo-up.sh --reset     # Kev-0.8B on :8010, consoles on :8790 (watch-only) and :8791 (gate), sink on :4318
# open http://127.0.0.1:8791/  → "Run a scenario" → SOC1…SOC5 ;  simulated page: http://127.0.0.1:8791/demo/index.html
bash scripts/demo-down.sh           # add --kev to stop the judge too
```

すべて 127.0.0.1 上で、ログインなしで動きます。前提条件とスクリプトの動作は [`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill（「Quick path」）にあります。トークトラックは [`docs/demo/SUMO_DEMO.md`](docs/demo/SUMO_DEMO.md)、ページの読み方は [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) にあります。

## コンソールの使い方

[`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) はページ全体を扱います：接続、来歴ヘッダー、KPI タイル、各シナリオと期待される表示、判断インスペクター、結果の読み戻し、リプレイと再質問、gate モード、デプロイの 5 分間テスト。

[`docs/demo/guide/`](docs/demo/guide/README.md)（中国語）は、シミュレーション demo（`/demo/`）の各ページをスクリーンショット付きで平易に説明します。

**学習ループ**（`/demo/index.html?tab=learning`）：ジャッジがレビュアーのラベルから改善していく demo のストーリーです（レビュー → ラベル → 学習 → ホールドアウトの gate → 昇格の提案）。発表者は **Play the loop** を押せます。ブラウザ内のモデルはシミュレーションのおもちゃで、その旨が表示されます。下の実測カードは、ホールドアウトの AgentDojo における Kev-0.8B の実際のファインチューニング結果で、`eval/run/showcase-json.ts` が評価実行から生成します。このファインチューニングは人手ではなくベンチマークのラベルを使った教師あり LoRA であり、RL ではありません。計画とレビュー：[`logs/2026-09-30_LEARNING_LOOP_SHOWCASE_PLAN.md`](logs/2026-09-30_LEARNING_LOOP_SHOWCASE_PLAN.md)。

[`docs/judge/`](docs/judge/)（中国語）は、Kev がデフォルトのジャッジである理由、Kev の学習データ、このデプロイ自身のラベル付きデータでのファインチューニング計画を説明します。

## 別のホストへのデプロイ

[`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill に従ってください。扱う内容：
- ホストの確認；
- Kev ジャッジ；
- 設定（gate モードと PostgreSQL を含む）；
- スモークテスト；
- systemd と TLS プロキシ。

Agent への読み込み方は [`skills/README.md`](skills/README.md) を参照。

## シナリオ

| | スクリプト化された Agent の動作 | システムが記録すべきこと |
|---|---|---|
| S1 | PO を読み、仕入先を照会し、承認済みの請求書を支払う | ルール通過。ジャッジの回答を記録。設定されたリスクなし（「安全」ではない） |
| S2 | 口座名義人が仕入先の検証済み別名ではない請求書を支払う | ルール通過。`payee_relation` シグナルを実験的（未較正）として記録 |
| S3 | 25,000 USD の上限に対して 48,000 USD を支払う | コードが `amount_limit` BLOCK。ジャッジは判断経路の外で実行（診断用）。ツール自身も拒否 |
| S4 | 承認記録のない請求書を支払う | コードが `approval_evidence` HOLD。確信のあるジャッジでも承認の代わりにならない |
| S6 | 仕入先のメモが Agent に銀行情報を外部へメールさせ、Agent がそれに従う | コードが `domain_allowlist` BLOCK。メール sink が拒否。インジェクションのシグナルを記録 |
| F1 | ジャッジの呼び出しが中断される（1 ms の予算） | 支払いは HOLD、照会は ALERT（`judge_unavailable`）。回答がないことは決して「安全」ではない |
| S5 | 支払う。ツールは 200 を返すが、元帳に計上されない | 結果は `pending` → `unknown_after_deadline`。Agent の完了報告に、報告時点で検証済みの成功がないとフラグ |
| S7 | ステータスの確認を頼まれ、AP レポート全体を許可リスト内のアドレスへメールする | どのルールにも見えない。意味的シグナル `goal_deviation` のみ（記録、未較正） |
| S8 | 仕入先の登録済み別名で保有される口座へ支払う | ルールに該当なし。`payee_relation` を記録 |
| S9 | 元帳への計上前（3 秒の遅延）に「完了」と報告する | 結果は `pending` → `verified_success`。報告が早すぎた |

## 設計原則

- **実行はツール自身のゲートウェイに残る。** ジャッジは推奨を出すだけです。サンドボックス gate モードでは、ゲートウェイが実行前に、その呼び出しに束縛された制御を再検証します。
- **コードルールが権威を持つ。** ブロックはハードルール、証拠の欠如、または必須のジャッジシグナルが利用できない場合にのみ発生します。確信のあるジャッジでも承認の代わりにはなりません。
- **回答がないことは決して「安全」ではない。** ジャッジの呼び出しが中断されると、支払いは通さずに HOLD します。
- **ツールの HTTP 200 は証拠ではない。** 実行された支払いとメールは独立に読み戻されます：pending → verified / failed / mismatch / unknown after deadline。
- **何が本物かを明示する。** 上の表は、このリポジトリで実際に動くものと、本物でない、またはまだないものを分けています。

## ディレクトリ構成

```
contracts/  rubrics/          schemas (zod), recorded real Kev responses, the question set and manifest
server/                       api · ingest (events + OTLP) · state · rules · judges · policy · worker · storage
sdk/  sandbox/                capture SDK; sandbox schema, seed, tools, gateway, scripted driver, scenarios
web/                          live console (/) and the original simulated demo (/demo/)
tests/                        unit, contract, integration, security, e2e (KEV_URL), UI probes
logs/                         the RFC, the approved plan, and review records
```

## テスト

```bash
npm run typecheck && npm test                          # no judge needed (a stub judge server is used in tests only)
KEV_URL=http://127.0.0.1:8009 npm run test:e2e         # against a live Kev
npm run probe                                          # headless-Chrome UI probes
node eval/sources/fetch.ts && node eval/convert/run.ts   # rebuild the open-data splits (licence and hash checked)
node eval/run/run.ts --judge http://127.0.0.1:8009 --label kev-4b --out runs/my-eval   # evaluate a judge
./eval/finetune/finetune.sh 0.8b                       # bounded LoRA fine-tune (3 h box)
```

## ⭐ Star する価値がある理由

以下の理由はすべて、このリポジトリで確認できます：

- 🧾 **何が本物かについて正直。** [本物 / 本物でないものの表](#本物と本物でないもの)は、実測した挙動と、設定上のサポートのみのもの、まだ仮説の目標とを分けています。
- 🖥️ **ローカルで動くオープンなジャッジ。** Kev（Apache-2.0）はあなたのマシンで動き、demo には 24 GB の Mac 1 台で足ります。
- 🧪 **すべての層にテスト。** ユニット、コントラクト、インテグレーション、セキュリティ、e2e のテストに加え、headless-Chrome の UI プローブ（`npm test`、`npm run test:e2e`、`npm run probe`）。
- 📊 **オープンデータでの評価。** InjecAgent、ASB、ToolEmu、tau-bench を使い、AgentDojo はホールドアウト。限界は [`docs/EVAL.md`](docs/EVAL.md) に記載。
- 🚀 **skill でデプロイできる。** [`deploy-jev-observability`](skills/deploy-jev-observability/SKILL.md) skill がホスト確認、ジャッジ、設定、スモークテスト、systemd、TLS プロキシを扱います。
- 🌏 **4 言語で読める：** English、简体中文、日本語、한국어。

Star は、Agent のガードレールを作る他の人がこのプロジェクトを見つける助けになります。⭐

## クレジット

Kev（Jared Palmer、Apache-2.0）はデフォルトのジャッジであり、ファインチューニングのツールチェーンです。[awesome-jev-projects](https://github.com/logicrw/awesome-jev-projects) のリストは先行研究の地図として使いました。そこにある他のプロジェクトは参考であり、依存関係ではありません。[`NOTICE`](NOTICE) と [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md) を参照。「Jev」と「System One」は TypeSafe AI のものです。このプロジェクトは TypeSafe AI と提携していません。

ライセンス：Apache-2.0。
