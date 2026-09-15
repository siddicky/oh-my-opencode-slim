const DEEP_AXES = [
  '1. requirements - functional requirements, security requirements and system constraints, recorded as REQ-xxx / SEC-xxx / CON-xxx entries.',
  '2. constraints - technologies, platforms, budgets and non-negotiable limits (CON-xxx).',
  '3. acceptance criteria - testable Given-When-Then criteria (AC-xxx).',
  '4. dependencies - external integrations, libraries and services (EXT-xxx).',
];

export function buildDeepKickoffPrompt(idea: string, maxQuestions = 2): string {
  return [
    'You are running a deep interview q&a session for the user inside their repository.',
    `Initial idea: ${idea}`,
    'Goal: iteratively generate a highly structured specification document using the standard 11-section interview template.',
    'Before declaring the specification complete, every one of these clarification axes must be probed with the user:',
    ...DEEP_AXES,
    `Clarify through short rounds of at most ${maxQuestions} questions at a time, highest-ambiguity axis first.`,
    'Return the usual <interview_state> JSON block after any short human-friendly preface.',
  ].join('\n');
}

export function buildDeepResumePrompt(
  document: string,
  maxQuestions = 2,
): string {
  return [
    'Resume the deep interview from this existing markdown document.',
    'Use the current spec and Q&A history as ground truth so far. Do not restart from scratch.',
    'Continue probing any of the four clarification axes that the history does not yet cover:',
    ...DEEP_AXES,
    `Ask the next highest-value questions, up to ${maxQuestions} at a time.`,
    'Return the usual <interview_state> JSON block.',
    '',
    document,
  ].join('\n');
}
