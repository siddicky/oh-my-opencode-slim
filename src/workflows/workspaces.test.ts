import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactWorkspaceError,
  applyArtifactManifest,
  captureArtifactManifest,
  readSealedArtifact,
  sealArtifactManifest,
} from './artifacts';
import {
  bindCanonicalProject,
  cleanupWorkspace,
  createAttemptWorkspace,
  createIntegrationWorkspace,
  integrateArtifactSerially,
  quarantineWorkspace,
  WorkspaceLifecycleError,
} from './workspaces';

const TEST_TIMEOUT_MS = 20_000;

function git(cwd: string, ...args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function hashBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function createGitFixture(): {
  readonly root: string;
  readonly baseCommit: string;
  readonly registryPath: string;
  readonly unrelatedRegistryBytes: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'omo-workspaces-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'workspace-test@example.invalid');
  git(root, 'config', 'user.name', 'Workspace Test');
  writeFileSync(join(root, '.gitignore'), '.slim/workflows/\n');
  writeFileSync(join(root, 'tracked.txt'), 'base tracked\n');
  writeFileSync(join(root, 'delete.txt'), 'delete me\n');
  writeFileSync(join(root, 'mode.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, 'dependency.txt'), 'base dependency\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  const registryPath = join(root, '.slim', 'worktrees.json');
  mkdirSync(join(root, '.slim'), { recursive: true });
  const unrelatedRegistryBytes = [
    '    {',
    '      "slug": "user-owned",',
    '      "path": ".slim/worktrees/user-owned",',
    '      "custom": { "spacing": "must stay byte identical" }',
    '    }',
  ].join('\n');
  writeFileSync(
    registryPath,
    `{\n  "version": "1.0.0",\n  "lanes": [\n${unrelatedRegistryBytes}\n  ]\n}\n`,
  );
  return {
    root,
    baseCommit: git(root, 'rev-parse', 'HEAD'),
    registryPath,
    unrelatedRegistryBytes,
  };
}

describe('workflow workspace isolation', () => {
  it(
    'workspace artifact roundtrip',
    async () => {
      const fixture = createGitFixture();
      const ownerToken = `owner-${randomUUID()}`;
      const cleanupTargets: Array<{
        readonly path: string;
        readonly ownerToken: string;
      }> = [];

      try {
        const callerHead = git(fixture.root, 'rev-parse', 'HEAD');
        const project = bindCanonicalProject({
          callerPath: fixture.root,
          approvedBase: fixture.baseCommit,
        });
        const dependencyLane = createAttemptWorkspace({
          project,
          runId: 'run-roundtrip',
          nodeId: 'dependency',
          attempt: 1,
          ownerToken,
          allowedWritePaths: ['dependency.txt'],
          registryPath: fixture.registryPath,
        });
        cleanupTargets.push(dependencyLane);
        writeFileSync(
          join(dependencyLane.path, 'dependency.txt'),
          'hydrated dependency\n',
        );
        const dependency = sealArtifactManifest({
          manifest: captureArtifactManifest({
            workspace: dependencyLane,
            allowedWritePaths: ['dependency.txt'],
          }),
          destinationDir: join(dependencyLane.runRoot, 'artifacts'),
          workspace: dependencyLane,
        });
        const dependencyProject = bindCanonicalProject({
          callerPath: fixture.root,
          approvedBase: fixture.baseCommit,
          dependencyDigests: [dependency.digest],
        });

        const parallelA = createAttemptWorkspace({
          project,
          runId: 'run-roundtrip',
          nodeId: 'parallel-a',
          attempt: 1,
          ownerToken,
          allowedWritePaths: ['parallel/a.txt'],
          registryPath: fixture.registryPath,
        });
        const parallelB = createAttemptWorkspace({
          project,
          runId: 'run-roundtrip',
          nodeId: 'parallel-b',
          attempt: 1,
          ownerToken,
          allowedWritePaths: ['parallel/b.txt'],
          registryPath: fixture.registryPath,
        });
        cleanupTargets.push(parallelA, parallelB);
        mkdirSync(join(parallelA.path, 'parallel'));
        mkdirSync(join(parallelB.path, 'parallel'));
        await Promise.all([
          writeFileAsync(join(parallelA.path, 'parallel', 'a.txt'), 'lane a\n'),
          writeFileAsync(join(parallelB.path, 'parallel', 'b.txt'), 'lane b\n'),
        ]);
        expect(existsSync(join(parallelA.path, 'parallel', 'b.txt'))).toBe(
          false,
        );
        expect(existsSync(join(parallelB.path, 'parallel', 'a.txt'))).toBe(
          false,
        );
        expect(
          captureArtifactManifest({
            workspace: parallelA,
            allowedWritePaths: parallelA.allowedWritePaths,
          }).entries.map((entry) => entry.path),
        ).toEqual(['parallel/a.txt']);
        expect(
          captureArtifactManifest({
            workspace: parallelB,
            allowedWritePaths: parallelB.allowedWritePaths,
          }).entries.map((entry) => entry.path),
        ).toEqual(['parallel/b.txt']);

        const lane = createAttemptWorkspace({
          project: dependencyProject,
          runId: 'run-roundtrip',
          nodeId: 'implementation',
          attempt: 1,
          ownerToken,
          allowedWritePaths: [
            'dependency.txt',
            'tracked.txt',
            'untracked.bin',
            'mode.sh',
            'delete.txt',
            'link.txt',
            'dangling.txt',
          ],
          registryPath: fixture.registryPath,
          dependencyArtifacts: [dependency],
        });
        cleanupTargets.push(lane);
        expect(readFileSync(join(lane.path, 'dependency.txt'), 'utf8')).toBe(
          'hydrated dependency\n',
        );

        writeFileSync(join(lane.path, 'tracked.txt'), 'changed tracked\n');
        writeFileSync(
          join(lane.path, 'untracked.bin'),
          Buffer.from([0, 255, 1, 128, 10]),
        );
        chmodSync(join(lane.path, 'mode.sh'), 0o755);
        rmSync(join(lane.path, 'delete.txt'));
        symlinkSync('tracked.txt', join(lane.path, 'link.txt'));
        symlinkSync('missing.txt', join(lane.path, 'dangling.txt'));
        writeFileSync(join(lane.path, '.env'), 'SECRET=excluded\n');
        writeFileSync(join(lane.path, '.npmrc'), 'TOKEN=excluded\n');
        mkdirSync(join(lane.path, '.omo'));
        writeFileSync(join(lane.path, '.omo', 'state.json'), '{}\n');

        const artifact = sealArtifactManifest({
          manifest: captureArtifactManifest({
            workspace: lane,
            allowedWritePaths: lane.allowedWritePaths,
          }),
          destinationDir: join(lane.runRoot, 'artifacts'),
          workspace: lane,
        });
        const sealedBytesBefore = hashBytes(readFileSync(artifact.path));
        const parsed = readSealedArtifact(artifact.path, artifact.digest);
        expect(parsed.entries.map((entry) => entry.path)).toEqual([
          'dangling.txt',
          'delete.txt',
          'dependency.txt',
          'link.txt',
          'mode.sh',
          'tracked.txt',
          'untracked.bin',
        ]);
        expect(parsed.entries.some((entry) => entry.path === '.env')).toBe(
          false,
        );
        expect(parsed.entries.some((entry) => entry.path === '.npmrc')).toBe(
          false,
        );
        expect(
          parsed.entries.some((entry) => entry.path.startsWith('.omo/')),
        ).toBe(false);
        expect(parsed.baseCommit).toBe(fixture.baseCommit);
        expect(parsed.dependencyDigests).toEqual([dependency.digest]);
        expect(parsed.allowedWritePaths).toEqual(lane.allowedWritePaths);
        expect(git(lane.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
          'HEAD',
        );
        expect(lane.path).not.toBe(dependencyLane.path);
        expect(
          JSON.parse(readFileSync(lane.metadataPath, 'utf8')),
        ).toMatchObject({
          baseCommit: fixture.baseCommit,
          dependencyDigests: [dependency.digest],
          allowedWritePaths: lane.allowedWritePaths,
          path: lane.path,
        });

        const integration = createIntegrationWorkspace({
          project: dependencyProject,
          runId: 'run-roundtrip',
          ownerToken,
          registryPath: fixture.registryPath,
        });
        cleanupTargets.push(integration);
        expect(() =>
          integrateArtifactSerially({
            workspace: lane,
            artifact,
            allowedWritePaths: lane.allowedWritePaths,
          }),
        ).toThrow(WorkspaceLifecycleError);
        integrateArtifactSerially({
          workspace: integration,
          artifact,
          allowedWritePaths: lane.allowedWritePaths,
        });

        expect(
          readFileSync(join(integration.path, 'tracked.txt'), 'utf8'),
        ).toBe('changed tracked\n');
        expect(
          readFileSync(join(integration.path, 'dependency.txt'), 'utf8'),
        ).toBe('hydrated dependency\n');
        expect(readFileSync(join(integration.path, 'untracked.bin'))).toEqual(
          Buffer.from([0, 255, 1, 128, 10]),
        );
        expect(lstatSync(join(integration.path, 'mode.sh')).mode & 0o777).toBe(
          0o755,
        );
        expect(existsSync(join(integration.path, 'delete.txt'))).toBe(false);
        expect(readlinkSync(join(integration.path, 'link.txt'))).toBe(
          'tracked.txt',
        );
        expect(readlinkSync(join(integration.path, 'dangling.txt'))).toBe(
          'missing.txt',
        );
        expect(hashBytes(readFileSync(artifact.path))).toBe(sealedBytesBefore);
        expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(callerHead);
        expect(
          git(fixture.root, 'status', '--porcelain', '--', 'tracked.txt'),
        ).toBe('');
        process.stdout.write(
          `MANUAL_QA_FIXTURE=${fixture.root}\nARTIFACT_PATH=${artifact.path}\nARTIFACT_SHA256=${sealedHashValue(artifact.path)}\nINTEGRATION_PATH=${integration.path}\n`,
        );
      } finally {
        for (const target of cleanupTargets.reverse()) {
          cleanupWorkspace({
            workspacePath: target.path,
            ownerToken: target.ownerToken,
            confirmedStopped: true,
            disposable: true,
          });
        }
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'workspace dirty caller and stale writer',
    () => {
      const fixture = createGitFixture();
      const ownerToken = `owner-${randomUUID()}`;
      const cleanupTargets: Array<{
        readonly path: string;
        readonly ownerToken: string;
      }> = [];

      try {
        writeFileSync(
          join(fixture.root, 'tracked.txt'),
          'caller dirty bytes\n',
        );
        const callerHash = hashBytes(
          readFileSync(join(fixture.root, 'tracked.txt')),
        );
        const unrelatedHash = hashBytes(fixture.unrelatedRegistryBytes);
        const project = bindCanonicalProject({
          callerPath: fixture.root,
          approvedBase: fixture.baseCommit,
        });
        const stale = createAttemptWorkspace({
          project,
          runId: 'run-stale',
          nodeId: 'implementation',
          attempt: 1,
          ownerToken,
          allowedWritePaths: ['allowed/**'],
          registryPath: fixture.registryPath,
        });
        mkdirSync(join(stale.path, 'allowed'));
        writeFileSync(
          join(stale.path, 'allowed', 'result.txt'),
          'attempt one\n',
        );
        const sealed = sealArtifactManifest({
          manifest: captureArtifactManifest({
            workspace: stale,
            allowedWritePaths: stale.allowedWritePaths,
          }),
          destinationDir: join(stale.runRoot, 'artifacts'),
          workspace: stale,
        });
        const sealedHash = hashBytes(readFileSync(sealed.path));

        quarantineWorkspace({
          workspace: stale,
          ownerToken,
          reason: 'lost stop acknowledgement',
        });
        expect(() =>
          cleanupWorkspace({
            workspacePath: stale.path,
            ownerToken,
            confirmedStopped: true,
            disposable: true,
          }),
        ).toThrow(WorkspaceLifecycleError);
        expect(existsSync(stale.path)).toBe(true);
        expect(() =>
          sealArtifactManifest({
            manifest: readSealedArtifact(sealed.path, sealed.digest),
            destinationDir: join(stale.runRoot, 'artifacts'),
            workspace: stale,
          }),
        ).toThrow(ArtifactWorkspaceError);
        const next = createAttemptWorkspace({
          project,
          runId: 'run-stale',
          nodeId: 'implementation',
          attempt: 2,
          ownerToken,
          allowedWritePaths: ['allowed/**'],
          registryPath: fixture.registryPath,
        });
        cleanupTargets.push(next);
        writeFileSync(
          join(stale.path, 'allowed', 'late.txt'),
          'orphan write\n',
        );
        expect(() =>
          sealArtifactManifest({
            manifest: captureArtifactManifest({
              workspace: stale,
              allowedWritePaths: stale.allowedWritePaths,
            }),
            destinationDir: join(stale.runRoot, 'artifacts'),
            workspace: stale,
          }),
        ).toThrow(ArtifactWorkspaceError);
        expect(existsSync(join(next.path, 'allowed', 'late.txt'))).toBe(false);
        expect(hashBytes(readFileSync(sealed.path))).toBe(sealedHash);

        writeFileSync(join(next.path, 'outside.txt'), 'not in scope\n');
        expect(() =>
          captureArtifactManifest({
            workspace: next,
            allowedWritePaths: next.allowedWritePaths,
          }),
        ).toThrow(ArtifactWorkspaceError);
        const manifestIdentity = {
          version: 1 as const,
          projectRoot: project.root,
          baseCommit: project.baseCommit,
          workspaceId: next.id,
          generation: next.generation,
          dependencyDigests: [...next.dependencyDigests],
          allowedWritePaths: [...next.allowedWritePaths],
        };
        expect(() =>
          applyArtifactManifest({
            workspacePath: next.path,
            allowedWritePaths: ['allowed/**'],
            manifest: {
              ...manifestIdentity,
              entries: [
                {
                  path: '../escape',
                  kind: 'file',
                  mode: 0o644,
                  contentBase64: 'ZXNjYXBl',
                },
              ],
            },
          }),
        ).toThrow(ArtifactWorkspaceError);
        const atomicTarget = join(next.path, 'allowed', 'must-not-exist.txt');
        expect(() =>
          applyArtifactManifest({
            workspacePath: next.path,
            allowedWritePaths: next.allowedWritePaths,
            manifest: {
              ...manifestIdentity,
              entries: [
                {
                  path: 'allowed/must-not-exist.txt',
                  kind: 'file',
                  mode: 0o644,
                  contentBase64: 'd3JpdHRlbg==',
                },
                {
                  path: 'allowed/../escape.txt',
                  kind: 'file',
                  mode: 0o644,
                  contentBase64: 'ZXNjYXBl',
                },
              ],
            },
          }),
        ).toThrow(ArtifactWorkspaceError);
        expect(existsSync(atomicTarget)).toBe(false);
        expect(() =>
          applyArtifactManifest({
            workspacePath: next.path,
            allowedWritePaths: next.allowedWritePaths,
            manifest: {
              ...manifestIdentity,
              entries: [
                {
                  path: 'allowed/external-link',
                  kind: 'symlink',
                  mode: 0o777,
                  contentBase64: Buffer.from('/tmp/outside').toString('base64'),
                },
              ],
            },
          }),
        ).toThrow(ArtifactWorkspaceError);
        expect(() =>
          applyArtifactManifest({
            workspacePath: next.path,
            allowedWritePaths: ['allowed/**'],
            manifest: { version: 1, entries: 'malformed' },
          }),
        ).toThrow(ArtifactWorkspaceError);
        expect(() =>
          cleanupWorkspace({
            workspacePath: next.path,
            ownerToken: 'wrong-owner',
            confirmedStopped: true,
            disposable: true,
          }),
        ).toThrow(WorkspaceLifecycleError);
        expect(() =>
          cleanupWorkspace({
            workspacePath: next.path,
            ownerToken,
            confirmedStopped: true,
            disposable: false,
          }),
        ).toThrow(WorkspaceLifecycleError);
        expect(() =>
          cleanupWorkspace({
            workspacePath: next.path,
            ownerToken,
            confirmedStopped: false,
            disposable: true,
          }),
        ).toThrow(WorkspaceLifecycleError);

        const registry = readFileSync(fixture.registryPath, 'utf8');
        const unrelatedStart = registry.indexOf(fixture.unrelatedRegistryBytes);
        expect(unrelatedStart).toBeGreaterThanOrEqual(0);
        expect(
          hashBytes(
            registry.slice(
              unrelatedStart,
              unrelatedStart + fixture.unrelatedRegistryBytes.length,
            ),
          ),
        ).toBe(unrelatedHash);
        expect(registry).toContain('"status":"quarantined"');
        expect(hashBytes(readFileSync(join(fixture.root, 'tracked.txt')))).toBe(
          callerHash,
        );

        const hungGit = join(fixture.root, 'hung-git.sh');
        writeFileSync(hungGit, '#!/bin/sh\nsleep 2\n');
        chmodSync(hungGit, 0o755);
        const startedAt = performance.now();
        expect(() =>
          bindCanonicalProject({
            callerPath: fixture.root,
            approvedBase: fixture.baseCommit,
            gitExecutable: hungGit,
            gitTimeoutMs: 20,
          }),
        ).toThrow(WorkspaceLifecycleError);
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        process.stdout.write(
          `ADVERSARIAL_FIXTURE=${fixture.root}\nCALLER_SHA256=${callerHash}\nSEALED_SHA256=${sealedHash}\nREGISTRY_UNRELATED_SHA256=${unrelatedHash}\n`,
        );
      } finally {
        for (const target of cleanupTargets.reverse()) {
          cleanupWorkspace({
            workspacePath: target.path,
            ownerToken: target.ownerToken,
            confirmedStopped: true,
            disposable: true,
          });
        }
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function sealedHashValue(path: string): string {
  return hashBytes(readFileSync(path));
}
