# 2026-10-02 — README restyle on the Agent-Reach template, plus zh-CN / ja / ko

Made with the `readme-restyle-i18n` skill (jwang3417/jayskills). Template: `Panniantong/Agent-Reach` (shape only).

## Section map

| Template section | Ours | Source |
|---|---|---|
| Centred header, tagline, badge row, nav + language line | same | old README line 3; badges from `LICENSE`, `package.json` engines, the 24 GB demo section, the Status block |
| Sponsors, Trendshift, star-history | dropped | not earned |
| Intro | intro + Status block | verbatim |
| Top Star callout | above `## Why` | links `docs/IMPLEMENTATION_BACKLOG.md` |
| Why (pain points) | `## Why jev-runtime-observability?` | Scenarios table rows S3, S4, S6, F1, S5, S7 |
| Before you install | `### ✅ Before you install` | real / not-real table, 24 GB section, Tests, Credits |
| Platforms table | `## What is real and what is not` | verbatim |
| Install, usage, deploy, scenarios, layout, tests | same headings | verbatim |
| Design philosophy | `## Design principles` | see claim table |
| Why star | `## ⭐ Why star jev-runtime-observability` | factual only, no first-person promises (owner's choice) |
| Credits / licence | `## Credits` | verbatim |

No README heading slugs are linked from elsewhere in the repo (`grep README.md#` is empty), so the kept headings are safe. No brand icons: there is no compatibility table to mark.

## Claim table (new sentences → source)

| New sentence | Source |
|---|---|
| "a log you read later can't stop it" / "watches each boundary event as it happens, checks it with code rules first, and records what a judge says" | old README lines 5, 12 |
| Why bullets 💸 📝 📧 ⏱️ 🧾 🧭 | Scenarios table S3, S4, S6, F1, S5, S7 (S7 keeps "recorded, uncalibrated" and adds "does not block" from Status line 12) |
| Free and open source; Kev is Apache-2.0 | `LICENSE`; Credits |
| The judge runs on your machine; hosted Jev not run | real / not-real table row 1 |
| Shadow mode by default | Status lines 10, 12 |
| Sandbox only; no network egress from tools | real / not-real table row 2 |
| One 24 GB Mac; ~6 GB peak; Kev-4B and fine-tuning not needed | 24 GB section |
| Self-check needs no judge | Tests block comment |
| Not a production control yet: no production IAM/gateway, no HA, no calibrated thresholds | line 7; real / not-real rows 4, 5, 8 |
| Design principles (5 bullets) | lines 7, 11, 12; Scenarios S4, F1; real / not-real rows 6 and header |
| Why-star bullets | real / not-real table; 24 GB section; Layout (`tests/`); `package.json` scripts; real / not-real row 7 and `docs/EVAL.md`; Deploying section; the shipped translations |
| Badges: Apache 2.0, Node ≥ 23.6, Demo one 24 GB Mac, Default shadow mode, live stars | `LICENSE`, `package.json`, 24 GB section, Status |

## Translations

`README.zh-CN.md`, `README.ja.md`, `README.ko.md`. Code blocks are copied from the English file by script (byte-identical), the scenario ID column is frozen, fragment links use each file's own heading slugs, and Chinese/Japanese prose has no hard wraps.

## Checks

```bash
S=<jayskills>/readme-restyle-i18n/scripts
python3 $S/check_links.py --repo . README.md README.*.md
python3 $S/check_i18n.py README.md README.zh-CN.md README.ja.md README.ko.md --frozen-col 3:1 --langs
```

All pass. Each check was shown to fail on a mutated copy: a changed scenario ID (C4), an altered code block (C3) and a broken anchor (links). Light and dark renders were inspected with `render_readme.py`.
