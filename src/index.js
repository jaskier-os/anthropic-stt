// Anthropic STT Service -- HTTP streaming
//
// Endpoints:
//   GET  /health           Service + OAuth token status.
//   POST /transcribe       One-shot transcription (WAV in, JSON out). Used by
//                          the orchestrator gateway for file-based transcription.
//   POST /v1/transcribe    Streaming transcription. Chunked PCM16LE @ 16kHz mono
//                          in, text/event-stream out. The orchestrator opens this
//                          per utterance, writes audio frames as they arrive from
//                          the phone, and half-closes the request body to signal
//                          end-of-utterance. SSE events: partial, final, error.
//
// The previous WebSocket bridge to the orchestrator (/ws/anthropic-stt) has been
// removed. Per-utterance HTTP eliminates the persistent-bridge flap class and lets
// this pod scale/restart without coupling the orchestrator's lifecycle.

import 'dotenv/config';
import crypto from 'crypto';
import http from 'http';
import Koa from 'koa';
import config from './config.js';
import { AnthropicSession } from './anthropic-session.js';
import { ClaudeCredentials } from './claude-credentials.js';

const app = new Koa();

app.use(async (ctx, next) => {
  if (ctx.path === '/transcribe' && ctx.method === 'POST') {
    const chunks = [];
    for await (const chunk of ctx.req) chunks.push(chunk);
    ctx.rawBody = Buffer.concat(chunks);
  }
  await next();
});

app.use(async (ctx) => {
  if (ctx.path === '/health' && ctx.method === 'GET') {
    const tokenStatus = await ClaudeCredentials.getTokenStatus();
    ctx.body = { service: 'anthropic-stt', status: 'ok', oauth: tokenStatus };
    return;
  }

  if (ctx.path === '/v1/transcribe' && ctx.method === 'POST') {
    await handleStreamTranscribe(ctx);
    return;
  }

  if (ctx.path === '/transcribe' && ctx.method === 'POST') {
    const language = ctx.query.language || 'en';
    const audioBuffer = ctx.rawBody;
    if (!audioBuffer || audioBuffer.length === 0) {
      ctx.status = 400;
      ctx.body = { error: 'No audio data' };
      return;
    }
    console.log(`[oneshot] ${audioBuffer.length} bytes lang=${language}`);
    try {
      const result = await transcribeOneShot(audioBuffer, language);
      ctx.body = { text: result.text, language };
    } catch (err) {
      console.error(`[oneshot] failed: ${err.message}`);
      ctx.status = 500;
      ctx.body = { error: err.message };
    }
    return;
  }

  ctx.status = 404;
  ctx.body = { error: 'Not found' };
});

async function handleStreamTranscribe(ctx) {
  const lang = (ctx.query.lang || ctx.query.language || 'en').toString();
  const turnId = (ctx.query.turnId || ctx.get('x-turn-id') || '').toString() || `t_${crypto.randomUUID()}`;
  const tag = `[stream ${turnId}]`;
  console.log(`${tag} open lang=${lang}`);

  // Take over the response. Headers are deferred until either the upstream is
  // confirmed up (200 + SSE) or it has failed (502 + JSON). This way a 200 from
  // this service actually means STT is working.
  ctx.respond = false;
  const res = ctx.res;

  let session = null;
  let upstreamReady = false;
  let ended = false;
  let endRequested = false;
  let audioFrameCount = 0;
  let bytesIn = 0;
  const pendingChunks = [];

  function sse(event, data) {
    if (ended || !upstreamReady) return;
    try {
      res.write(`id: ${turnId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error(`${tag} sse write failed: ${err.message}`);
    }
  }

  function endResponse() {
    if (ended) return;
    ended = true;
    try { res.end(); } catch {}
  }

  async function teardownSession() {
    if (!session) return;
    try { await session.stop(); } catch (err) {
      console.error(`${tag} session.stop in teardown failed: ${err.message}`);
    }
    try { session.close(); } catch {}
    session = null;
  }

  // Wire body listeners FIRST so audio that arrives before the upstream handshake
  // completes is buffered, not lost.
  ctx.req.on('data', (chunk) => {
    bytesIn += chunk.length;
    audioFrameCount++;
    if (audioFrameCount % 200 === 1) {
      console.log(`${tag} audio in: frame=${audioFrameCount} totalBytes=${bytesIn}`);
    }
    if (!upstreamReady) {
      pendingChunks.push(Buffer.from(chunk));
      return;
    }
    try { session.feedAudio(chunk); } catch (err) {
      console.error(`${tag} feedAudio failed: ${err.message}`);
    }
  });

  ctx.req.on('end', async () => {
    endRequested = true;
    if (!upstreamReady) {
      // Upstream hasn't come up yet; the post-start path will finalize.
      console.log(`${tag} request body ended pre-upstream; will finalize after start resolves`);
      return;
    }
    console.log(`${tag} request body ended; closing upstream after ${audioFrameCount} frames / ${bytesIn} bytes`);
    try {
      await session.stop();
    } catch (err) {
      console.error(`${tag} session.stop failed: ${err.message}`);
      sse('error', { message: `stop-failed: ${err.message}`, retryable: false, turnId });
    }
    try { session?.close(); } catch {}
    session = null;
    endResponse();
  });

  ctx.req.on('aborted', async () => {
    console.warn(`${tag} client aborted after ${bytesIn} bytes`);
    await teardownSession();
    endResponse();
  });

  ctx.req.on('error', async (err) => {
    console.error(`${tag} request error: ${err.message}`);
    await teardownSession();
    endResponse();
  });

  res.on('close', async () => {
    if (ended) return;
    console.warn(`${tag} response closed by peer`);
    ended = true;
    // Close the upstream cleanly so Anthropic's WS doesn't linger.
    await teardownSession();
  });

  // Bring the upstream up. On failure, return 502 (response is still virgin).
  try {
    session = new AnthropicSession({
      onTranscript: (text, isFinal) => {
        sse(isFinal ? 'final' : 'partial', { text, turnId });
      },
      onError: (message) => {
        console.error(`${tag} session error: ${message}`);
        sse('error', { message, retryable: true, turnId });
      },
      onClose: () => {
        // Response lifecycle is driven from the request side.
      },
    });
    await session.start(lang);
  } catch (err) {
    console.error(`${tag} upstream start failed: ${err.message}`);
    try { session?.close(); } catch {}
    session = null;
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream-start-failed', message: err.message, turnId }));
    } else {
      // Headers were already sent (shouldn't happen on this path, but be safe).
      sse('error', { message: `upstream-start: ${err.message}`, retryable: false, turnId });
      endResponse();
    }
    ended = true;
    return;
  }

  // Upstream is up. Commit to a 200 SSE response.
  console.log(`${tag} upstream connected`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Turn-Id': turnId,
  });
  res.write(`: open ${turnId}\n\n`);
  upstreamReady = true;

  // Drain any audio that arrived during the handshake.
  if (pendingChunks.length) {
    console.log(`${tag} flushing ${pendingChunks.length} buffered chunk(s) (${pendingChunks.reduce((n, b) => n + b.length, 0)} bytes)`);
    for (const chunk of pendingChunks) {
      try { session.feedAudio(chunk); } catch (err) {
        console.error(`${tag} feedAudio replay failed: ${err.message}`);
        break;
      }
    }
    pendingChunks.length = 0;
  }

  // If end-of-body fired while we were connecting, finalize now.
  if (endRequested) {
    console.log(`${tag} replaying deferred end-of-body`);
    try { await session.stop(); } catch (err) {
      console.error(`${tag} session.stop (deferred) failed: ${err.message}`);
      sse('error', { message: `stop-failed: ${err.message}`, retryable: false, turnId });
    }
    try { session?.close(); } catch {}
    session = null;
    endResponse();
  }
}

async function transcribeOneShot(audioBuffer, language) {
  let pcmData = audioBuffer;
  if (audioBuffer.length > 44 &&
      audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49 &&
      audioBuffer[2] === 0x46 && audioBuffer[3] === 0x46) {
    pcmData = audioBuffer.subarray(44);
  }

  let finalText = '';
  let resolved = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { session.close(); } catch {}
        if (finalText) resolve({ text: finalText });
        else reject(new Error('Transcription timeout (15s)'));
      }
    }, 15000);

    const session = new AnthropicSession({
      onTranscript: (text, isFinal) => {
        if (isFinal) finalText = (finalText ? finalText + ' ' : '') + text;
      },
      onError: (message) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try { session.close(); } catch {}
          reject(new Error(message));
        }
      },
      onClose: () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ text: finalText });
        }
      },
    });

    session.start(language)
      .then(async () => {
        const CHUNK_SIZE = 3200;
        const CHUNK_INTERVAL_MS = 25;
        let chunkCount = 0;
        for (let i = 0; i < pcmData.length; i += CHUNK_SIZE) {
          const chunk = pcmData.subarray(i, Math.min(i + CHUNK_SIZE, pcmData.length));
          session.feedAudio(chunk);
          chunkCount++;
          if (chunkCount % 4 === 0) await new Promise(r => setTimeout(r, CHUNK_INTERVAL_MS));
        }
        await new Promise(r => setTimeout(r, 2000));
        return session.stop();
      })
      .then(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try { session.close(); } catch {}
          resolve({ text: finalText });
        }
      })
      .catch((err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try { session.close(); } catch {}
          reject(err);
        }
      });
  });
}

const server = http.createServer(app.callback());
server.listen(config.port, () => {
  console.log(`[anthropic-stt] HTTP server on port ${config.port} (streaming HTTP, no WS bridge)`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('[anthropic-stt] Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
