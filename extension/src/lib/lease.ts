// Single-flight lock backed by chrome.storage.session: two service-worker
// wakeups (alarm + online event + popup kick) must never upload the same job
// concurrently. The lease expires on its own, so a crashed holder never wedges
// the queue.

export interface Lease {
  key: string;
  id: string;
  expiresAt: number;
}

interface StoredLease {
  id: string;
  expiresAt: number;
}

const PREFIX = 'lease:';

export async function acquireLease(key: string, ttlMs: number): Promise<Lease | null> {
  const storageKey = PREFIX + key;
  const now = Date.now();
  const existing = (await browser.storage.session.get(storageKey))[storageKey] as
    | StoredLease
    | undefined;
  if (existing && existing.expiresAt > now) return null;

  const candidate: StoredLease = { id: crypto.randomUUID(), expiresAt: now + ttlMs };
  await browser.storage.session.set({ [storageKey]: candidate });

  // Read back: if two contexts raced, exactly one id survived the last write.
  const winner = (await browser.storage.session.get(storageKey))[storageKey] as
    | StoredLease
    | undefined;
  if (winner?.id !== candidate.id) return null;
  return { key, id: candidate.id, expiresAt: candidate.expiresAt };
}

export async function renewLease(lease: Lease, ttlMs: number): Promise<boolean> {
  const storageKey = PREFIX + lease.key;
  const current = (await browser.storage.session.get(storageKey))[storageKey] as
    | StoredLease
    | undefined;
  if (current?.id !== lease.id) return false;
  const renewed: StoredLease = { id: lease.id, expiresAt: Date.now() + ttlMs };
  await browser.storage.session.set({ [storageKey]: renewed });
  lease.expiresAt = renewed.expiresAt;
  return true;
}

export async function releaseLease(lease: Lease): Promise<void> {
  const storageKey = PREFIX + lease.key;
  const current = (await browser.storage.session.get(storageKey))[storageKey] as
    | StoredLease
    | undefined;
  if (current?.id === lease.id) {
    await browser.storage.session.remove(storageKey);
  }
}
