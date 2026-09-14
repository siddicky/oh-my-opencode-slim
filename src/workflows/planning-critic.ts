import { z } from 'zod';

export type CriticResult = {
  readonly verdict: 'accept' | 'revise' | 'blocked';
  readonly findings: readonly string[];
  readonly artifactDigest: string;
};

const CriticResultSchema = z
  .object({
    verdict: z.enum(['accept', 'revise', 'blocked']),
    findings: z.array(z.string().trim().min(1)),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.verdict !== 'accept' && review.findings.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'revise and blocked reviews require findings',
        path: ['findings'],
      });
    }
  });

export function extractJsonPayload(text: string): string {
  const direct = text.trim();
  if (direct.startsWith('{')) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(text);
  if (fence?.[1]?.trim().startsWith('{')) {
    return fence[1]?.trim() ?? direct;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return direct;
}

const ENVELOPE_KEYS = [
  'workflow',
  'definition',
  'plan',
  'critique',
  'result',
  'review',
] as const;

function unwrapEnvelope(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of ENVELOPE_KEYS) {
    const inner = record[key];
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return unwrapEnvelope(inner);
    }
  }
  return value;
}

export function parseJsonPayload(text: string): unknown {
  return unwrapEnvelope(JSON.parse(extractJsonPayload(text)));
}

export function normalizeDefinitionPayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) return value;
  return {
    ...record,
    nodes: record.nodes.map((node) => {
      if (
        node === null ||
        typeof node !== 'object' ||
        Array.isArray(node)
      ) {
        return node;
      }
      const nodeRecord = node as Record<string, unknown>;
      if (!Array.isArray(nodeRecord.dependsOn)) return node;
      return {
        ...nodeRecord,
        dependsOn: (nodeRecord.dependsOn as unknown[]).filter(
          (dep): dep is string =>
            typeof dep === 'string' && dep.trim().length > 0,
        ),
      };
    }),
  };
}

export function parseCriticResult(text: string): CriticResult {
  return CriticResultSchema.parse(parseJsonPayload(text));
}
