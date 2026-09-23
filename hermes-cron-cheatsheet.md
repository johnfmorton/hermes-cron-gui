# Hermes Cron Cheat Sheet

Quick reference for creating, editing, and routing scheduled jobs in Hermes Agent.
Commands below are the CLI form (`hermes cron …`). Every one also works inside a chat
as a slash command (`/cron …`) with the same arguments.

Full reference: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron

---

## The mental model

- Every job runs in a **fresh agent session** with no memory of your chats. The prompt has to be self-contained: URLs, formats, rules, everything.
- The agent's **final message is what gets delivered**. Write the prompt so the last thing it says is the report itself.
- Jobs live in `~/.hermes/cron/jobs.json`; each run's output is saved to `~/.hermes/cron/output/<job_id>/<timestamp>.md` regardless of delivery target.
- The scheduler runs inside the gateway. If the gateway is down, no jobs fire. Check with `hermes cron status`.

---

## Create a job

```bash
hermes cron create "<schedule>" "<prompt>" --name "<name>" --deliver <target>
```

Example (weekly, Monday 8 AM, delivered to Signal):

```bash
hermes cron create "0 8 * * 1" \
  "Search cga.ct.gov and portal.ct.gov/sots for new Connecticut election-law activity since your previous run. Report bills, enacted acts, SOTS guidance, and deadlines, each with a source URL. Keep it under 350 words. If nothing new, respond with only [SILENT]." \
  --name "CT election law watch" \
  --deliver signal
```

`add` is an alias for `create`.

### Useful create flags

| Flag | What it does |
| --- | --- |
| `--name "…"` | Human-readable name shown in `list` |
| `--deliver <target>` | Where the output goes (see below) |
| `--failure-deliver <target>` | Where failure notices go; defaults to same as `--deliver`. Use `local` to keep them out of chat |
| `--script <path>` | Python script that runs first; its stdout becomes context for the agent |
| `--skill <name>` | Load a skill before the prompt runs; repeat for multiple, loaded in order |
| `--no-agent` | Script-only job: no LLM, script output is delivered as-is |

Run `hermes cron create --help` for the full set.

### Schedule formats

| Format | Example | Meaning |
| --- | --- | --- |
| Cron expression | `0 8 * * 1` | 8:00 AM every Monday |
| Cron expression | `0 9 * * *` | 9:00 AM daily |
| Cron expression | `*/30 * * * *` | Every 30 minutes |
| Interval | `every 6h` | Every 6 hours |
| Relative delay | `30m` | Once, 30 minutes from now |
| ISO timestamp | `2026-10-01T09:00:00` | Once, at that time |

Natural language like "daily at 9am" is **not** supported.

---

## Direct the output

The `--deliver` flag decides where the agent's final message lands.

| Target | Result |
| --- | --- |
| `origin` | Back to the chat that created the job. **Default.** If created from the CLI, there is no chat, so output only goes to the log file. This is the classic "job succeeded but I never saw anything" cause. |
| `signal` | Your Signal home channel (Note to Self) |
| `signal:<number>` | A specific Signal chat |
| `local` | Save to `~/.hermes/cron/output/` only, no message |
| `telegram` / `discord` / `slack` | That platform's home channel |
| `bot-chat` | Inject into the bot's own chat session so it can read and act on the result |
| `a,b` | Comma-separate to deliver to several targets |

**Rule of thumb:** if you create jobs from the terminal, always pass `--deliver signal` explicitly. Don't rely on `origin`.

### Suppress "nothing to report" messages

Tell the agent in the prompt: *"If nothing changed, respond with only `[SILENT]`."*
Hermes treats `[SILENT]` as a delivery-suppression marker, so you only hear from the job when there's something to say. Failures still get reported unless you set `--failure-deliver local`.

---

## Edit a job

```bash
hermes cron edit <job_id> --deliver signal              # change delivery target
hermes cron edit <job_id> --schedule "0 7 * * 1-5"      # change schedule
hermes cron edit <job_id> --prompt "New instructions…"  # replace the prompt
hermes cron edit <job_id> --name "Better name"
hermes cron edit <job_id> --skill arxiv --skill obsidian
hermes cron edit <job_id> --clear-skills
```

Job IDs are the 12-character hex string at the left of `hermes cron list` (e.g. `6e232100a3aa`).

Edits are picked up by the running scheduler; no gateway restart needed.

---

## Manage and test

```bash
hermes cron list                 # all jobs, next run, last run status
hermes cron run <job_id>         # fire it now (best way to test)
hermes cron runs <job_id>        # execution history with errors
hermes cron pause <job_id>
hermes cron resume <job_id>
hermes cron remove <job_id>      # aliases: rm, delete
hermes cron status               # is the scheduler alive?
hermes cron doctor               # health check across all jobs
hermes cron incidents            # list/acknowledge repeated failures
```

Note in `hermes cron runs` output: `source=builtin` is a scheduled run, `source=direct` is a manual `cron run`. A job can look healthy from manual runs and still have never completed a scheduled one.

---

## Writing a good prompt

1. State the task and the sources to check (with URLs).
2. State the output format, and keep it plain text for chat delivery.
3. State the `[SILENT]` rule if it's a monitor.
4. End with: *"Your final message is delivered to the user; make it the report itself."*
5. Keep it under a few hundred words of output. Chat messages, not documents.

Continuity is on by default: each run receives the previous run's output, so you can say "report only what's new since your previous run."

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No LLM provider configured` | No default model set for the profile | `hermes model`, then `hermes gateway restart` |
| Run says `ok` but nothing arrives | `--deliver origin` on a CLI-created job | `hermes cron edit <id> --deliver signal` |
| Job never fires | Gateway not running, or Mac asleep at fire time | `hermes cron status`; `launchctl list \| grep hermes`; keep the Mac awake or move the schedule |
| Run fails, output file is huge | Local model timed out or ran out of context | Shorten the prompt's scope, or point the job at a faster model |
| Changed `config.yaml`, nothing changed | Gateway still has the old config in memory | `hermes gateway restart` |

Output files for any run: `ls ~/.hermes/cron/output/<job_id>/`
