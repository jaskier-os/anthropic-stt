// Read-only OAuth token loader.
// NEVER refreshes tokens -- host cron job handles that.
// Reads from ~/.claude/.credentials.json (same file Claude Code maintains).

import fs from 'fs';
import os from 'os';
import path from 'path';

const CREDENTIALS_PATH = process.env.CLAUDE_CREDENTIALS_PATH
  || path.join(os.homedir(), '.claude', '.credentials.json');

// 5 minute buffer before expiration (matches Claude Code client.ts:344)
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

class ClaudeCredentials {
  static cachedToken = null;

  static async load() {
    try {
      const content = await fs.promises.readFile(CREDENTIALS_PATH, 'utf-8');
      const data = JSON.parse(content);
      return data.claudeAiOauth;
    } catch (error) {
      console.error('[claude-credentials] Failed to load:', error.message);
      return null;
    }
  }

  static isExpired(credentials) {
    if (!credentials?.expiresAt) return true;
    return (Date.now() + EXPIRY_BUFFER_MS) >= credentials.expiresAt;
  }

  static async getValidToken() {
    // 1. Check memory cache
    if (this.cachedToken && !this.isExpired(this.cachedToken)) {
      return this.cachedToken.accessToken;
    }

    // 2. Load from disk
    const creds = await this.load();
    if (!creds) {
      throw new Error('Claude credentials not found. Run: claude login');
    }

    // 3. If expired, throw -- cron will refresh
    if (this.isExpired(creds)) {
      throw new Error('OAuth token expired. Waiting for cron refresh.');
    }

    // 4. Cache and return
    this.cachedToken = creds;
    return creds.accessToken;
  }

  static async getTokenStatus() {
    const creds = await this.load();
    if (!creds) return { exists: false, expired: true, expiresAt: null };
    return {
      exists: true,
      expired: this.isExpired(creds),
      expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
      minutesUntilExpiry: creds.expiresAt
        ? Math.round((creds.expiresAt - Date.now()) / 60000)
        : null,
    };
  }
}

export { ClaudeCredentials };
