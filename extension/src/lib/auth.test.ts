import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { auth, getAuthState } from './auth';

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const mock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function seedSession(): Promise<void> {
  await fakeBrowser.storage.local.set({
    apiBaseUrl: 'http://api.test',
    authSession: { sessionToken: 'session-jwt', email: 'a@b.test' },
  });
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('returns null and never fetches when signed out', async () => {
  const mock = stubFetch();
  expect(await auth.getAccessToken()).toBeNull();
  expect(mock).not.toHaveBeenCalled();
});

it('fetches once and serves the second call from cache', async () => {
  await seedSession();
  const mock = stubFetch(
    new Response(JSON.stringify({ accessToken: 'at-1', expiresIn: 3600 }), { status: 200 }),
  );

  expect(await auth.getAccessToken()).toBe('at-1');
  expect(await auth.getAccessToken()).toBe('at-1');
  expect(mock).toHaveBeenCalledTimes(1);
});

it('forceRefresh bypasses the cache', async () => {
  await seedSession();
  const mock = stubFetch(
    new Response(JSON.stringify({ accessToken: 'at-1', expiresIn: 3600 }), { status: 200 }),
    new Response(JSON.stringify({ accessToken: 'at-2', expiresIn: 3600 }), { status: 200 }),
  );

  expect(await auth.getAccessToken()).toBe('at-1');
  expect(await auth.getAccessToken(true)).toBe('at-2');
  expect(mock).toHaveBeenCalledTimes(2);
});

it('a 401 (invalid_grant) clears the stored session', async () => {
  await seedSession();
  stubFetch(new Response(JSON.stringify({ detail: 'invalid_grant' }), { status: 401 }));

  expect(await auth.getAccessToken()).toBeNull();
  expect((await getAuthState()).signedIn).toBe(false);
});
