import { afterEach, expect, it, vi } from 'vitest';
import { checkQuota, projectedBytes } from './quota';

function stubEstimate(usage: number, quota: number): void {
  vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage, quota }) } });
}

afterEach(() => vi.unstubAllGlobals());

it('refuses below the hard floor', async () => {
  stubEstimate(0, 400e6); // 400 MB free < 500 MB floor
  const check = await checkQuota('audio');
  expect(check.ok).toBe(false);
});

it('warns when a 2-hour recording would not comfortably fit', async () => {
  stubEstimate(0, projectedBytes('video')); // exactly 1x projected: above floor, below 1.5x
  const check = await checkQuota('video');
  expect(check.ok).toBe(true);
  expect(check.warning).toContain('2-hour');
});

it('stays quiet with plenty of space', async () => {
  stubEstimate(0, 100e9);
  const check = await checkQuota('video');
  expect(check.ok).toBe(true);
  expect(check.warning).toBeNull();
});

it('projects video much larger than audio', () => {
  expect(projectedBytes('video')).toBeGreaterThan(10 * projectedBytes('audio'));
});
