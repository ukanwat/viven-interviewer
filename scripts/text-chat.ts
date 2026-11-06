// Quick text-mode check of the brain: feeds scripted answers, prints decisions.
import * as brain from '../src/brain/brain.ts';
import { MemoryStore } from '../src/brain/store.ts';
import { usage } from '../src/brain/llm.ts';

const store = new MemoryStore();
const p = brain.newPerson('Utkarsh', process.argv[2] ?? '');
const s = brain.startSession(p, 'text');
const show = (d: any, ms: number) => console.log(`\n[${d.label} -> ${d.move}${d.angle ? '/' + d.angle : ''}] (${ms}ms)${d.enforced ? ' ENFORCED: ' + d.enforced : ''}\n  AGENT: ${d.say}\n  why: ${d.reason}\n  items: ${d.newItems.map((i: any) => `[${i.kind}/${i.novelty}] ${i.text}`).join(' | ')}`);
let t = Date.now();
show(await brain.opener(p, s.id, 'text'), Date.now() - t);
const answers = JSON.parse(process.argv[3] ?? '[]');
for (const a of answers) {
  console.log(`\n  PERSON: ${a}`);
  t = Date.now();
  let earlyMs = 0;
  show(await brain.personTurn(p, a, 'text', s.id, { onEarly: () => (earlyMs = Date.now() - t) }), Date.now() - t);
  console.log('   time-to-question ms:', earlyMs || '(no early)');
}
store.save(p);
console.log('\nthreads:', p.threads.map((x) => `${x.id} ${x.title} ${x.status} weak=${x.weakStreak}`).join(' | '));
console.log('cost $', usage.costUsd.toFixed(4));
