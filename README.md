# anthropic-stt

> **Docs & wiki:** [github.com/jaskier-os/docs/wiki](https://github.com/jaskier-os/docs/wiki)

## What it is

A speech-to-text bridge. It takes audio over plain HTTP and relays it to
Anthropic's `voice_stream` WebSocket (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`),
returning the transcript. Koa server on port 10016. Two endpoints:
`POST /transcribe` for one-shot audio buffers and `POST /v1/transcribe` for
streaming. Auth to Anthropic uses the Claude Code OAuth credentials, not an API
key.

## Build / run

Local dev:

```bash
npm install
cp .env.example .env   # edit if your credentials path differs
npm run dev            # node --watch, src/index.js
npm start              # plain node
```

There's a `test-oneshot.js` for a quick manual check against `/transcribe`.

Docker:

```bash
docker build -t anthropic-stt .
docker run -p 10016:10016 --env-file .env anthropic-stt
```

EXPOSE 10016, healthcheck on `/health` (also reports OAuth token status).

## Configuration

Config is env vars. `.env.example` is the source of truth - copy to `.env` and
edit. There are only two:

- `PORT` - HTTP listen port (default 10016).
- `CLAUDE_CREDENTIALS_PATH` - path to the Claude Code OAuth credentials file.
  Defaults to `~/.claude/.credentials.json` (what `claude login` maintains);
  set it only if yours live elsewhere.

## Dependencies

Node >= 20, Koa 2, `ws` for the upstream WebSocket. No model weights, no
database. The credentials file from `claude login` must be present and valid -
the service reads and refreshes against it; check `/health` for token status.
