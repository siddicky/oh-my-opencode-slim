import { compileWorkflow } from './graph';
import { runRalplan } from './planning';
import {
  createInput,
  definition,
  FakeNativeSessionPort,
  QueueOutputReader,
} from './planning-test-support';

export async function acceptedPlan(maxAdditionalNodes = 2) {
  const envelope = {
    maxAdditionalNodes,
    allowedWritePaths: ['src/workflows/**'],
  };
  const compiled = compileWorkflow(definition('Approved criterion'), envelope);
  const input = {
    ...createInput(
      new FakeNativeSessionPort(),
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        JSON.stringify({
          verdict: 'accept',
          findings: [],
          artifactDigest: compiled.definitionDigest,
        }),
      ]),
    ),
    expansionEnvelope: envelope,
  };
  return { input, plan: await runRalplan(input) };
}

export function invalidCriticPlanning() {
  const compiled = compileWorkflow(definition('Criterion'), {
    maxAdditionalNodes: 0,
    allowedWritePaths: ['src/workflows/**'],
  });
  return runRalplan(
    createInput(
      new FakeNativeSessionPort(),
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        '{"verdict":"accept","findings":[]}',
      ]),
    ),
  );
}

export function blockedCriticPlanning() {
  const compiled = compileWorkflow(definition('Criterion'), {
    maxAdditionalNodes: 0,
    allowedWritePaths: ['src/workflows/**'],
  });
  const port = new FakeNativeSessionPort();
  const planning = runRalplan(
    createInput(
      port,
      new QueueOutputReader([
        JSON.stringify(compiled.definition),
        JSON.stringify({
          verdict: 'blocked',
          findings: ['Missing required dependency'],
          artifactDigest: compiled.definitionDigest,
        }),
      ]),
    ),
  );
  return { planning, port };
}

export function exhaustedRepairPlanning() {
  const compiled = compileWorkflow(definition('Criterion'), {
    maxAdditionalNodes: 2,
    allowedWritePaths: ['src/workflows/**'],
  });
  const outputs: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    outputs.push(JSON.stringify(compiled.definition));
    outputs.push(
      JSON.stringify({
        verdict: 'revise',
        findings: ['Still incomplete'],
        artifactDigest: compiled.definitionDigest,
      }),
    );
  }
  const port = new FakeNativeSessionPort({ 'plan-task-10:planner:0': 2 });
  return {
    planning: runRalplan(createInput(port, new QueueOutputReader(outputs))),
    port,
  };
}
