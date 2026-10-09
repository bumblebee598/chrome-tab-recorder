// Google OAuth for the extension. The authorization-code + PKCE flow runs in
// launchWebAuthFlow; the backend exchanges the code (it holds the client
// secret), stores the encrypted refresh token, and hands back a session JWT.
// From then on the extension asks the backend for short-lived Drive access
// tokens and caches them in storage.session.

import { getApiBase } from './api';
import { DEFAULT_API_BASE, GOOGLE_CLIENT_ID, OAUTH_SCOPES } from './config';
import { db } from './db';
import { applyEvent, nowIso } from './jobs';
import { challengeFor, generateVerifier } from './pkce';

const SESSION_KEY = 'authSession';
const ACCESS_KEY = 'accessTokenCache';

interface AuthSession {
  sessionToken: string;
  email: string;
}

interface AccessCache {
  token: string;
  expiresAt: number;
}

export interface TokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string | null>;
}

async function readSession(): Promise<AuthSession | null> {
  const stored = await browser.storage.local.get(SESSION_KEY);
  return (stored[SESSION_KEY] as AuthSession | undefined) ?? null;
}

export async function getAuthState(): Promise<{ signedIn: boolean; email: string | null }> {
  const session = await readSession();
  return { signedIn: session !== null, email: session?.email ?? null };
}

export async function signOut(): Promise<void> {
  await browser.storage.local.remove(SESSION_KEY);
  await browser.storage.session.remove(ACCESS_KEY);
}

export async function signIn(): Promise<{ email: string }> {
  const apiBase = await getApiBase();
  if (!apiBase) {
    throw new Error('Backend URL not configured — set WXT_API_BASE_URL in extension/.env');
  }
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Google client ID not configured — set WXT_GOOGLE_CLIENT_ID in extension/.env');
  }

  // Must match the Authorized redirect URI registered in the GCP console
  // character-for-character (including the trailing slash).
  const redirectUri = browser.identity.getRedirectURL();
  const verifier = generateVerifier();
  const challenge = await challengeFor(verifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const resultUrl = await browser.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  const code = resultUrl ? new URL(resultUrl).searchParams.get('code') : null;
  if (!code) throw new Error('Google sign-in was cancelled');

  const response = await fetch(`${apiBase}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed (backend returned HTTP ${response.status})`);
  }
  const body = (await response.json()) as { sessionToken: string; email: string };

  await browser.storage.local.set({
    [SESSION_KEY]: { sessionToken: body.sessionToken, email: body.email },
  });
  await browser.storage.session.remove(ACCESS_KEY);
  await resumePausedJobs();
  return { email: body.email };
}

async function resumePausedJobs(): Promise<void> {
  const paused = await db.jobs.where('localStatus').equals('needs_sign_in').toArray();
  for (const job of paused) {
    await applyEvent(job.jobId, { type: 'SIGNED_IN', occurredAt: nowIso() });
  }
}

export const auth: TokenProvider = {
  async getAccessToken(forceRefresh = false): Promise<string | null> {
    if (!forceRefresh) {
      const cached = (await browser.storage.session.get(ACCESS_KEY))[ACCESS_KEY] as
        | AccessCache
        | undefined;
      if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    }

    const session = await readSession();
    if (!session) return null;
    const apiBase = await getApiBase();
    if (!apiBase) return null;

    const response = await fetch(`${apiBase}/auth/access-token`, {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    }).catch(() => null);
    if (!response) return null;

    if (response.status === 401) {
      // invalid_grant (refresh token revoked/expired) or dead session JWT:
      // drop the session so the UI asks for a fresh consent.
      await signOut();
      return null;
    }
    if (!response.ok) return null;

    const body = (await response.json()) as { accessToken: string; expiresIn: number };
    const cache: AccessCache = {
      token: body.accessToken,
      expiresAt: Date.now() + Math.max(60, body.expiresIn - 60) * 1000,
    };
    await browser.storage.session.set({ [ACCESS_KEY]: cache });
    return body.accessToken;
  },
};

export { DEFAULT_API_BASE };
