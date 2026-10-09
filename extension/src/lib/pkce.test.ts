import { expect, it } from 'vitest';
import { challengeFor, generateVerifier } from './pkce';

it('computes the RFC 7636 S256 challenge', async () => {
  // Known vector: base64url(SHA-256("test"))
  expect(await challengeFor('test')).toBe('n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg');
});

it('generates url-safe verifiers of the right length', () => {
  const verifier = generateVerifier();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(generateVerifier()).not.toBe(verifier);
});
