import Dexie, { type EntityTable } from 'dexie';
import type { Job } from './state/types';

export const db = new Dexie('tab-recorder') as Dexie & {
  jobs: EntityTable<Job, 'jobId'>;
};

db.version(1).stores({
  jobs: 'jobId, localStatus, createdAt',
});
