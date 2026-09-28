# Third-party software, models and data

Pinned as used. Nothing listed here is vendored into this repository unless stated.

## Integrated

| What | How it is used | Version / pin | Licence |
|---|---|---|---|
| [Kev](https://github.com/jaredpalmer/kev) | Default judge server (`python -m kev.serve`), speaking TypeSafe's System One API; fine-tuning toolchain in Gate B | commit `3e1cd3b` (cloned to `~/workplace/Silex/third_party/kev`, outside this repo) | Apache-2.0 |
| Kev-4B weights (`jaredpalmer/kev-4b`) | Default judge model, served from the Hugging Face cache | HF snapshot `139fdd94…`; base `Qwen/Qwen3.5-4B-Base`; fitted temperature 2.406 | Apache-2.0 (see the model card for the base model's terms) |
| `@electric-sql/pglite` | Embedded PostgreSQL (18.3) for dev and tests | ^0.5.8 | Apache-2.0 |
| `pg`, `zod`, `@opentelemetry/*` | Postgres driver, schemas, OTLP export | see `package-lock.json` | MIT / MIT / Apache-2.0 |
| silex-mockup `jev-observability/` UI | Copied to `web/demo/` (the simulated demo) | `silex-security/silex-mockup@fbd598d` | same owner |

## References only (not integrated)

From [awesome-jev-projects](https://github.com/logicrw/awesome-jev-projects/blob/main/README.zh-CN.md), read 2026-09-28. These informed the design, but none is a dependency or a measured baseline:

- [litjev](https://github.com/zhengxuyu/litjev), Apache-2.0: an alternative open System-One server built on option logits.
- [NanoJev](https://github.com/TianyuCodings/NanoJev), MIT: a small replica with a training pipeline, aimed at game loops.
- [stuntdouble](https://github.com/ReallyArtificial/stuntdouble), MIT: a shadow proxy comparing Jev with local models.

## Evaluation data (Gate B; fetched by script, licence re-checked per file, never committed raw)

InjecAgent (MIT) · AgentDojo (MIT) · ASB (MIT) · ToolEmu (Apache-2.0) · tau-bench (MIT). R-Judge is excluded because it declares no licence.
