// Anthropic voice_stream speech-to-text WebSocket client.
//
// Opens a WS to Anthropic's voice_stream endpoint, relays PCM audio,
// receives transcript chunks, and translates to our transcriber protocol.
//
// Wire protocol (from Claude Code voiceStreamSTT.ts):
//   URL: wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
//   Query: encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300
//          &utterance_end_ms=1000&language=<lang>
//   Auth: Authorization: Bearer <oauth_token>
//   Client sends: binary PCM frames + {"type":"KeepAlive"} (8s) + {"type":"CloseStream"}
//   Server sends: TranscriptText{data}, TranscriptEndpoint, TranscriptError

import WebSocket from 'ws';
import { ClaudeCredentials } from './claude-credentials.js';

const VOICE_STREAM_BASE = 'wss://api.anthropic.com';
const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream';

const KEEPALIVE_INTERVAL_MS = 8000;
const FINALIZE_TIMEOUT_MS = 5000;

const SUPPORTED_LANGUAGES = new Set([
  'en', 'es', 'fr', 'ja', 'de', 'pt', 'it', 'nl', 'hi',
  'ko', 'pl', 'ru', 'tr', 'uk', 'zh', 'cs', 'da', 'sv', 'no',
]);

export function isLanguageSupported(lang) {
  return SUPPORTED_LANGUAGES.has(lang);
}

export class AnthropicSession {
  constructor(callbacks) {
    // callbacks: { onTranscript(text, isFinal), onError(message), onClose() }
    this.callbacks = callbacks;
    this.ws = null;
    this.keepaliveTimer = null;
    this.connected = false;
    this.finalized = false;
    this.lastTranscriptText = '';
    this.resolveFinalize = null;
  }

  async start(language = 'en') {
    const token = await ClaudeCredentials.getValidToken();

    const params = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      // 300ms was too aggressive: natural Russian conversational pauses
      // (mid-sentence breaths) tripped TranscriptEndpoint inside one logical
      // utterance, splitting it into multiple finals. 700ms covers normal
      // micro-pauses while still endpointing fast enough to feel responsive.
      endpointing_ms: '700',
      utterance_end_ms: '1000',
      language: language,
    });

    const url = `${VOICE_STREAM_BASE}${VOICE_STREAM_PATH}?${params.toString()}`;
    console.log(`[anthropic-session] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Anthropic WS connect timeout (10s)'));
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      }, 10000);

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'anthropic-stt-service/1.0',
          'x-app': 'cli',
        },
      });

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        console.log('[anthropic-session] Connected');
        this.connected = true;

        // Initial KeepAlive
        this.ws.send('{"type":"KeepAlive"}');

        // Periodic keepalive
        this.keepaliveTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('{"type":"KeepAlive"}');
          }
        }, KEEPALIVE_INTERVAL_MS);

        resolve();
      });

      this.ws.on('message', (raw) => {
        const text = raw.toString();
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }

        switch (msg.type) {
          case 'TranscriptText': {
            const transcript = msg.data;
            if (transcript) {
              this.lastTranscriptText = transcript;
              console.log(`[anthropic-session] interim (partial) len=${transcript.length}: ${transcript.slice(0, 60)}`);
              this.callbacks.onTranscript(transcript, false);
            }
            break;
          }
          case 'TranscriptEndpoint': {
            const finalText = this.lastTranscriptText;
            this.lastTranscriptText = '';
            if (finalText) {
              this.callbacks.onTranscript(finalText, true);
            }
            // If we sent CloseStream and got endpoint back, resolve finalize
            if (this.finalized && this.resolveFinalize) {
              this.resolveFinalize();
              this.resolveFinalize = null;
            }
            break;
          }
          case 'TranscriptError': {
            const desc = msg.description || msg.error_code || 'unknown transcription error';
            console.error(`[anthropic-session] TranscriptError: ${desc}`);
            this.callbacks.onError(desc);
            break;
          }
          case 'error': {
            const detail = msg.message || JSON.stringify(msg);
            console.error(`[anthropic-session] Server error: ${detail}`);
            this.callbacks.onError(detail);
            break;
          }
        }
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '';
        console.log(`[anthropic-session] WS closed: code=${code} reason="${reasonStr}"`);
        clearTimeout(connectTimeout);
        this.connected = false;
        this._clearKeepalive();

        // Promote unreported interim
        if (this.lastTranscriptText) {
          const t = this.lastTranscriptText;
          this.lastTranscriptText = '';
          this.callbacks.onTranscript(t, true);
        }

        // Resolve any pending finalize
        if (this.resolveFinalize) {
          this.resolveFinalize();
          this.resolveFinalize = null;
        }

        this.callbacks.onClose();
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        console.error(`[anthropic-session] WS error: ${err.message}`);
        if (!this.connected) {
          reject(err);
        } else {
          this.callbacks.onError(`Connection error: ${err.message}`);
        }
      });

      // Handle HTTP upgrade rejection (non-101)
      this.ws.on('unexpected-response', (req, res) => {
        clearTimeout(connectTimeout);
        const status = res.statusCode || 0;
        console.error(`[anthropic-session] Upgrade rejected: HTTP ${status}`);
        res.resume();
        req.destroy();
        reject(new Error(`WebSocket upgrade rejected with HTTP ${status}`));
      });
    });
  }

  feedAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.finalized) {
      return;
    }
    // Copy buffer to avoid shared memory issues with NAPI buffers
    this.ws.send(Buffer.from(buffer));
  }

  async stop() {
    if (this.finalized) return;
    this.finalized = true;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log('[anthropic-session] Sending CloseStream');
    this.ws.send('{"type":"CloseStream"}');

    // Wait for TranscriptEndpoint or timeout
    await new Promise((resolve) => {
      this.resolveFinalize = resolve;
      setTimeout(() => {
        if (this.resolveFinalize) {
          console.log('[anthropic-session] Finalize timeout, promoting last interim');
          // Promote any remaining interim
          if (this.lastTranscriptText) {
            const t = this.lastTranscriptText;
            this.lastTranscriptText = '';
            this.callbacks.onTranscript(t, true);
          }
          this.resolveFinalize = null;
          resolve();
        }
      }, FINALIZE_TIMEOUT_MS);
    });
  }

  close() {
    this.finalized = true;
    this._clearKeepalive();
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  _clearKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
