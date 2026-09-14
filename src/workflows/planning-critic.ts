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

export function parseCriticResult(text: string): CriticResult {
  return CriticResultSchema.parse(JSON.parse(text));
}
