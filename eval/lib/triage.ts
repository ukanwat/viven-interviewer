// Error analysis, Hamel-style: read conversations, write the FIRST failure of each in your own words
// (open coding), then group those notes into a few failure types (axial coding) and count them. The
// counts say what to fix first, and which failure types deserve their own judge. Tags are written by
// hand in the viewer's note box as #words (e.g. "#restates asked her to confirm what she'd just said").
// The judge's own label counts sit alongside, so you can see where it agrees with what people notice.
import { METRICS } from './score.ts';
import type { GradedSet } from './report.ts';

export type Review = { id: string; set: string; pass: boolean; note: string; at: string };

export const tagsOf = (note: string) => [...new Set((note.match(/#[\w-]+/g) ?? []).map((t) => t.slice(1).toLowerCase()))];

export function triage(reviews: Review[], sets: GradedSet[] = []) {
  // Newest review per conversation wins.
  const latest = new Map<string, Review>();
  for (const r of reviews) if (!latest.has(`${r.set}|${r.id}`) || latest.get(`${r.set}|${r.id}`)!.at <= r.at) latest.set(`${r.set}|${r.id}`, r);
  const rs = [...latest.values()];
  const failed = rs.filter((r) => !r.pass);
  const count = new Map<string, Review[]>();
  for (const r of failed) for (const t of tagsOf(r.note)) count.set(t, [...(count.get(t) ?? []), r]);
  const untagged = failed.filter((r) => !tagsOf(r.note).length);
  const out = [
    '# Failure taxonomy',
    `${rs.length} conversations reviewed, ${failed.length} failed (${rs.length ? Math.round((failed.length / rs.length) * 100) : 0}%).`,
    '',
    '## Failure types (from your notes)',
    ...(count.size ? ['', '| type | conversations | share of failures | examples |', '|---|---|---|---|', ...[...count.entries()].sort((a, b) => b[1].length - a[1].length).map(([t, xs]) => `| ${t} | ${xs.length} | ${Math.round((xs.length / failed.length) * 100)}% | ${xs.slice(0, 2).map((x) => `${x.id}: ${x.note.replace(/\s+/g, ' ').slice(0, 90)}`).join('<br>')} |`)] : ['No #tags yet.']),
    ...(untagged.length ? ['', `## Failures still to tag (${untagged.length})`, 'Give each one or two #tags from the table above, or a new one if none fits.', '', ...untagged.map((r) => `- ${r.set} / ${r.id}: ${r.note || '(no note)'}`)] : []),
  ];
  if (sets.length) {
    // What the judge flags, per set: interviewer-line labels that are failures, thin answers, notes missed.
    const bad = Object.entries(METRICS).filter(([k, m]) => !m.up && !m.count && !['twinAbstain', 'invented', 'thin', 'left'].includes(k)).map(([k]) => k);
    out.push('', '## What the judge flags', '', `| set | lines | ${bad.join(' | ')} | thin answers | said but not kept |`, `|---|---|${bad.map(() => '---').join('|')}|---|---|`);
    for (const s of sets) {
      const L = s.items.flatMap((i) => i.detail?.conversation?.lines ?? []);
      const A = s.items.flatMap((i) => i.detail?.conversation?.answers ?? []);
      const missed = s.items.reduce((n, i) => n + (i.detail?.notes?.missed?.length ?? 0), 0);
      out.push(`| ${s.label} | ${L.length} | ${bad.map((k) => L.filter((l: any) => l[k]).length).join(' | ')} | ${A.filter((a: any) => a.depth === 'thin').length} of ${A.length} | ${missed} |`);
    }
    out.push('', 'A type people tag often that the judge has no label for needs a new judge label; a label the judge fires often that nobody tags may be noise.');
  }
  return out.join('\n');
}
