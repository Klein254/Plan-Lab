// Binary structure masks on the CT grid, stored slice by slice so empty slices cost nothing.

export class Mask {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  slices: (Uint8Array | null)[];
  version = 0;

  constructor(nx: number, ny: number, nz: number, slices?: (Uint8Array | null)[]) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.slices = slices ?? new Array(nz).fill(null);
  }

  get(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    const s = this.slices[k];
    return s ? s[i + this.nx * j] : 0;
  }

  set(i: number, j: number, k: number, v: number) {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return;
    let s = this.slices[k];
    if (!s) {
      if (!v) return;
      s = this.slices[k] = new Uint8Array(this.nx * this.ny);
    }
    s[i + this.nx * j] = v ? 1 : 0;
  }

  /** The slice array, created if `create` (otherwise null when empty). */
  slice(k: number, create = false): Uint8Array | null {
    let s = this.slices[k];
    if (!s && create) s = this.slices[k] = new Uint8Array(this.nx * this.ny);
    return s ?? null;
  }

  /** Drops slices that hold no voxels so they stop costing memory and count as empty. */
  compact(k?: number) {
    const ks = k === undefined ? this.slices.keys() : [k];
    for (const z of ks) {
      const s = this.slices[z];
      if (s && !hasAny(s)) this.slices[z] = null;
    }
  }

  hasSlice(k: number): boolean {
    const s = this.slices[k];
    return !!s && hasAny(s);
  }

  isEmpty(): boolean {
    return this.slices.every((s) => !s || !hasAny(s));
  }

  private countCache = { version: -1, value: 0 };

  /** Number of set voxels (cached per version; edits must bump `version`). */
  count(): number {
    if (this.countCache.version === this.version) return this.countCache.value;
    let n = 0;
    for (const s of this.slices) if (s) for (let p = 0; p < s.length; p++) n += s[p];
    this.countCache = { version: this.version, value: n };
    return n;
  }

  clone(): Mask {
    const m = new Mask(this.nx, this.ny, this.nz, this.slices.map((s) => (s ? s.slice() : null)));
    m.version = this.version + 1;
    return m;
  }

  clear() {
    this.slices.fill(null);
    this.version++;
  }

  /** Inclusive voxel bounds [i0,i1,j0,j1,k0,k1], or null when empty. */
  bounds(): [number, number, number, number, number, number] | null {
    let i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1, k0 = Infinity, k1 = -1;
    const { nx, ny } = this;
    this.slices.forEach((s, k) => {
      if (!s) return;
      let any = false;
      for (let j = 0; j < ny; j++) {
        const row = j * nx;
        for (let i = 0; i < nx; i++) {
          if (s[row + i]) {
            any = true;
            if (i < i0) i0 = i;
            if (i > i1) i1 = i;
            if (j < j0) j0 = j;
            if (j > j1) j1 = j;
          }
        }
      }
      if (any) {
        if (k < k0) k0 = k;
        if (k > k1) k1 = k;
      }
    });
    return k1 < 0 ? null : [i0, i1, j0, j1, k0, k1];
  }

  /** Visits every set voxel. */
  forEach(fn: (i: number, j: number, k: number) => void) {
    const { nx } = this;
    this.slices.forEach((s, k) => {
      if (!s) return;
      for (let p = 0; p < s.length; p++) if (s[p]) fn(p % nx, (p / nx) | 0, k);
    });
  }

  /** Copies another mask's content into this one (same grid). */
  assign(other: Mask) {
    this.slices = other.slices.map((s) => (s ? s.slice() : null));
    this.version++;
  }
}

function hasAny(s: Uint8Array): boolean {
  // Check 8 bytes at a time where aligned
  const n8 = s.length >> 3;
  if (s.byteOffset % 4 === 0) {
    const u32 = new Uint32Array(s.buffer, s.byteOffset, n8 * 2);
    for (let p = 0; p < u32.length; p++) if (u32[p]) return true;
    for (let p = n8 * 8; p < s.length; p++) if (s[p]) return true;
    return false;
  }
  for (let p = 0; p < s.length; p++) if (s[p]) return true;
  return false;
}

/** Run-length encodes a mask (alternating zero/one run lengths over the whole volume, zero first). */
export function encodeMask(m: Mask): Uint32Array {
  const runs: number[] = [];
  let cur = 0;
  let run = 0;
  const sliceLen = m.nx * m.ny;
  for (let k = 0; k < m.nz; k++) {
    const s = m.slices[k];
    if (!s) {
      if (cur === 0) run += sliceLen;
      else {
        runs.push(run);
        cur = 0;
        run = sliceLen;
      }
      continue;
    }
    for (let p = 0; p < sliceLen; p++) {
      const v = s[p] ? 1 : 0;
      if (v === cur) run++;
      else {
        runs.push(run);
        cur = v;
        run = 1;
      }
    }
  }
  runs.push(run);
  return Uint32Array.from(runs);
}

export function decodeMask(runs: Uint32Array, nx: number, ny: number, nz: number): Mask {
  const m = new Mask(nx, ny, nz);
  const sliceLen = nx * ny;
  let pos = 0;
  let v = 0;
  for (let r = 0; r < runs.length; r++) {
    const len = runs[r];
    if (v) {
      let p = pos;
      const end = pos + len;
      while (p < end) {
        const k = Math.floor(p / sliceLen);
        const off = p - k * sliceLen;
        const take = Math.min(end - p, sliceLen - off);
        m.slice(k, true)!.fill(1, off, off + take);
        p += take;
      }
    }
    pos += len;
    v ^= 1;
  }
  return m;
}
