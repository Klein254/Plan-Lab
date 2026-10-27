// 2D raster helpers: iso-lines (marching squares), polygon filling, hole filling, connected components.
// Pixel (x, y) has its centre at coordinates (x, y).

type Grid = ArrayLike<number>;

/**
 * Marching squares. Returns line segments [x1,y1,x2,y2,...] separating values >= level from values < level.
 * The grid is treated as surrounded by values below the level, so outlines always close.
 */
export function isoSegments(data: Grid, w: number, h: number, level: number): Float32Array {
  const out: number[] = [];
  const v = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -Infinity : data[x + y * w]);
  const lerp = (a: number, b: number) => {
    if (!isFinite(a)) return 1;
    if (!isFinite(b)) return 0;
    const t = (level - a) / (b - a);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = v(x, y), tr = v(x + 1, y), br = v(x + 1, y + 1), bl = v(x, y + 1);
      const c = ((tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0));
      if (c === 0 || c === 15) continue;
      // Edge crossing points
      const T = () => [x + lerp(tl, tr), y];
      const R = () => [x + 1, y + lerp(tr, br)];
      const B = () => [x + lerp(bl, br), y + 1];
      const L = () => [x, y + lerp(tl, bl)];
      const seg = (a: number[], b: number[]) => out.push(a[0], a[1], b[0], b[1]);
      switch (c) {
        case 1: case 14: seg(L(), B()); break;
        case 2: case 13: seg(B(), R()); break;
        case 3: case 12: seg(L(), R()); break;
        case 4: case 11: seg(T(), R()); break;
        case 6: case 9: seg(T(), B()); break;
        case 7: case 8: seg(L(), T()); break;
        case 5: seg(L(), T()); seg(B(), R()); break;
        case 10: seg(T(), R()); seg(L(), B()); break;
      }
    }
  }
  return Float32Array.from(out);
}

/** Joins marching-squares segments into polylines (closed loops repeat their first point at the end). */
export function chainSegments(seg: Float32Array): number[][] {
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const n = seg.length / 4;
  const adj = new Map<string, number[]>();
  for (let s = 0; s < n; s++) {
    for (const e of [0, 1]) {
      const k = key(seg[s * 4 + e * 2], seg[s * 4 + e * 2 + 1]);
      let l = adj.get(k);
      if (!l) adj.set(k, (l = []));
      l.push(s);
    }
  }
  const used = new Uint8Array(n);
  const lines: number[][] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const pts = [seg[s0 * 4], seg[s0 * 4 + 1], seg[s0 * 4 + 2], seg[s0 * 4 + 3]];
    // Walk forward from the end point
    for (;;) {
      const ex = pts[pts.length - 2], ey = pts[pts.length - 1];
      const cand = adj.get(key(ex, ey))?.find((t) => !used[t]);
      if (cand === undefined) break;
      used[cand] = 1;
      const a = [seg[cand * 4], seg[cand * 4 + 1]], b = [seg[cand * 4 + 2], seg[cand * 4 + 3]];
      const next = key(a[0], a[1]) === key(ex, ey) ? b : a;
      pts.push(next[0], next[1]);
    }
    lines.push(pts);
  }
  return lines;
}

/** Fills a polygon (even-odd rule) into a w×h raster, setting pixels whose centre lies inside to `value`. */
export function fillPolygon(target: Uint8Array, w: number, h: number, pts: number[], value: number) {
  const n = pts.length / 2;
  if (n < 3) return;
  let ymin = Infinity, ymax = -Infinity;
  for (let p = 0; p < n; p++) {
    ymin = Math.min(ymin, pts[p * 2 + 1]);
    ymax = Math.max(ymax, pts[p * 2 + 1]);
  }
  const y0 = Math.max(0, Math.ceil(ymin)), y1 = Math.min(h - 1, Math.floor(ymax));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0;
    for (let p = 0; p < n; p++) {
      const ax = pts[p * 2], ay = pts[p * 2 + 1];
      const q = (p + 1) % n;
      const bx = pts[q * 2], by = pts[q * 2 + 1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const xa = Math.max(0, Math.ceil(xs[s])), xb = Math.min(w - 1, Math.floor(xs[s + 1]));
      if (xb >= xa) target.fill(value, y * w + xa, y * w + xb + 1);
    }
  }
}

/** Fills enclosed holes in a binary raster in place (4-connected background flood from the border). */
export function fillHoles2D(m: Uint8Array, w: number, h: number) {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!m[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push(x + (h - 1) * w);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  for (let p = 0; p < m.length; p++) if (!m[p] && !outside[p]) m[p] = 1;
}

/** 4-connected component labels for a binary raster. Returns labels (0 = background) and the size of each label. */
export function components2D(m: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack: number[] = [];
  let next = 1;
  for (let p0 = 0; p0 < m.length; p0++) {
    if (!m[p0] || labels[p0]) continue;
    const lab = next++;
    let size = 0;
    labels[p0] = lab;
    stack.push(p0);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && m[q] && !labels[q]) {
        labels[q] = lab;
        stack.push(q);
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Area-weighted signed area of a closed polyline (positive = counter-clockwise in y-up coordinates). */
export function polygonArea(pts: number[]): number {
  let a = 0;
  const n = pts.length / 2;
  for (let p = 0; p < n; p++) {
    const q = (p + 1) % n;
    a += pts[p * 2] * pts[q * 2 + 1] - pts[q * 2] * pts[p * 2 + 1];
  }
  return a / 2;
}

/** Douglas–Peucker simplification of an open or closed polyline. */
export function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wd = t2;
    for (let p = a + 1; p < b; p++) {
      const px = pts[p * 2] - ax, py = pts[p * 2 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > wd) {
        wd = d;
        worst = p;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let p = 0; p < n; p++) if (keep[p]) out.push(pts[p * 2], pts[p * 2 + 1]);
  return out;
}
