import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { transition } from './transition';
import type { Job, JobEvent } from './types';

interface FixtureCase {
  name: string;
  before: Partial<Job>;
  event: JobEvent;
  after: Partial<Job>;
}

interface Fixtures {
  defaults: Job;
  cases: FixtureCase[];
}

const fixtures: Fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../shared/fixtures/transitions.json', import.meta.url)),
    'utf-8',
  ),
);

describe('transition (shared fixtures, mirrored by backend/tests/test_transitions.py)', () => {
  for (const fixtureCase of fixtures.cases) {
    it(fixtureCase.name, () => {
      const job: Job = { ...fixtures.defaults, ...fixtureCase.before };
      const expected: Job = { ...job, ...fixtureCase.after };
      expect(transition(job, fixtureCase.event)).toEqual(expected);
    });
  }
});
