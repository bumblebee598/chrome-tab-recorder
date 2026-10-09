import { beforeEach, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { acquireLease, releaseLease, renewLease } from './lease';

beforeEach(() => {
  fakeBrowser.reset();
});

it('grants a single lease at a time', async () => {
  const first = await acquireLease('queue', 60_000);
  expect(first).not.toBeNull();
  expect(await acquireLease('queue', 60_000)).toBeNull();
});

it('lets an expired lease be taken over', async () => {
  const stale = await acquireLease('queue', -1); // already expired
  expect(stale).not.toBeNull();
  const next = await acquireLease('queue', 60_000);
  expect(next).not.toBeNull();
  expect(next!.id).not.toBe(stale!.id);
});

it('renews only when still the owner', async () => {
  const lease = (await acquireLease('queue', -1))!;
  const thief = (await acquireLease('queue', 60_000))!;
  expect(await renewLease(lease, 60_000)).toBe(false);
  expect(await renewLease(thief, 60_000)).toBe(true);
});

it('release frees the lock for the next acquirer', async () => {
  const lease = (await acquireLease('queue', 60_000))!;
  await releaseLease(lease);
  expect(await acquireLease('queue', 60_000)).not.toBeNull();
});
