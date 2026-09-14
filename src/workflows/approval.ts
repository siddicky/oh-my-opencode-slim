import {
  authorityBinding,
  expectedPlanApproval,
  type LaunchAuthority,
  parseStoredPlanApproval,
  pathAuthorized,
  type StoredPlanApproval,
} from './approval-binding';
import { compileWorkflow } from './graph';
import type { JournalLease, WorkflowJournal } from './journal';
import { computePlanApprovalDigest, type RalplanResult } from './planning';
import { canonicalDigest } from './profiles';
import { WorkflowApprovalSchema } from './schema';

export {
  approvalChecksDigest,
  approvalScopesDigest,
  type LaunchAuthority,
  type StoredPlanApproval,
} from './approval-binding';

export type ApprovalCommand = {
  readonly approvedDigest: string;
  readonly approvedBy: string;
  readonly source: 'user-command' | 'model-output';
};

export type ApprovalPersistence = {
  readonly journal: WorkflowJournal;
  readonly lease: JournalLease;
};

export class PlanApprovalError extends Error {
  readonly name = 'PlanApprovalError';

  constructor(
    readonly code:
      | 'approval_forged'
      | 'approval_required'
      | 'authority_changed'
      | 'expansion_exceeded'
      | 'invalid_plan'
      | 'reviewer_changed',
    message: string,
  ) {
    super(message);
  }
}

export function approvePlan(
  plan: RalplanResult,
  command: ApprovalCommand,
  persistence: ApprovalPersistence,
): StoredPlanApproval {
  if (command.source !== 'user-command') {
    throw new PlanApprovalError(
      'approval_required',
      'model output cannot grant plan approval',
    );
  }
  if (
    command.approvedDigest !== plan.approvalDigest ||
    plan.approvalDigest !== computePlanApprovalDigest(plan)
  ) {
    throw new PlanApprovalError(
      'approval_forged',
      'approval digest does not match the reviewed plan',
    );
  }
  const base = WorkflowApprovalSchema.parse({
    planId: plan.compiled.definition.planId,
    approvedDigest: command.approvedDigest,
    approvedBy: command.approvedBy,
  });
  const approval = expectedPlanApproval(plan, base.approvedBy);
  persistence.journal.transaction(persistence.lease, (transaction) => {
    transaction.persistState('approval', base.planId, approval);
  });
  return approval;
}

export function validatePlanLaunch(
  plan: RalplanResult,
  approvalInput: StoredPlanApproval,
  authority: LaunchAuthority,
): void {
  const recompiled = compileWorkflow(
    plan.compiled.definition,
    plan.compiled.expansionEnvelope,
  );
  if (
    recompiled.canonicalJson !== plan.compiled.canonicalJson ||
    recompiled.definitionDigest !== plan.compiled.definitionDigest ||
    recompiled.policySource !== plan.compiled.policySource ||
    recompiled.policyDigest !== plan.compiled.policyDigest ||
    recompiled.markdown !== plan.compiled.markdown ||
    recompiled.markdownDigest !== plan.compiled.markdownDigest ||
    plan.approvalDigest !== computePlanApprovalDigest(plan)
  ) {
    throw new PlanApprovalError(
      'invalid_plan',
      'compiled plan artifacts changed',
    );
  }
  const approval = parseStoredPlanApproval(approvalInput);
  const expected = expectedPlanApproval(plan, approval.approvedBy);
  if (canonicalDigest(approval) !== canonicalDigest(expected)) {
    throw new PlanApprovalError(
      'approval_forged',
      'stored approval does not match the reviewed plan',
    );
  }
  if (
    !authority.workspaceClean ||
    canonicalDigest(authorityBinding(authority)) !==
      canonicalDigest(authorityBinding({ ...authority, ...expected }))
  ) {
    throw new PlanApprovalError(
      'authority_changed',
      'local launch authority differs from stored approval',
    );
  }
  if (
    authority.multiCriticOverride !== undefined &&
    authority.multiCriticOverride !== approval.reviewerAgent
  ) {
    throw new PlanApprovalError(
      'reviewer_changed',
      'critic override requires revised approval',
    );
  }
  if (
    (authority.requestedAdditionalNodes ?? 0) >
    approval.expansionEnvelope.maxAdditionalNodes
  ) {
    throw new PlanApprovalError(
      'expansion_exceeded',
      'requested nodes exceed the approved expansion envelope',
    );
  }
  if (
    (authority.requestedWritePaths ?? []).some(
      (path) =>
        !pathAuthorized(path, approval.expansionEnvelope.allowedWritePaths),
    )
  ) {
    throw new PlanApprovalError(
      'expansion_exceeded',
      'requested write path is outside the approved expansion envelope',
    );
  }
}
