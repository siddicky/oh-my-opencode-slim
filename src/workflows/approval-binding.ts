import { z } from 'zod';

import type { ExpansionEnvelope } from './graph';
import type { RalplanResult } from './planning';
import { canonicalDigest } from './profiles';

export type StoredPlanApproval = {
  readonly version: 1;
  readonly planId: string;
  readonly approvedDigest: string;
  readonly approvedBy: string;
  readonly specSha256: string;
  readonly planSource: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly plannerProfileDigest: string;
  readonly criticProfileDigest: string;
  readonly capabilityDigest: string;
  readonly reviewerAgent: string;
  readonly policyDigest: string;
  readonly checksDigest: string;
  readonly scopesDigest: string;
  readonly expansionEnvelope: ExpansionEnvelope;
};

export type LaunchAuthority = {
  readonly specSha256: string;
  readonly planSource: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly plannerProfileDigest: string;
  readonly criticProfileDigest: string;
  readonly capabilityDigest: string;
  readonly reviewerAgent: string;
  readonly policyDigest: string;
  readonly checksDigest: string;
  readonly scopesDigest: string;
  readonly expansionEnvelope: ExpansionEnvelope;
  readonly workspaceClean: boolean;
  readonly multiCriticOverride?: string;
  readonly requestedAdditionalNodes?: number;
  readonly requestedWritePaths?: readonly string[];
};

const StoredPlanApprovalSchema = z
  .object({
    version: z.literal(1),
    planId: z.string().trim().min(1),
    approvedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approvedBy: z.string().trim().min(1),
    specSha256: z.string().regex(/^[a-f0-9]{64}$/),
    planSource: z.string().trim().min(1),
    projectRoot: z.string().trim().min(1),
    baseCommit: z.string().trim().min(1),
    plannerProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    criticProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    capabilityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reviewerAgent: z.string().trim().min(1),
    policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    checksDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    scopesDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expansionEnvelope: z
      .object({
        maxAdditionalNodes: z.number().int().nonnegative(),
        allowedWritePaths: z.array(z.string().trim().min(1)),
      })
      .strict(),
  })
  .strict();

export function approvalChecksDigest(plan: RalplanResult): string {
  return canonicalDigest(
    plan.compiled.definition.nodes.map((node) => ({
      nodeId: node.id,
      checks: node.checks,
    })),
  );
}

export function approvalScopesDigest(plan: RalplanResult): string {
  return canonicalDigest(
    plan.compiled.definition.nodes.map((node) => ({
      nodeId: node.id,
      allowedWritePaths: node.allowedWritePaths,
    })),
  );
}

export function expectedPlanApproval(
  plan: RalplanResult,
  approvedBy: string,
): StoredPlanApproval {
  return {
    version: 1,
    planId: plan.compiled.definition.planId,
    approvedDigest: plan.approvalDigest,
    approvedBy,
    specSha256: plan.binding.specSha256,
    planSource: plan.binding.source,
    projectRoot: plan.binding.projectRoot,
    baseCommit: plan.binding.baseCommit,
    plannerProfileDigest: plan.binding.plannerProfileDigest,
    criticProfileDigest: plan.binding.criticProfileDigest,
    capabilityDigest: plan.binding.capabilityDigest,
    reviewerAgent: plan.binding.reviewerAgent,
    policyDigest: plan.compiled.policyDigest,
    checksDigest: approvalChecksDigest(plan),
    scopesDigest: approvalScopesDigest(plan),
    expansionEnvelope: plan.compiled.expansionEnvelope,
  };
}

export function parseStoredPlanApproval(
  input: StoredPlanApproval,
): StoredPlanApproval {
  return StoredPlanApprovalSchema.parse(input);
}

export function authorityBinding(authority: LaunchAuthority) {
  return {
    specSha256: authority.specSha256,
    planSource: authority.planSource,
    projectRoot: authority.projectRoot,
    baseCommit: authority.baseCommit,
    plannerProfileDigest: authority.plannerProfileDigest,
    criticProfileDigest: authority.criticProfileDigest,
    capabilityDigest: authority.capabilityDigest,
    reviewerAgent: authority.reviewerAgent,
    policyDigest: authority.policyDigest,
    checksDigest: authority.checksDigest,
    scopesDigest: authority.scopesDigest,
    expansionEnvelope: authority.expansionEnvelope,
  };
}

export function pathAuthorized(
  requestedPath: string,
  permittedPaths: readonly string[],
): boolean {
  return permittedPaths.some((approvedPath) =>
    approvedPath.endsWith('/**')
      ? requestedPath.startsWith(approvedPath.slice(0, -2))
      : requestedPath === approvedPath,
  );
}
