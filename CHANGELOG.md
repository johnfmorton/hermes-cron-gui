# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Runs and Output tabs refresh automatically along with the job list, redrawing only when something changed; the Output tab keeps the file you're reading and your scroll position.
- A "last checked" line with a Refresh button beside the job tabs, showing how often the page checks.
- Faster checks (every 5s instead of 15s) while a run is queued or in progress, and a "running" badge in the job list.

### Fixed

- "Run now" no longer kills runs that take longer than 60 seconds. `hermes cron run` executes the whole job synchronously, so it now starts as a detached background process that survives page navigation and dev-server restarts.
- A run whose process died no longer shows as "running" forever; the badge follows Hermes's own rule (claim under 5 minutes old and owner process alive).
- The "Run now" tooltip no longer says the run waits for the next scheduler tick.

## [0.0.1] - 2026-09-23

### Added

- Local web GUI (TypeScript, Vite, Tailwind v4) for Hermes Agent cron jobs: list, create, edit, pause/resume, run now, and delete.
- Delivery target picker with known chats, platform home channels, `local`, `origin`, `all`, `bot-chat`, and custom targets, plus a separate failure-notice target.
- Run history from `executions.db` separating scheduled and manual runs, and an output viewer for saved run files with a "final response only" view.
- Warnings for common cron pitfalls: `origin` delivery on jobs with no origin chat, jobs that have never completed a scheduled run, delivery errors, and failure streaks.
- Scheduler heartbeat indicator in the header.
- Runs tab shows which model actually handled each run and flags runs whose reply was `[SILENT]`.
- Per-job model picker listing local Ollama models and models from cloud providers Hermes is signed in to, with the effective default shown for unpinned jobs.
- "Suggest rewrite" helper that proposes a cron-ready version of a job's prompt in an editable panel and replaces the prompt only on approval.
- Settings screen to choose the rewriter's backend (local Ollama or Anthropic API) and model; the Anthropic key is read from a gitignored `.env`.
- Automatic fallback to the next free port when 5178 is busy, with a message naming the port in use.

### Security

- The local API binds to `127.0.0.1` and rejects cross-origin and non-loopback requests, since it runs `hermes cron` commands.
- All job changes go through the `hermes cron` CLI with arguments passed without a shell; the app never writes to `~/.hermes` directly.
- API keys stay on the server; the browser only learns whether a key is present.
