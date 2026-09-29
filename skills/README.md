# Skills

Agent skills for operating this project. Each folder is one skill: a `SKILL.md` with frontmatter (`name`, `description`) plus any helper `scripts/` and `templates/`.

| Skill | Use it to |
|---|---|
| [`deploy-jev-observability`](deploy-jev-observability/SKILL.md) | Deploy the server, live console and local Kev judge on a new host (Linux with an NVIDIA GPU, or an Apple Silicon Mac); check the host; run the smoke test; set up gate mode, PostgreSQL, systemd and a TLS proxy |
| [`jev-work-plan`](jev-work-plan/SKILL.md) | Resume the dated work plan (`plans/YYYY-MM-DD.md`) on any machine: check the machine, pick the next open task, and write status back to git so another machine can continue |

## Using a skill

- **Claude Code:** make the skill visible to the agent, then ask it to deploy (for example, "deploy jev-realtime-observability on this host").

```bash
mkdir -p .claude/skills && ln -s ../../skills/deploy-jev-observability .claude/skills/deploy-jev-observability   # this repo only
# or for every project on the machine:
ln -s "$PWD/skills/deploy-jev-observability" ~/.claude/skills/deploy-jev-observability
```

- **Codex:** copy the folder to `~/.codex/skills/`. A symlinked skill folder is not guaranteed to load there.
- **By hand:** the `SKILL.md` is ordinary step-by-step documentation, and the scripts run on their own:

```bash
bash skills/deploy-jev-observability/scripts/check-host.sh   # before installing
bash skills/deploy-jev-observability/scripts/smoke.sh        # after the server is up (reads ./.env)
```

To resume the work plan on another machine:

```bash
git clone https://github.com/silex-ai-lab/jev-realtime-observability.git && cd jev-realtime-observability
npm ci
ln -s "$PWD/skills/jev-work-plan" ~/.claude/skills/jev-work-plan      # then ask: "resume the jev work plan"
bash skills/jev-work-plan/scripts/resume-check.sh                      # or check by hand
```
