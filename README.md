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

## Layout

| File | What |
| --- | --- |
| `index.html` | Page shell (header, sidebar, detail pane) |
| `src/style.css` | Tailwind import + shared component classes (`btn`, `input`, `chip`, `warn`, …) |
| `src/main.ts` | State, job list, detail header, tabs, polling |
| `src/job-form.ts` | Create/edit form; sends only changed fields on edit |
| `src/token-field.ts` | Chip picker used for delivery targets and skills |
| `src/history.ts` | Runs table and output viewer |
| `src/util.ts` | Formatting, schedule descriptions, job warnings |
| `server/hermes-api.ts` | Local API → `hermes cron` CLI |
