// Small-sample statistics for comparing two versions of the interviewer.
// Runs are paired (same person, same seed) where possible, and resampled by person (a cluster
// bootstrap), because two seeds of one person are not independent evidence.

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// Deterministic PRNG so reports don't wobble between runs of the same data.
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// 95% interval for the mean of per-cluster values (each cluster = one person's list of numbers).
export function clusterCI(clusters: number[][], iters = 4000): { mean: number; lo: number; hi: number; pAbove0: number } {
  const cs = clusters.filter((c) => c.length);
  const flat = cs.flat();
  if (!cs.length) return { mean: NaN, lo: NaN, hi: NaN, pAbove0: NaN };
  const r = rng();
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    const pick: number[] = [];
    for (let k = 0; k < cs.length; k++) {
      const c = cs[Math.floor(r() * cs.length)];
      for (let j = 0; j < c.length; j++) pick.push(c[Math.floor(r() * c.length)]);
    }
    means.push(mean(pick));
  }
  means.sort((a, b) => a - b);
  return { mean: mean(flat), lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)], pAbove0: means.filter((m) => m > 0).length / iters };
}

export type Verdict = 'better' | 'worse' | "can't tell";

// Paired difference B − A for one metric. `higherIsBetter` decides what "better" means.
export function pairedDiff(pairs: { cluster: string; a: number; b: number }[], higherIsBetter = true) {
  const by = new Map<string, number[]>();
  for (const p of pairs) if (Number.isFinite(p.a) && Number.isFinite(p.b)) by.set(p.cluster, [...(by.get(p.cluster) ?? []), p.b - p.a]);
  const ci = clusterCI([...by.values()]);
  const sign = higherIsBetter ? 1 : -1;
  // Better/worse only when the whole 95% interval is on one side of zero.
  const [lo, hi] = [ci.lo * sign, ci.hi * sign].sort((x, y) => x - y);
  const verdict: Verdict = lo > 0 ? 'better' : hi < 0 ? 'worse' : "can't tell";
  return { n: pairs.length, people: by.size, ...ci, verdict };
}

// How big a difference n runs per arm could reliably detect (80% power, 5% two-sided), given the
// spread of paired differences. Rule of thumb: 2.8 × sd / √n.
export const minDetectable = (sdDiff: number, n: number) => (2.8 * sdDiff) / Math.sqrt(n);

// Agreement between two labelers on yes/no labels: raw agreement and Cohen's kappa.
export function kappa(a: boolean[], b: boolean[]) {
  const n = Math.min(a.length, b.length);
  if (!n) return { n: 0, agree: NaN, kappa: NaN };
  let same = 0;
  let pa = 0;
  let pb = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) same++;
    if (a[i]) pa++;
    if (b[i]) pb++;
  }
  const po = same / n;
  const pe = (pa / n) * (pb / n) + (1 - pa / n) * (1 - pb / n);
  return { n, agree: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

// Pearson correlation.
export function corr(x: number[], y: number[]) {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// pass^k (τ-bench): the chance that k fresh tries with the same person ALL succeed, estimated per
// person from c successes in n tries as C(c,k)/C(n,k), then averaged. pass^1 is the plain success
// rate; the drop from pass^1 to pass^k is how unreliable the interviewer is for the same person.
const choose = (n: number, k: number) => (k > n ? 0 : Array.from({ length: k }, (_, i) => (n - i) / (k - i)).reduce((a, b) => a * b, 1));
export const passK = (tries: { n: number; c: number }[], k: number) => mean(tries.filter((t) => t.n >= k).map((t) => choose(t.c, k) / choose(t.n, k)));
