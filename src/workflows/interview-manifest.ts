import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export type DeepInterviewErrorCode =
  | 'interview_unavailable'
  | 'invalid_goal'
  | 'ownership_mismatch'
  | 'finalization_missing'
  | 'manifest_invalid'
  | 'manifest_hash_mismatch';

export class DeepInterviewError extends Error {
  override readonly name = 'DeepInterviewError';

  constructor(
    readonly code: DeepInterviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DeepInterviewSpecManifest {
  version: 1;
  interviewId: string;
  sessionID: string;
  specPath: string;
  specSha256: string;
  specBytes: number;
  interviewerAgent: string;
  finalizedAt: string;
}

export interface DeepInterviewFinalSpecInput {
  interviewId: string;
  sessionID: string;
  markdownPath: string;
  document: string;
}

const ManifestSchema = z.object({
  version: z.literal(1),
  interviewId: z.string().min(1),
  sessionID: z.string().min(1),
  specPath: z.string().min(1),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/),
  specBytes: z.number().int().positive(),
  interviewerAgent: z.string().min(1),
  finalizedAt: z.string().min(1),
});

const MANIFEST_SUFFIX = '.manifest.json';

function manifestPath(specPath: string): string {
  return `${specPath}${MANIFEST_SUFFIX}`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash the exact persisted spec bytes and write the sidecar manifest. */
export async function finalizeSpecManifest(
  event: DeepInterviewFinalSpecInput,
  interviewerAgent: string,
): Promise<DeepInterviewSpecManifest> {
  const bytes = Buffer.from(event.document, 'utf8');
  const manifest: DeepInterviewSpecManifest = {
    version: 1,
    interviewId: event.interviewId,
    sessionID: event.sessionID,
    specPath: event.markdownPath,
    specSha256: sha256Hex(bytes),
    specBytes: bytes.length,
    interviewerAgent,
    finalizedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    manifestPath(event.markdownPath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

/**
 * Read the sidecar manifest for a spec and verify it against the exact
 * current spec bytes. Any drift fails closed with a typed error.
 */
export async function loadFinalizedManifest(
  specPath: string,
): Promise<DeepInterviewSpecManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(specPath), 'utf8');
  } catch {
    throw new DeepInterviewError(
      'finalization_missing',
      `No finalized manifest for spec ${specPath}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DeepInterviewError(
      'manifest_invalid',
      `Manifest for ${specPath} is not valid JSON`,
    );
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DeepInterviewError(
      'manifest_invalid',
      `Manifest for ${specPath} does not match the v1 manifest schema`,
    );
  }
  const manifest = parsed.data as DeepInterviewSpecManifest;
  if (manifest.specPath !== specPath) {
    throw new DeepInterviewError(
      'manifest_invalid',
      `Manifest for ${specPath} records a different spec path: ${manifest.specPath}`,
    );
  }
  const bytes = await fs.readFile(specPath);
  const actualSha256 = sha256Hex(bytes);
  if (
    actualSha256 !== manifest.specSha256 ||
    bytes.length !== manifest.specBytes
  ) {
    throw new DeepInterviewError(
      'manifest_hash_mismatch',
      `Spec ${specPath} changed after finalization (sha256 ${actualSha256} != ${manifest.specSha256})`,
    );
  }
  return manifest;
}

export async function listFinalizedManifests(
  directory: string,
  outputFolder: string,
): Promise<DeepInterviewSpecManifest[]> {
  const outputDir = path.join(directory, outputFolder);
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return [];
  }
  const manifests: DeepInterviewSpecManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(MANIFEST_SUFFIX)) continue;
    const specPath = path.join(
      outputDir,
      entry.slice(0, -MANIFEST_SUFFIX.length),
    );
    manifests.push(await loadFinalizedManifest(specPath));
  }
  return manifests.sort((a, b) => a.specPath.localeCompare(b.specPath));
}
