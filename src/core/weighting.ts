// Beam weighting: preview of how weights change the dose at sample points, and a non-negative least-squares
// "suggest weights" that makes the target dose uniform while pushing organ-at-risk dose down.

/**
 * Sampled dose per field, normalised so each column is the field's dose at the point per unit of its weight
 * (i.e. per unit dose at the normalisation point). Rows are sample points.
 */
export interface FieldMatrix {
  rows: number;
  cols: number;
  a: Float64Array; // row-major rows × cols
}

export function matrix(rows: number, cols: number): FieldMatrix {
  return { rows, cols, a: new Float64Array(rows * cols) };
}

/** Relative dose (fraction of the normalisation dose) at every row for weights w: Σ w_b N_b(x) / Σ w_b. */
export function relativeDose(m: FieldMatrix, w: number[]): Float64Array {
  const W = w.reduce((s, v) => s + Math.max(0, v), 0) || 1;
  const out = new Float64Array(m.rows);
  for (let r = 0; r < m.rows; r++) {
    let s = 0;
    for (let c = 0; c < m.cols; c++) s += Math.max(0, w[c]) * m.a[r * m.cols + c];
    out[r] = s / W;
  }
  return out;
}

export interface WeightGoal {
  target: FieldMatrix; // rows inside the target
  oars: { m: FieldMatrix; importance: number }[]; // 0 = ignore … 3 = strong
  hot?: FieldMatrix; // points anywhere the fields reach (body hot-spot candidates), penalised above 105% of the target level
  /** Pull towards the starting weights (0 = none). Keeps suggestions close to the student's set-up instead of dropping fields. */
  stayNear?: number;
}

/**
 * Suggested weights (w ≥ 0, largest = 1). The dose is renormalised so the target mean is 1, then the cost is:
 *   target non-uniformity (variance) + 30·(hot spot above 105%)² + Σ importance·¼·(organ mean)² + stayNear·(change of share)².
 * Only a handful of fields are involved, so a direct pattern search on this exact cost is used: it is robust to the
 * non-smooth hot-spot maximum, which averaged gradient penalties under-weight.
 */
export function suggestWeights(goal: WeightGoal, start?: number[]): number[] {
  const n = goal.target.cols;
  const rowsDose = (m: FieldMatrix, w: number[]) => {
    const out = new Float64Array(m.rows);
    for (let r = 0; r < m.rows; r++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += w[c] * m.a[r * n + c];
      out[r] = s;
    }
    return out;
  };
  const shares = (w: number[]) => { const S = w.reduce((a, b) => a + b, 0) || 1; return w.map((x) => x / S); };
  const w0 = (start && start.length === n ? start : new Array(n).fill(1)).map((v) => Math.max(0, v));
  const p0 = shares(w0);
  const lam = goal.stayNear ?? 0;
  const cost = (w: number[]) => {
    const t = rowsDose(goal.target, w);
    let mean = 0;
    for (const x of t) mean += x;
    mean /= Math.max(1, t.length);
    if (mean <= 0) return Infinity;
    let c = 0;
    for (const x of t) c += (x / mean - 1) ** 2;
    c /= Math.max(1, t.length);
    if (goal.hot && goal.hot.rows) {
      let mx = 0;
      for (const x of rowsDose(goal.hot, w)) if (x > mx) mx = x;
      const over = mx / mean - 1.05;
      if (over > 0) c += 30 * over * over;
    }
    for (const o of goal.oars) {
      if (!o.importance || !o.m.rows) continue;
      let s = 0;
      for (const x of rowsDose(o.m, w)) s += x;
      const om = s / o.m.rows / mean;
      c += o.importance * 0.25 * om * om;
    }
    if (lam) {
      const p = shares(w);
      for (let k = 0; k < n; k++) c += lam * (p[k] - p0[k]) ** 2;
    }
    return c;
  };
  let w = shares(w0.some((x) => x > 0) ? w0 : new Array(n).fill(1));
  let best = cost(w);
  let step = 0.25;
  while (step > 0.002) {
    let improved = false;
    for (let k = 0; k < n; k++) {
      for (const dir of [1, -1]) {
        const trial = [...w];
        trial[k] = Math.max(0, trial[k] + dir * step);
        const t = shares(trial);
        const ct = cost(t);
        if (ct < best - 1e-12) { best = ct; w = t; improved = true; }
      }
    }
    if (!improved) step /= 2;
  }
  const mx = Math.max(...w);
  return mx > 0 ? w.map((v) => Math.round((v / mx) * 100) / 100) : new Array(n).fill(1);
}

/** Summary statistics of relative dose rows. */
export function stats(v: Float64Array): { min: number; mean: number; max: number } {
  if (!v.length) return { min: 0, mean: 0, max: 0 };
  let mn = Infinity, mx = -Infinity, s = 0;
  for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; s += x; }
  return { min: mn, mean: s / v.length, max: mx };
}
