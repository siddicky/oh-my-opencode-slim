import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  type ArtifactManifest,
  applyArtifactManifest,
  readSealedArtifact,
  type SealedArtifact,
} from './artifacts';

const WorkspaceMetadataSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['attempt', 'integration']),
    path: z.string(),
    projectRoot: z.string(),
    baseCommit: z.string(),
    runRoot: z.string(),
    metadataPath: z.string(),
    ownerToken: z.string(),
    generation: z.number().int().positive(),
    fencePath: z.string(),
    registryPath: z.string(),
    allowedWritePaths: z.array(z.string()),
    dependencyDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    status: z.enum(['active', 'quarantined']),
  })
  .strict();

const FenceSchema = z
  .object({
    workspaceId: z.string(),
    ownerToken: z.string(),
    generation: z.number().int().positive(),
    status: z.enum(['active', 'quarantined']),
  })
  .strict();

export type CanonicalProject = {
  readonly root: string;
  readonly baseCommit: string;
  readonly dependencyDigests: readonly string[];
  readonly gitExecutable: string;
  readonly gitTimeoutMs: number;
};

export type WorkspaceHandle = z.infer<typeof WorkspaceMetadataSchema>;

export class WorkspaceLifecycleError extends Error {
  readonly name = 'WorkspaceLifecycleError';

  constructor(
    readonly code:
      | 'git_failed'
      | 'invalid_project'
      | 'stale_generation'
      | 'ownership_mismatch'
      | 'stop_unconfirmed'
      | 'dirty_workspace'
      | 'uncertain_workspace'
      | 'integration_busy',
    message: string,
  ) {
    super(message);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '..') {
    throw new WorkspaceLifecycleError(
      'invalid_project',
      `${label} is not a safe path segment.`,
    );
  }
}

function assertWriteScopes(scopes: readonly string[]): void {
  for (const scope of scopes) {
    const portable = scope.replaceAll('\\', '/');
    if (
      scope.length === 0 ||
      scope.trim() !== scope ||
      portable.startsWith('/') ||
      /^[A-Za-z]:\//.test(portable) ||
      portable.split('/').includes('..')
    ) {
      throw new WorkspaceLifecycleError(
        'invalid_project',
        `Unsafe write scope: ${scope}`,
      );
    }
  }
}

function runGit(
  executable: string,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new WorkspaceLifecycleError(
      'git_failed',
      `Git command failed or timed out with status ${result.status ?? 'unknown'}: ${args.join(' ')}`,
    );
  }
  return result.stdout.trim();
}

export function bindCanonicalProject(input: {
  readonly callerPath: string;
  readonly approvedBase: string;
  readonly dependencyDigests?: readonly string[];
  readonly gitExecutable?: string;
  readonly gitTimeoutMs?: number;
}): CanonicalProject {
  const executable = input.gitExecutable ?? 'git';
  const timeoutMs = input.gitTimeoutMs ?? 10_000;
  const discovered = runGit(
    executable,
    input.callerPath,
    ['rev-parse', '--show-toplevel'],
    timeoutMs,
  );
  const root = realpathSync(discovered);
  const baseCommit = runGit(
    executable,
    root,
    ['rev-parse', '--verify', `${input.approvedBase}^{commit}`],
    timeoutMs,
  );
  const dependencyDigests = z
    .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    .parse(input.dependencyDigests ?? []);
  if (new Set(dependencyDigests).size !== dependencyDigests.length) {
    throw new WorkspaceLifecycleError(
      'invalid_project',
      'Accepted dependency digests must be unique.',
    );
  }
  return {
    root,
    baseCommit,
    dependencyDigests: dependencyDigests.sort(),
    gitExecutable: executable,
    gitTimeoutMs: timeoutMs,
  };
}

function matchingArrayEnd(source: string, property: string): number {
  const propertyIndex = source.indexOf(`"${property}"`);
  const start = source.indexOf('[', propertyIndex);
  if (propertyIndex < 0 || start < 0) {
    throw new WorkspaceLifecycleError(
      'invalid_project',
      `Registry lacks ${property} array.`,
    );
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new WorkspaceLifecycleError(
    'invalid_project',
    'Registry lanes array is unterminated.',
  );
}

function appendRegistryRecord(registryPath: string, record: object): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  if (!existsSync(registryPath)) {
    writeFileSync(registryPath, '{\n  "version": "1.0.0",\n  "lanes": []\n}\n');
  }
  const source = readFileSync(registryPath, 'utf8');
  const parsed = z
    .object({ lanes: z.array(z.unknown()) })
    .passthrough()
    .safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new WorkspaceLifecycleError('invalid_project', parsed.error.message);
  }
  const end = matchingArrayEnd(source, 'lanes');
  const separator = parsed.data.lanes.length === 0 ? '' : ',';
  const insertion = `${separator}\n    ${JSON.stringify(record)}\n  `;
  writeFileSync(
    registryPath,
    `${source.slice(0, end)}${insertion}${source.slice(end)}`,
  );
}

function writeFence(path: string, value: z.infer<typeof FenceSchema>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const current = FenceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (current.generation >= value.generation) {
      throw new WorkspaceLifecycleError(
        'stale_generation',
        `Generation ${value.generation} does not advance ${current.generation}.`,
      );
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
}

function writeJsonAtomically(path: string, value: object): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
}

function createWorkspace(input: {
  readonly project: CanonicalProject;
  readonly runId: string;
  readonly idPrefix: string;
  readonly kind: 'attempt' | 'integration';
  readonly nodeId: string;
  readonly generation: number;
  readonly ownerToken: string;
  readonly allowedWritePaths: readonly string[];
  readonly registryPath?: string;
}): WorkspaceHandle {
  assertIdentifier(input.runId, 'Run ID');
  assertIdentifier(input.nodeId, 'Node ID');
  assertWriteScopes(input.allowedWritePaths);
  const runRoot = resolve(
    input.project.root,
    '.slim',
    'workflows',
    'runs',
    input.runId,
  );
  const id = `${input.idPrefix}-${randomUUID()}`;
  const path = resolve(runRoot, 'worktrees', id);
  const fencePath = resolve(runRoot, 'fences', `${input.nodeId}.json`);
  const metadataPath = resolve(runRoot, 'metadata', `${id}.json`);
  const registryPath =
    input.registryPath ??
    resolve(input.project.root, '.slim', 'worktrees.json');
  mkdirSync(dirname(path), { recursive: true });
  runGit(
    input.project.gitExecutable,
    input.project.root,
    ['worktree', 'add', '--detach', path, input.project.baseCommit],
    input.project.gitTimeoutMs,
  );
  const metadata: WorkspaceHandle = {
    id,
    kind: input.kind,
    path,
    projectRoot: input.project.root,
    baseCommit: input.project.baseCommit,
    runRoot,
    metadataPath,
    ownerToken: input.ownerToken,
    generation: input.generation,
    fencePath,
    registryPath,
    allowedWritePaths: [...input.allowedWritePaths],
    dependencyDigests: [...input.project.dependencyDigests],
    status: 'active',
  };
  try {
    writeFence(fencePath, {
      workspaceId: id,
      ownerToken: input.ownerToken,
      generation: input.generation,
      status: 'active',
    });
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, {
      flag: 'wx',
    });
    appendRegistryRecord(registryPath, {
      id,
      slug: id,
      path: relative(input.project.root, path),
      base: input.project.baseCommit,
      owner: input.ownerToken,
      status: 'active',
      areas: input.allowedWritePaths,
      dependencies: input.project.dependencyDigests,
      kind: input.kind,
      generation: input.generation,
    });
    return metadata;
  } catch (error) {
    runGit(
      input.project.gitExecutable,
      input.project.root,
      ['worktree', 'remove', '--force', path],
      input.project.gitTimeoutMs,
    );
    throw error;
  }
}

export function createAttemptWorkspace(input: {
  readonly project: CanonicalProject;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly ownerToken: string;
  readonly allowedWritePaths: readonly string[];
  readonly registryPath?: string;
  readonly dependencyArtifacts?: readonly SealedArtifact[];
}): WorkspaceHandle {
  const workspace = createWorkspace({
    project: input.project,
    runId: input.runId,
    idPrefix: `${input.nodeId}-attempt-${input.attempt}`,
    kind: 'attempt',
    nodeId: input.nodeId,
    generation: input.attempt,
    ownerToken: input.ownerToken,
    allowedWritePaths: input.allowedWritePaths,
    registryPath: input.registryPath,
  });
  try {
    const artifacts = [...(input.dependencyArtifacts ?? [])].sort(
      (left, right) => left.digest.localeCompare(right.digest),
    );
    const actualDigests = artifacts.map((artifact) => artifact.digest).sort();
    if (
      JSON.stringify(actualDigests) !==
      JSON.stringify(input.project.dependencyDigests)
    ) {
      throw new WorkspaceLifecycleError(
        'invalid_project',
        'Dependency artifacts do not match the canonical project identity.',
      );
    }
    const manifests: ArtifactManifest[] = [];
    for (const artifact of artifacts) {
      const manifest = readSealedArtifact(artifact.path, artifact.digest);
      if (
        manifest.projectRoot !== input.project.root ||
        manifest.baseCommit !== input.project.baseCommit
      ) {
        throw new WorkspaceLifecycleError(
          'invalid_project',
          `Dependency ${artifact.digest} belongs to another project identity.`,
        );
      }
      manifests.push(manifest);
    }
    for (const manifest of manifests) {
      applyArtifactManifest({
        workspacePath: workspace.path,
        allowedWritePaths: input.allowedWritePaths,
        manifest,
      });
    }
    return workspace;
  } catch (error) {
    quarantineWorkspace({
      workspace,
      ownerToken: input.ownerToken,
      reason: 'dependency hydration failed',
    });
    throw error;
  }
}

export function createIntegrationWorkspace(input: {
  readonly project: CanonicalProject;
  readonly runId: string;
  readonly ownerToken: string;
  readonly registryPath?: string;
}): WorkspaceHandle {
  return createWorkspace({
    project: input.project,
    runId: input.runId,
    idPrefix: 'integration',
    kind: 'integration',
    nodeId: 'integration',
    generation: 1,
    ownerToken: input.ownerToken,
    allowedWritePaths: ['**'],
    registryPath: input.registryPath,
  });
}

export function integrateArtifactSerially(input: {
  readonly workspace: WorkspaceHandle;
  readonly artifact: SealedArtifact;
  readonly allowedWritePaths: readonly string[];
}): void {
  if (input.workspace.kind !== 'integration') {
    throw new WorkspaceLifecycleError(
      'invalid_project',
      'Artifacts can only be integrated in the run integration workspace.',
    );
  }
  const metadata = WorkspaceMetadataSchema.parse(
    JSON.parse(readFileSync(input.workspace.metadataPath, 'utf8')),
  );
  const fence = FenceSchema.parse(
    JSON.parse(readFileSync(input.workspace.fencePath, 'utf8')),
  );
  if (
    metadata.id !== input.workspace.id ||
    metadata.status !== 'active' ||
    fence.workspaceId !== input.workspace.id ||
    fence.ownerToken !== input.workspace.ownerToken ||
    fence.generation !== input.workspace.generation ||
    fence.status !== 'active'
  ) {
    throw new WorkspaceLifecycleError(
      'stale_generation',
      'Integration workspace is not the active owned generation.',
    );
  }
  const artifactRoot = resolve(input.workspace.runRoot, 'artifacts');
  const artifactRelative = relative(artifactRoot, resolve(input.artifact.path));
  if (
    artifactRelative.startsWith('..') ||
    artifactRelative.includes(`${sep}..${sep}`)
  ) {
    throw new WorkspaceLifecycleError(
      'invalid_project',
      'Artifact is not retained by this workflow run.',
    );
  }
  const lockPath = resolve(input.workspace.runRoot, 'integration.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx');
  } catch (error) {
    if (error instanceof Error) {
      throw new WorkspaceLifecycleError('integration_busy', error.message);
    }
    throw error;
  }
  try {
    const manifest = readSealedArtifact(
      input.artifact.path,
      input.artifact.digest,
    );
    if (
      manifest.projectRoot !== input.workspace.projectRoot ||
      manifest.baseCommit !== input.workspace.baseCommit ||
      JSON.stringify(manifest.dependencyDigests) !==
        JSON.stringify(input.workspace.dependencyDigests) ||
      JSON.stringify(manifest.allowedWritePaths) !==
        JSON.stringify(input.allowedWritePaths)
    ) {
      throw new WorkspaceLifecycleError(
        'invalid_project',
        'Artifact project identity mismatch.',
      );
    }
    applyArtifactManifest({
      workspacePath: input.workspace.path,
      allowedWritePaths: input.allowedWritePaths,
      manifest,
    });
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

export function quarantineWorkspace(input: {
  readonly workspace: WorkspaceHandle;
  readonly ownerToken: string;
  readonly reason: string;
}): void {
  if (input.workspace.ownerToken !== input.ownerToken) {
    throw new WorkspaceLifecycleError(
      'ownership_mismatch',
      'Workspace owner mismatch.',
    );
  }
  const current = WorkspaceMetadataSchema.parse(
    JSON.parse(readFileSync(input.workspace.metadataPath, 'utf8')),
  );
  if (
    current.id !== input.workspace.id ||
    current.generation !== input.workspace.generation ||
    current.status !== 'active'
  ) {
    throw new WorkspaceLifecycleError(
      'stale_generation',
      'Workspace is not the active owned generation.',
    );
  }
  const quarantined: WorkspaceHandle = {
    ...current,
    status: 'quarantined',
  };
  const fence = FenceSchema.parse(
    JSON.parse(readFileSync(input.workspace.fencePath, 'utf8')),
  );
  writeJsonAtomically(input.workspace.fencePath, {
    ...fence,
    status: 'quarantined',
  });
  writeJsonAtomically(input.workspace.metadataPath, quarantined);
  appendRegistryRecord(input.workspace.registryPath, {
    id: input.workspace.id,
    owner: input.ownerToken,
    status: 'quarantined',
    reason: input.reason,
    generation: input.workspace.generation,
  });
}

export function cleanupWorkspace(input: {
  readonly workspacePath: string;
  readonly ownerToken: string;
  readonly confirmedStopped: boolean;
  readonly disposable: boolean;
}): void {
  if (!existsSync(input.workspacePath)) return;
  const workspaceName = input.workspacePath.split(sep).at(-1) ?? '';
  const runRoot = dirname(dirname(input.workspacePath));
  const metadataPath = resolve(runRoot, 'metadata', `${workspaceName}.json`);
  const metadata = WorkspaceMetadataSchema.parse(
    JSON.parse(readFileSync(metadataPath, 'utf8')),
  );
  const expectedRunRoot = resolve(
    metadata.projectRoot,
    '.slim',
    'workflows',
    'runs',
  );
  const runRelative = relative(
    expectedRunRoot,
    realpathSync(input.workspacePath),
  );
  if (
    workspaceName.length === 0 ||
    metadata.runRoot !== runRoot ||
    runRelative.startsWith('..') ||
    runRelative.includes(`${sep}..${sep}`) ||
    metadata.path !== input.workspacePath ||
    metadata.metadataPath !== metadataPath ||
    metadata.ownerToken !== input.ownerToken
  ) {
    throw new WorkspaceLifecycleError(
      'ownership_mismatch',
      'Workspace owner mismatch.',
    );
  }
  if (metadata.status === 'quarantined') {
    throw new WorkspaceLifecycleError(
      'uncertain_workspace',
      'Quarantined workspaces are retained for reconciliation.',
    );
  }
  const fence = FenceSchema.parse(
    JSON.parse(readFileSync(metadata.fencePath, 'utf8')),
  );
  if (
    fence.workspaceId === metadata.id &&
    fence.generation === metadata.generation &&
    fence.status === 'quarantined'
  ) {
    throw new WorkspaceLifecycleError(
      'uncertain_workspace',
      'Quarantined workspaces are retained for reconciliation.',
    );
  }
  if (!input.confirmedStopped) {
    throw new WorkspaceLifecycleError(
      'stop_unconfirmed',
      'Workspace stop is not confirmed.',
    );
  }
  const dirty = runGit(
    'git',
    input.workspacePath,
    ['status', '--porcelain=v1', '-z'],
    10_000,
  );
  if (dirty.length > 0 && !input.disposable) {
    throw new WorkspaceLifecycleError(
      'dirty_workspace',
      'Workspace has retained changes.',
    );
  }
  runGit(
    'git',
    metadata.projectRoot,
    [
      'worktree',
      'remove',
      ...(input.disposable ? ['--force'] : []),
      input.workspacePath,
    ],
    10_000,
  );
  appendRegistryRecord(metadata.registryPath, {
    id: metadata.id,
    owner: metadata.ownerToken,
    status: 'archived',
    generation: metadata.generation,
  });
}
