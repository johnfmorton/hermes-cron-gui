# Hermes Cron GUI

A local web app for creating, editing, and routing [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) cron jobs.

TypeScript + Vite + Tailwind v4, no UI framework. Requires Node 22.5+ (uses the built-in `node:sqlite`) and the `hermes` CLI on your `PATH`.

```bash
npm install
npm run dev      # http://127.0.0.1:5178 (or the next free port, reported at startup)
npm start        # production build + preview server, same port
```

## How it works

- **Reads** come straight from `~/.hermes/cron/`: `jobs.json` (jobs), `output/<job_id>/*.md` (saved runs), `executions.db` (run history, opened read-only), and `ticker_heartbeat` (scheduler liveness).
- **Writes** always go through `hermes cron create|edit|pause|resume|run|remove`, so Hermes does its own validation and file locking. The app never writes to `~/.hermes` itself.
- The API is a Vite plugin (`server/hermes-api.ts`) mounted at `/api` in both the dev and preview servers, so a single process runs everything.
- The server binds to `127.0.0.1` only and rejects cross-origin and non-loopback requests, because its endpoints run commands on your machine.

Environment overrides: `HERMES_HOME` (default `~/.hermes`) and `HERMES_BIN` (default `hermes`).

## Per-job models

The **Model** picker on each job lists your local Ollama models plus models from any cloud provider Hermes is signed in to (from `~/.hermes/auth.json`, `provider_models_cache.json`, and non-empty keys in `~/.hermes/.env`). "Follow default" leaves the job unpinned, so it runs on `cron.model`, or `model.default` if that isn't set.

## Prompt rewriter

**Suggest rewrite** (next to a job's prompt) asks an LLM to tighten the prompt for Hermes cron: self-contained, chat-sized output, and an explicit `[SILENT]` rule, either "use it when nothing is new" or "never use it". The suggestion appears in an editable panel, and your prompt only changes when you click **Use this version**. Nothing is saved to Hermes until you click **Save changes**.

Pick the rewriter's backend and model under **Settings** (saved to `settings.json`, gitignored):

- **Local Ollama:** uses the Ollama that Hermes's `config.yaml` points at. No key needed.
- **Anthropic API:** copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The server reads `.env` on each request and never sends the key to the browser.

## Layout

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
| `server/hermes-api.ts` | Local API → `hermes cron` CLI |
| `server/hermes-config.ts` | Reads Hermes config: default model, providers, available models |
| `server/rewrite.ts` | Rewriter settings, `.env` key, Ollama/Anthropic calls |
