# Hermes Cron GUI

A local web app for creating, editing, running, and routing [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) cron jobs.

It reads your jobs and run history straight from `~/.hermes/cron/` and makes every change through the `hermes cron` CLI, so Hermes stays the source of truth.

## Features

- **Jobs:** list, create, edit, pause/resume, run now, and delete. Edits send only the fields you changed.
- **Delivery routing:** pick from known chats, platform home channels, `local`, `origin`, `all`, `bot-chat`, or a custom target, plus a separate target for failure notices.
- **Per-job models:** pin a job to a local Ollama model or to a model from any cloud provider Hermes is signed in to, or leave it on the default.
- **Run history:** scheduled and manual runs listed separately, with the model that handled each run and a flag for runs that replied `[SILENT]`.
- **Output viewer:** browse each run's saved output, with a "final response only" view.
- **Live status:** the job list, Runs, and Output tabs refresh on their own. Checks run every 15s, or every 5s while a run is queued or in progress, and running jobs get a "running" badge.
- **Warnings** for common pitfalls: `origin` delivery on a job with no origin chat, a job that has never completed a scheduled run, delivery errors, and failure streaks.
- **Scheduler heartbeat** in the header, so you can tell when the gateway isn't firing jobs.
- **Prompt rewriter:** "Suggest rewrite" proposes a cron-ready version of a prompt for you to edit and approve.

## Requirements

- Node 22.5+ (the app uses the built-in `node:sqlite`)
- [Hermes Agent](https://hermes-agent.nousresearch.com/) installed, with the `hermes` CLI on your `PATH`
- The Hermes gateway running, since that's where the scheduler lives (`hermes cron status` checks it)

## Getting started

```bash
npm install
npm run dev      # http://127.0.0.1:5178, or the next free port (reported at startup)
npm start        # production build + preview server, same port
```

Other scripts: `npm run build` (type-check, then build) and `npm run typecheck`.

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERMES_HOME` | `~/.hermes` | Where Hermes keeps its config, jobs, and run output |
| `HERMES_BIN` | `hermes` | The Hermes CLI to call |

## How it works

- **Reads** come straight from `~/.hermes/cron/`: `jobs.json` (jobs), `output/<job_id>/*.md` (saved runs), `executions.db` (run history, opened read-only), and `ticker_heartbeat` (scheduler liveness).
- **Writes** always go through `hermes cron create|edit|pause|resume|run|remove`, so Hermes does its own validation and file locking. The app never writes to `~/.hermes` itself. Arguments are passed without a shell.
- **Run now** starts `hermes cron run` as a detached background process. The CLI runs the whole job synchronously, which can take minutes on a large local model, so a detached run keeps going if you leave the page or restart the server. Progress shows up in the Runs tab.
- **The API** is a Vite plugin (`server/hermes-api.ts`) mounted at `/api` in both the dev and preview servers, so a single process runs everything.
- **Security:** the server binds to `127.0.0.1` only and rejects cross-origin and non-loopback requests, because its endpoints run commands on your machine. API keys stay on the server; the browser only learns whether a key is present.

## Per-job models

The **Model** picker on each job lists:

- **Local models** from any Ollama that Hermes's `config.yaml` points at (embedding models are left out, since they can't run a job).
- **Cloud models** from `~/.hermes/provider_models_cache.json`, for each provider Hermes has credentials for. A provider counts as signed in when it has an entry in `~/.hermes/auth.json`, a non-empty credential pool, or a non-empty key in `~/.hermes/.env`. Anthropic also counts when Hermes borrows Claude Code's login (`~/.claude/.credentials.json`).

**Follow default** leaves the job unpinned, so it runs on `cron.model`, or on `model.default` if that isn't set.

The list shows what each provider's catalog offers, not what your account is allowed to use. See the troubleshooting section below if a model is rejected.

## Prompt rewriter

**Suggest rewrite** (next to a job's prompt) asks an LLM to tighten the prompt for Hermes cron. The result is self-contained, sized for a chat message, and has an explicit `[SILENT]` rule: either "use it when nothing is new" or "never use it". The suggestion appears in an editable panel. Your prompt only changes when you click **Use this version**, and nothing is saved to Hermes until you click **Save changes**.

Pick the rewriter's backend and model under **Settings** (saved to `settings.json`, gitignored):

- **Local Ollama:** uses the Ollama that Hermes's `config.yaml` points at. No key needed.
- **Anthropic API:** copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The server reads `.env` on each request and never sends the key to the browser.

## Troubleshooting

**A run fails with `HTTP 400: The requested model is not supported`.**
Your account with that provider can't use that model, even though it's in the provider's catalog. Test the model outside cron with `hermes -z "Reply with: ok" --provider <provider> -m <model>`, then pick a model that works.

GitHub Copilot is the usual culprit. If Hermes finds no Copilot login of its own, it borrows the GitHub CLI's token (`gh auth token`), and Copilot serves only a basic set of models to that token. If you don't use Copilot, run `hermes auth remove copilot <n>` (find `<n>` with `hermes auth list`). That stops Hermes from using the `gh` token, and Copilot drops out of the picker.

**Jobs never fire, or the heartbeat in the header looks stale.**
The scheduler runs inside the Hermes gateway. Check it with `hermes cron status`.

**A job ran but nothing arrived.**
Check the job's warnings and the Runs tab. A reply of `[SILENT]` is suppressed on purpose, and an `origin` delivery target does nothing on a job that has no origin chat.

For writing prompts, schedules, and delivery targets, see [`hermes-cron-cheatsheet.md`](hermes-cron-cheatsheet.md).

## Project layout

TypeScript + Vite + Tailwind v4, no UI framework.

| File | What |
| --- | --- |
| `index.html` | Page shell (header, sidebar, detail pane) |
| `src/style.css` | Tailwind import + shared component classes (`btn`, `input`, `chip`, `warn`, …) |
| `src/main.ts` | State, job list, detail header, tabs, polling |
| `src/job-form.ts` | Create/edit form, model picker, rewrite panel; sends only changed fields on edit |
| `src/settings-view.ts` | Settings screen (rewriter backend and model) |
| `src/token-field.ts` | Chip picker used for delivery targets and skills |
| `src/history.ts` | Runs table and output viewer |
| `src/util.ts` | Formatting, schedule descriptions, job warnings |
| `src/api.ts`, `src/types.ts` | Browser-side API client and shared types |
| `server/hermes-api.ts` | Local API → `hermes cron` CLI, including detached "Run now" |
| `server/hermes-config.ts` | Reads Hermes config: default model, signed-in providers, available models |
| `server/rewrite.ts` | Rewriter settings, `.env` key, Ollama/Anthropic calls |

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE) © 2026 John F Morton
