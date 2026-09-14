import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approvePlan } from './approval';
import { createBunJournal } from './journal';
import type { RalplanResult } from './planning';

export async function persistTestApproval(
  plan: RalplanResult,
  projectID: string,
) {
  const directory = await mkdtemp(join(tmpdir(), 'planning-'));
  const journal = createBunJournal(join(directory, 'journal.sqlite'));
  const lease = journal.acquireLease(projectID, 'owner-task-10');
  if (lease === null) {
    journal.close();
    throw new Error('fixture failed to acquire journal lease');
  }
  const persistence = { journal, lease };
  const approval = approvePlan(
    plan,
    {
      approvedDigest: plan.approvalDigest,
      approvedBy: 'local-user',
      source: 'user-command',
    },
    persistence,
  );
  return { approval, directory, journal, persistence };
}
