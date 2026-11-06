// What a run or a graded set was made with, so two results are only compared when they differ in the
// one thing under test (Inspect's EvalSpec; HELM and τ² hold everything else fixed). Hashes are of
// the source files that define each part: change the judge prompt and its hash changes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const hash = (...files: string[]) => createHash('sha256').update(files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\0')).digest('hex').slice(0, 10);
const git = (...a: string[]) => {
  try {
    return execFileSync('git', a, { cwd: ROOT }).toString().trim();
  } catch {
    return '';
  }
};

export type Spec = { commit: string; dirty: boolean; interviewer: string; judge: string; sim: string; personas: string; models: Record<string, string> };

// `personas`: the hash covers only the people given (a run's one person), so adding new personas to
// the file doesn't make every older run look different. A graded set passes none: compare checks
// each pair's run spec instead.
export function spec(models: Record<string, string>, personas: unknown[] = []): Spec {
  return {
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: !!git('status', '--porcelain', 'src', 'eval/lib', 'eval/scenarios'),
    interviewer: hash('src/brain/prompts.ts', 'src/brain/brain.ts', 'src/brain/notes.ts'),
    judge: hash('eval/lib/grade.ts', 'eval/lib/score.ts'),
    sim: hash('eval/lib/sim.ts'),
    personas: personas.length ? createHash('sha256').update(JSON.stringify(personas)).digest('hex').slice(0, 10) : '',
    models,
  };
}

// Differences between two specs other than the interviewer (the arm under test). Empty = fair comparison.
export function unfair(a?: Spec, b?: Spec): string[] {
  if (!a || !b) return ['one side has no spec (made before specs were recorded)'];
  const out: string[] = [];
  for (const k of ['judge', 'sim', 'personas'] as const) if (a[k] !== b[k]) out.push(`${k} differs (${a[k]} vs ${b[k]})`);
  for (const k of new Set([...Object.keys(a.models), ...Object.keys(b.models)])) if (k !== 'brain' && a.models[k] !== b.models[k]) out.push(`${k} model differs (${a.models[k]} vs ${b.models[k]})`);
  return out;
}
