# anthropic-stt

An HTTP speech-to-text service that bridges raw PCM/WAV audio to Anthropic's
`voice_stream` speech-to-text WebSocket endpoint and returns transcripts. It
exposes a one-shot file transcription endpoint and a streaming (Server-Sent
Events) endpoint for per-utterance, low-latency transcription.

Authentication to Anthropic is done with the OAuth token that Claude Code stores
in `~/.claude/.credentials.json` (the token created by `claude login`). The
service reads that token read-only; it never writes or refreshes it.

## Prerequisites

- Node.js 20+ (the Dockerfile uses `node:20-alpine`).
- A valid Claude Code OAuth login on the machine running this service. Run
  `claude login` so that `~/.claude/.credentials.json` exists and is current.
  Token refresh is expected to be handled externally (for example a cron job);
  this service only reads the token.

## Setup

1. Copy the example environment file and adjust values:

   ```bash
   cp .env.example .env
   ```

   Environment variables:

   - `PORT` -- port the HTTP service listens on (default `10016`).
   - `CLAUDE_CREDENTIALS_PATH` -- optional. Absolute path to the Claude Code
     OAuth credentials file. Defaults to `~/.claude/.credentials.json`. Set this
     only if your credentials live somewhere else.

2. Install dependencies:

   ```bash
   npm ci
   ```

## Build

No build step is required (plain Node.js ES modules). To build the container
image:

```bash
docker build -t anthropic-stt .
```

## Run

```bash
npm start
```

Or with auto-reload during development:

```bash
npm run dev
```

The service logs `HTTP server on port <PORT>` once it is listening.

### Endpoints

- `GET /health` -- service status plus OAuth token status (exists / expired /
  minutes until expiry).
- `POST /transcribe?language=<lang>` -- one-shot transcription. Send a WAV (or
  raw PCM16LE @ 16 kHz mono) body as `application/octet-stream`; returns
  `{ "text": "...", "language": "..." }`.
- `POST /v1/transcribe?lang=<lang>` -- streaming transcription. Send chunked
  PCM16LE @ 16 kHz mono and half-close the body to signal end-of-utterance.
  Responds with `text/event-stream` SSE events: `partial`, `final`, `error`.

Supported languages include: en, es, fr, ja, de, pt, it, nl, hi, ko, pl, ru,
tr, uk, zh, cs, da, sv, no.

## Test

A simple one-shot smoke test is included. Provide a 16 kHz mono WAV file:

```bash
# Service must already be running.
WAV_PATH=./test-audio.wav LANGUAGE=en node test-oneshot.js
# or pass the path as the first argument:
node test-oneshot.js ./test-audio.wav
```

Configurable via environment: `WAV_PATH`, `SERVICE_URL`, `LANGUAGE`, `PORT`.

## TLS / VPN

This service requires no certificate and no VPN. It connects outbound to
`wss://api.anthropic.com` over standard TLS using the system trust store, and
serves plain HTTP locally (intended to sit behind a reverse proxy or be reached
over a trusted network). There is no inbound TLS or cert configuration to set.

## Model weights

None. Transcription is performed remotely by Anthropic's `voice_stream`
endpoint; there are no local model files to download.
