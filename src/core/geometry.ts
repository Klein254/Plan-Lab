// Beam geometry for a head-first-supine patient (IEC 61217-style):
// gantry 0 = beam from anterior, 90 = from the patient's left, 180 = posterior, 270 = from the right.
// Couch rotation turns the patient about the vertical axis; collimator rotation turns the field in the BEV.
import type { Beam, Vec3 } from './types.ts';

export const deg = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

export interface BeamAxes {
  source: Vec3;
  dir: Vec3; // source → isocentre
  u0: Vec3; // BEV display axes (gantry + couch, no collimator): right
  v0: Vec3; // up (towards the head for gantry 0)
  u: Vec3; // collimator frame: X jaws direction
  v: Vec3; // Y jaws direction
  sad: number;
  iso: Vec3;
  collimator: number;
}

/** Rotates a vector about the patient's vertical (anterior–posterior, y) axis. */
function couchRotate(a: Vec3, angleDeg: number): Vec3 {
  const c = Math.cos(angleDeg * deg), s = Math.sin(angleDeg * deg);
  return [a[0] * c + a[2] * s, a[1], -a[0] * s + a[2] * c];
}

export function beamAxes(b: Pick<Beam, 'gantry' | 'collimator' | 'couch' | 'iso'>, sad: number): BeamAxes {
  const g = b.gantry * deg;
  let dir: Vec3 = [-Math.sin(g), Math.cos(g), 0];
  let u0: Vec3 = [Math.cos(g), Math.sin(g), 0];
  let v0: Vec3 = [0, 0, 1];
  if (b.couch) {
    dir = couchRotate(dir, -b.couch);
    u0 = couchRotate(u0, -b.couch);
    v0 = couchRotate(v0, -b.couch);
  }
  const c = b.collimator * deg;
  const u = add(scale(u0, Math.cos(c)), scale(v0, Math.sin(c)));
  const v = add(scale(u0, -Math.sin(c)), scale(v0, Math.cos(c)));
  return { source: sub(b.iso, scale(dir, sad)), dir, u0, v0, u, v, sad, iso: b.iso, collimator: b.collimator };
}

/** Projects a patient point to the isocentre plane. Returns [x, y] in the chosen frame, or null behind the source. */
export function projectToIso(ax: BeamAxes, p: Vec3, frame: 'display' | 'collimator' = 'collimator'): [number, number] | null {
  const w = sub(p, ax.source);
  const t = dot(w, ax.dir);
  if (t <= 1) return null;
  const f = ax.sad / t;
  return frame === 'collimator' ? [dot(w, ax.u) * f, dot(w, ax.v) * f] : [dot(w, ax.u0) * f, dot(w, ax.v0) * f];
}

/** Converts display-frame (gantry) BEV coordinates to the collimator frame and back. */
export function displayToColl(ax: BeamAxes, x: number, y: number): [number, number] {
  const c = ax.collimator * deg;
  return [x * Math.cos(c) + y * Math.sin(c), -x * Math.sin(c) + y * Math.cos(c)];
}
export function collToDisplay(ax: BeamAxes, x: number, y: number): [number, number] {
  const c = ax.collimator * deg;
  return [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
}

/** Point in the patient at isocentre-plane collimator coordinates (x, y), at distance t from the source along the ray. */
export function rayPoint(ax: BeamAxes, x: number, y: number, t: number): Vec3 {
  const dirRay = norm(add(scale(ax.dir, ax.sad), add(scale(ax.u, x), scale(ax.v, y))));
  return add(ax.source, scale(dirRay, t));
}

/** Distance along a ray from the source to the first point where `inside` is true (1 mm steps), or null. */
export function rayEntry(from: Vec3, dir: Vec3, inside: (p: Vec3) => boolean, maxDist: number, step = 1): number | null {
  for (let t = 0; t <= maxDist; t += step) {
    if (inside(add(from, scale(dir, t)))) {
      // refine
      let lo = Math.max(0, t - step), hi = t;
      for (let it = 0; it < 6; it++) {
        const mid = (lo + hi) / 2;
        if (inside(add(from, scale(dir, mid)))) hi = mid;
        else lo = mid;
      }
      return hi;
    }
  }
  return null;
}

export const normAngle = (a: number) => ((a % 360) + 360) % 360;

/** Field name suggestion from gantry angle. */
export function beamLabel(g: number): string {
  const a = normAngle(Math.round(g));
  const named: Record<number, string> = { 0: 'AP', 90: 'LT LAT', 180: 'PA', 270: 'RT LAT' };
  if (named[a]) return named[a];
  if (a < 90) return `LAO ${a}`;
  if (a < 180) return `LPO ${a}`;
  if (a < 270) return `RPO ${a}`;
  return `RAO ${a}`;
}
