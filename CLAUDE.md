# CLAUDE.md -- anthropic-stt

This file provides guidance to Claude Code when working in this repository.

IMPORTANT: NEVER USE EMOJIS ANYWHERE IN LOGGING, CODE OR OTHER TEXT.

IMPORTANT: Treat this codebase as work in progress. Never do backwards-compatibility or legacy support unless explicitly asked. Remove code that becomes redundant.

## What this service is

A speech-to-text bridge over Anthropic's `voice_stream` WebSocket endpoint. Clients stream
PCM audio in; the service relays it to Anthropic
(`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`) and returns interim and final
transcripts. It is the STT backend for the AI orchestration system's voice path.

This service listens on **port 10016**.

For the whole-system architecture and the full port table, see the orchestrator repo
(`jaskier-os/orchestrator`) CLAUDE.md / docs -- do not duplicate that map here.

## Auth (important)

This service authenticates to Anthropic using **Claude Code OAuth credentials, not an API
key**. It reads the credential file that `claude login` maintains -- default
`~/.claude/.credentials.json`, overridable with `CLAUDE_CREDENTIALS_PATH`. There is no
`ANTHROPIC_API_KEY` path here; do not add one unless asked.

## Tech stack

- Node.js 18+, ES modules
- Koa (HTTP server), `ws` (WebSocket client to Anthropic)
- Joi (config validation), dotenv

## Run

```bash
npm start    # node src/index.js
npm run dev  # node --watch src/index.js
```

`test-oneshot.js` is a manual one-shot test harness.

## Layout

- `src/index.js` -- Koa server; receives client audio, drives the upstream session
- `src/anthropic-session.js` -- WebSocket client to Anthropic `voice_stream` (connect,
  relay PCM, parse interim/final transcripts and errors)
- `src/claude-credentials.js` -- loads/refreshes the Claude Code OAuth credentials
- `src/config.js` -- Joi-validated config (`PORT`, `CLAUDE_CREDENTIALS_PATH`)

Note: a previous WebSocket bridge to the orchestrator (`/ws/anthropic-stt`) was removed;
do not reintroduce it unless asked.

## Deploy

Server-side service: it auto-deploys on git push to `main`. CI (`.gitlab-ci.yml`) builds the
Dockerfile with `docker buildx --push` to the local registry, then bumps the image tag in
the `infrastructure/deploy` repo, which Flux reconciles onto the cluster.

- NEVER restart the running service yourself -- if a restart is needed, tell the user.
- NEVER build/push Docker images by hand; commit + push and let CI handle it.
- NEVER modify Kubernetes env/secrets/deployments directly; changes go through the deploy
  manifests repo so Flux reconciles them.
