// Exact Euclidean distance transforms (Felzenszwalb & Huttenlocher) with anisotropic voxel spacing.

const INF = 1e20;

function edt1d(f: Float64Array, n: number, s: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + (q * s) * (q * s);
    let x: number;
    for (;;) {
      const p = v[k];
      x = (fq - (f[p] + (p * s) * (p * s))) / (2 * s * (q - p));
      if (x <= z[k] && k > 0) k--;
      else break;
    }
    if (x <= z[k]) {
      // k === 0 and parabola q dominates from -inf
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = x;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q * s) k++;
    const p = v[k];
    const dq = (q - p) * s;
    d[q] = dq * dq + f[p];
  }
}

/**
 * Squared distance (mm²) from each voxel to the nearest voxel where feature[p] is set.
 * dims = [nx, ny, nz], spacing in mm. With nz = 1 this is a 2D transform.
 */
export function edtSquared(feature: Uint8Array, dims: [number, number, number], spacing: [number, number, number]): Float32Array {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  for (let p = 0; p < out.length; p++) out[p] = feature[p] ? 0 : INF;
  const maxN = Math.max(nx, ny, nz);
  const f = new Float64Array(maxN), d = new Float64Array(maxN), z = new Float64Array(maxN + 1);
  const v = new Int32Array(maxN);
  const pass = (n: number, s: number, count: number, base: (c: number) => number, stride: number) => {
    if (n === 1) return;
    for (let c = 0; c < count; c++) {
      const b = base(c);
      let any = false;
      for (let q = 0; q < n; q++) {
        f[q] = out[b + q * stride];
        if (f[q] < INF) any = true;
      }
      if (!any) continue;
      edt1d(f, n, s, d, v, z);
      for (let q = 0; q < n; q++) out[b + q * stride] = d[q];
    }
  };
  // x lines
  pass(nx, spacing[0], ny * nz, (c) => c * nx, 1);
  // y lines
  pass(ny, spacing[1], nx * nz, (c) => (c % nx) + Math.floor(c / nx) * nx * ny, nx);
  // z lines
  pass(nz, spacing[2], nx * ny, (c) => c, nx * ny);
  return out;
}

/** Signed distance (mm) for a 2D mask: negative inside, positive outside, ~0 at the boundary. */
export function signedDistance2D(m: Uint8Array, w: number, h: number, sx: number, sy: number): Float32Array {
  const inv = new Uint8Array(m.length);
  for (let p = 0; p < m.length; p++) inv[p] = m[p] ? 0 : 1;
  const dOut = edtSquared(m, [w, h, 1], [sx, sy, 1]);
  const dIn = edtSquared(inv, [w, h, 1], [sx, sy, 1]);
  const out = new Float32Array(m.length);
  for (let p = 0; p < m.length; p++) {
    out[p] = m[p] ? -(Math.sqrt(dIn[p]) - 0.5 * Math.min(sx, sy)) : Math.sqrt(dOut[p]) - 0.5 * Math.min(sx, sy);
  }
  return out;
}
