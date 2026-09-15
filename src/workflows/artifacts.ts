import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';
import { z } from 'zod';

const ArtifactEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      path: z.string(),
      kind: z.literal('file'),
      mode: z.number().int().min(0).max(0o777),
      contentBase64: z.string(),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      kind: z.literal('symlink'),
      mode: z.number().int().min(0).max(0o777),
      contentBase64: z.string(),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      kind: z.literal('delete'),
      mode: z.literal(0),
      contentBase64: z.literal(''),
    })
    .strict(),
]);

const ArtifactManifestSchema = z
  .object({
    version: z.literal(1),
    projectRoot: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    workspaceId: z.string().min(1),
    generation: z.number().int().positive(),
    dependencyDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    allowedWritePaths: z.array(z.string().min(1)),
    entries: z.array(ArtifactEntrySchema),
  })
  .strict();

const SealedArtifactSchema = z
  .object({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    manifest: ArtifactManifestSchema,
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

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type SealedArtifact = {
  readonly path: string;
  readonly digest: string;
  readonly manifest: ArtifactManifest;
};

export type ArtifactWorkspace = {
  readonly id: string;
  readonly path: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly runRoot: string;
  readonly ownerToken: string;
  readonly generation: number;
  readonly dependencyDigests: readonly string[];
  readonly fencePath: string;
  readonly allowedWritePaths: readonly string[];
};

export class ArtifactWorkspaceError extends Error {
  readonly name = 'ArtifactWorkspaceError';

  constructor(
    readonly code:
      | 'invalid_manifest'
      | 'out_of_scope'
      | 'path_escape'
      | 'stale_workspace'
      | 'git_failed'
      | 'digest_mismatch',
    message: string,
  ) {
    super(message);
  }
}

const EXCLUDED_PATHS = [
  '.git',
  '.omo',
  '.slim/workflows',
  '.slim/worktrees',
  '.slim/worktrees.json',
  'node_modules',
] as const;

const SECRET_FILENAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
]);

function digestManifest(manifest: ArtifactManifest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

function parseRelativePath(candidate: string): string {
  const portable = candidate.replaceAll('\\', '/');
  const normalized = posix.normalize(portable);
  if (
    candidate.length === 0 ||
    isAbsolute(candidate) ||
    /^[A-Za-z]:\//.test(portable) ||
    portable.split('/').includes('..') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    throw new ArtifactWorkspaceError(
      'path_escape',
      `Unsafe artifact path: ${candidate}`,
    );
  }
  return normalized;
}

function globMatches(pattern: string, candidate: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if (character !== undefined) {
      expression += /[\\^$+?.()|{}[\]]/.test(character)
        ? `\\${character}`
        : character;
    }
  }
  return new RegExp(`${expression}$`).test(candidate);
}

function isAllowed(candidate: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) =>
    globMatches(parseRelativePath(pattern), candidate),
  );
}

function isExcluded(candidate: string): boolean {
  const filename = candidate.split('/').at(-1) ?? '';
  return (
    SECRET_FILENAMES.has(filename) ||
    filename === '.env' ||
    filename.startsWith('.env.') ||
    filename.endsWith('.pem') ||
    filename.endsWith('.key') ||
    EXCLUDED_PATHS.some(
      (path) => candidate === path || candidate.startsWith(`${path}/`),
    )
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function gitNames(
  workspacePath: string,
  args: readonly string[],
): readonly string[] {
  const result = spawnSync('git', ['-C', workspacePath, ...args], {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new ArtifactWorkspaceError(
      'git_failed',
      `Git artifact scan failed with status ${result.status ?? 'unknown'}.`,
    );
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

function assertSafeTarget(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ArtifactWorkspaceError(
      'path_escape',
      `Path escapes workspace: ${relativePath}`,
    );
  }
  let current = dirname(target);
  while (current !== root) {
    if (pathExists(current) && lstatSync(current).isSymbolicLink()) {
      throw new ArtifactWorkspaceError(
        'path_escape',
        `Symlink parent escapes workspace safety: ${relativePath}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new ArtifactWorkspaceError(
        'path_escape',
        `Invalid target: ${relativePath}`,
      );
    }
    current = parent;
  }
  return target;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function decodeBase64(content: string, path: string): Buffer {
  const decoded = Buffer.from(content, 'base64');
  if (decoded.toString('base64') !== content) {
    throw new ArtifactWorkspaceError(
      'invalid_manifest',
      `Invalid base64 content for ${path}.`,
    );
  }
  return decoded;
}

function decodeSymlinkTarget(content: string, path: string): string {
  const target = decodeBase64(content, path).toString('utf8');
  const portable = target.replaceAll('\\', '/');
  const resolved = posix.normalize(posix.join(posix.dirname(path), portable));
  if (
    target.length === 0 ||
    target.includes('\0') ||
    isAbsolute(target) ||
    /^[A-Za-z]:\//.test(portable) ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    resolved.startsWith('/')
  ) {
    throw new ArtifactWorkspaceError(
      'path_escape',
      `Symlink target escapes workspace: ${path}`,
    );
  }
  return target;
}

type ValidatedEntry = {
  readonly entry: ArtifactManifest['entries'][number];
  readonly path: string;
  readonly target?: string;
};

function validateManifestEntries(input: {
  readonly manifest: ArtifactManifest;
  readonly allowedWritePaths: readonly string[];
  readonly workspacePath?: string;
}): readonly ValidatedEntry[] {
  const seen = new Set<string>();
  const validated = input.manifest.entries.map((entry) => {
    const path = parseRelativePath(entry.path);
    if (path !== entry.path) {
      throw new ArtifactWorkspaceError(
        'invalid_manifest',
        `Artifact path is not canonical: ${entry.path}`,
      );
    }
    if (seen.has(path)) {
      throw new ArtifactWorkspaceError(
        'invalid_manifest',
        `Duplicate artifact path: ${path}`,
      );
    }
    seen.add(path);
    if (isExcluded(path) || !isAllowed(path, input.allowedWritePaths)) {
      throw new ArtifactWorkspaceError(
        'out_of_scope',
        `Artifact path is outside scope: ${path}`,
      );
    }
    if (entry.kind === 'symlink') {
      decodeSymlinkTarget(entry.contentBase64, path);
    } else if (entry.kind !== 'delete') {
      decodeBase64(entry.contentBase64, path);
    }
    const target = input.workspacePath
      ? assertSafeTarget(input.workspacePath, path)
      : undefined;
    if (
      target &&
      entry.kind !== 'delete' &&
      pathExists(target) &&
      lstatSync(target).isDirectory()
    ) {
      throw new ArtifactWorkspaceError(
        'invalid_manifest',
        `Artifact file conflicts with a directory: ${path}`,
      );
    }
    return { entry, path, target };
  });

  const paths = [...seen].sort();
  for (let index = 0; index < paths.length - 1; index += 1) {
    const parent = paths[index];
    const child = paths[index + 1];
    if (parent && child?.startsWith(`${parent}/`)) {
      throw new ArtifactWorkspaceError(
        'invalid_manifest',
        `Artifact paths overlap: ${parent} and ${child}`,
      );
    }
  }
  return validated;
}

function assertCurrentWorkspace(workspace: ArtifactWorkspace): void {
  const result = FenceSchema.safeParse(
    JSON.parse(readFileSync(workspace.fencePath, 'utf8')),
  );
  if (
    !result.success ||
    result.data.workspaceId !== workspace.id ||
    result.data.ownerToken !== workspace.ownerToken ||
    result.data.generation !== workspace.generation ||
    result.data.status !== 'active'
  ) {
    throw new ArtifactWorkspaceError(
      'stale_workspace',
      `Workspace ${workspace.id} no longer owns generation ${workspace.generation}.`,
    );
  }
}

export function captureArtifactManifest(input: {
  readonly workspace: ArtifactWorkspace;
  readonly allowedWritePaths: readonly string[];
}): ArtifactManifest {
  if (
    !arraysEqual(input.allowedWritePaths, input.workspace.allowedWritePaths)
  ) {
    throw new ArtifactWorkspaceError(
      'out_of_scope',
      'Capture scope does not match the workspace scope.',
    );
  }
  const names = new Set([
    ...gitNames(input.workspace.path, [
      'diff',
      '--name-only',
      '-z',
      'HEAD',
      '--',
    ]),
    ...gitNames(input.workspace.path, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
    ]),
  ]);
  const entries = [...names]
    .map(parseRelativePath)
    .sort()
    .filter((path) => !isExcluded(path))
    .map((path) => {
      if (!isAllowed(path, input.allowedWritePaths)) {
        throw new ArtifactWorkspaceError(
          'out_of_scope',
          `Write is outside scope: ${path}`,
        );
      }
      const target = assertSafeTarget(input.workspace.path, path);
      if (!pathExists(target)) {
        return { path, kind: 'delete', mode: 0, contentBase64: '' } as const;
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        return {
          path,
          kind: 'symlink',
          mode: stat.mode & 0o777,
          contentBase64: Buffer.from(readlinkSync(target)).toString('base64'),
        } as const;
      }
      if (!stat.isFile()) {
        throw new ArtifactWorkspaceError(
          'invalid_manifest',
          `Unsupported entry: ${path}`,
        );
      }
      return {
        path,
        kind: 'file',
        mode: stat.mode & 0o777,
        contentBase64: readFileSync(target).toString('base64'),
      } as const;
    });
  return {
    version: 1,
    projectRoot: input.workspace.projectRoot,
    baseCommit: input.workspace.baseCommit,
    workspaceId: input.workspace.id,
    generation: input.workspace.generation,
    dependencyDigests: [...input.workspace.dependencyDigests],
    allowedWritePaths: [...input.workspace.allowedWritePaths],
    entries,
  };
}

export function applyArtifactManifest(input: {
  readonly workspacePath: string;
  readonly allowedWritePaths: readonly string[];
  readonly manifest: unknown;
}): void {
  const result = ArtifactManifestSchema.safeParse(input.manifest);
  if (!result.success) {
    throw new ArtifactWorkspaceError('invalid_manifest', result.error.message);
  }
  const entries = validateManifestEntries({
    manifest: result.data,
    allowedWritePaths: input.allowedWritePaths,
    workspacePath: input.workspacePath,
  });
  for (const { entry, target } of entries) {
    if (!target) {
      throw new ArtifactWorkspaceError(
        'invalid_manifest',
        'Artifact target validation failed.',
      );
    }
    if (entry.kind === 'delete') {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (pathExists(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    if (entry.kind === 'symlink') {
      symlinkSync(decodeSymlinkTarget(entry.contentBase64, entry.path), target);
      continue;
    }
    writeFileSync(target, decodeBase64(entry.contentBase64, entry.path));
    chmodSync(target, entry.mode);
  }
}

export function sealArtifactManifest(input: {
  readonly manifest: ArtifactManifest;
  readonly destinationDir: string;
  readonly workspace: ArtifactWorkspace;
}): SealedArtifact {
  assertCurrentWorkspace(input.workspace);
  const manifest = ArtifactManifestSchema.parse(input.manifest);
  if (
    manifest.projectRoot !== input.workspace.projectRoot ||
    manifest.baseCommit !== input.workspace.baseCommit ||
    manifest.workspaceId !== input.workspace.id ||
    manifest.generation !== input.workspace.generation ||
    !arraysEqual(
      manifest.dependencyDigests,
      input.workspace.dependencyDigests,
    ) ||
    !arraysEqual(manifest.allowedWritePaths, input.workspace.allowedWritePaths)
  ) {
    throw new ArtifactWorkspaceError(
      'invalid_manifest',
      'Artifact identity does not match the fenced workspace.',
    );
  }
  validateManifestEntries({
    manifest,
    allowedWritePaths: input.workspace.allowedWritePaths,
  });
  const artifactRoot = resolve(input.workspace.runRoot, 'artifacts');
  const destinationDir = resolve(input.destinationDir);
  if (
    destinationDir !== artifactRoot &&
    !destinationDir.startsWith(`${artifactRoot}${sep}`)
  ) {
    throw new ArtifactWorkspaceError(
      'path_escape',
      'Sealed artifacts must stay in the run-owned artifact directory.',
    );
  }
  if (pathExists(artifactRoot) && lstatSync(artifactRoot).isSymbolicLink()) {
    throw new ArtifactWorkspaceError(
      'path_escape',
      'Run-owned artifact directory cannot be a symlink.',
    );
  }
  assertSafeTarget(
    input.workspace.runRoot,
    relativePathFromRunRoot(input.workspace.runRoot, destinationDir),
  );
  const digest = digestManifest(manifest);
  const envelope = `${JSON.stringify({ digest, manifest })}\n`;
  mkdirSync(destinationDir, { recursive: true });
  const path = resolve(
    destinationDir,
    `${input.workspace.id}-${input.workspace.generation}-${digest.slice(7, 23)}.json`,
  );
  if (pathExists(path)) {
    if (readFileSync(path, 'utf8') !== envelope) {
      throw new ArtifactWorkspaceError(
        'digest_mismatch',
        `Sealed path collision: ${path}`,
      );
    }
  } else {
    writeFileSync(path, envelope, { flag: 'wx', mode: 0o444 });
  }
  return { path, digest, manifest };
}

function relativePathFromRunRoot(runRoot: string, target: string): string {
  const relativePath = posix.relative(
    runRoot.replaceAll('\\', '/'),
    target.replaceAll('\\', '/'),
  );
  return parseRelativePath(relativePath);
}

export function readSealedArtifact(
  path: string,
  digest: string,
): ArtifactManifest {
  const result = SealedArtifactSchema.safeParse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  if (
    !result.success ||
    result.data.digest !== digest ||
    digestManifest(result.data.manifest) !== digest
  ) {
    throw new ArtifactWorkspaceError(
      'digest_mismatch',
      `Artifact digest mismatch: ${path}`,
    );
  }
  return result.data.manifest;
}
