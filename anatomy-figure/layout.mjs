/**
 * World, camera and shared drawing context for the hump-yard figure.
 *
 * The subject is `omp-role-fleet`'s dispatcher: a task becomes a dependency
 * ordered plan; each wave of seats goes out as one parallel batch; a static gate
 * decides before anything is written; every settled report is placed at its
 * artifact path before the next wave starts; and the newest ten run directories
 * are kept. All of that is built as a railway hump yard on a bench.
 *
 * Units are world units of about one screen px at fit scale: x and y on the
 * floor, z up. Every number here is geometry, not truth-by-accident: the repo's
 * own numbers live in `model.mjs`.
 */
import * as k from "./vendor/anatomy/kit/iso-kit.mjs";
import * as G from "./vendor/anatomy/kit/lathe.mjs";
import * as A from "./vendor/anatomy/kit/audit.mjs";
import { tubePieces, tubeSvg, runsOf, crossingsOf } from "./vendor/anatomy/kit/tube.mjs";

export { k, G, A, tubePieces, tubeSvg, runsOf, crossingsOf };

export const WIDTH = 640;
export const HEIGHT = 400;

/** The bench the whole yard stands on. */
export const PLATE = { x: -186, y: -66, w: 392, d: 158, r: 10 };
export const PLATE_H = 12;
export const FOOT_H = 5;

/** Track: rail centres sit GAUGE apart; every rail is a tube of radius RAIL_R. */
export const GAUGE = 8.2;
export const RAIL_R = 1.1;
/** Rail centre height above the ground under it (sleeper + rail). */
export const RAIL_LIFT = 3.1;

/** Approach bank: the cut is pushed up this far bank to the crest. */
export const BANK = { y0: -15, y1: 15, x0: -176, x1: -40 };
/** Flat crest: where the retarder (the gate) sits, with its walkway. */
export const CREST = { x0: -40, x1: -6, top: 18.9 };
/** Descending face: the fan, where the wave's seats spread to their roads. */
export const WEDGE = { x0: -6, x1: 96, y0: -58, y1: 58 };
/** Level classification roads. */
export const ROAD = { x0: 96, x1: 176 };

/** The role cap: four roads, one per seat the default cast can carry at once. */
export const ROADS = [
  { id: 0, y: -39 },
  { id: 1, y: -13 },
  { id: 2, y: 13 },
  { id: 3, y: 39 },
];

/** Switches. The crest pair splits into two pairs at S1, each pair into two roads at S2. */
export const S1 = { x: 12 };
export const S2 = { x: 50 };
/** Lateral offset of the two intermediate pairs from the crest pair. */
export const PAIR = 26;
/** Where the crest track starts, and the buffer stop behind the cut. */
export const APPROACH = { x: -176 };
export const BUFFER = { road: 176, approach: -178 };

/** The cripple siding the report van is loaded on. */
export const SIDING = { y: 60, x0: 116, x1: 176 };

/** Where the gantry crane straddles the roads. */
export const GANTRY = { x: 140, y0: -52, y1: 80, beam: 54, leg: 62 };

/** Control desk on the bench, clear of the bank. */
export const DESK = { x: -180, y: -64, w: 66, d: 28, top: 15 };

/** Rail centre height at the ground level of a given ground height. */
export const railZ = (ground) => ground + RAIL_LIFT;
/** Ground height of the wedge's top face at x (0 on the flat roads). */
export const wedgeTop = (x) => (x <= WEDGE.x0 ? CREST.top : x >= WEDGE.x1 ? 0 : (CREST.top * (WEDGE.x1 - x)) / (WEDGE.x1 - WEDGE.x0));
/** Rail centre height for a track at x, riding the bank, the crest or the wedge. */
export const trackZ = (x) => {
  if (x <= BANK.x1) return railZ((CREST.top * (x - BANK.x0)) / (BANK.x1 - BANK.x0));
  if (x <= CREST.x1) return railZ(CREST.top);
  return railZ(wedgeTop(x));
};

export const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [GANTRY.x, GANTRY.y1, GANTRY.beam + 12],
    [CREST.x0 - 6, CREST.y0 ?? 0, CREST.top + 4],
    [DESK.x, DESK.y, DESK.top + 4],
    [SIDING.x1, SIDING.y + 6, 8],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 40 },
);

export const at = (point) => k.iso(point, P);
export const S = (paths, style) => k.solidSvg(paths, style);
export const L = (d, style) => k.lineSvg(d, style);
export const D = (points, style) => k.dotsSvg(points, style);
export const byDepth = (points) =>
  [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
export const frame = (o, axis) => G.frameAlong(o, axis);

/** One recorded item: `put` forwards to the audit recorder in `build.mjs`. */
export function context(recorder) {
  const put = (item) => {
    recorder.put(item);
    return item;
  };
  return {
    P,
    put,
    k,
    G,
    A,
    R: recorder,
    at,
    S,
    L,
    D,
    byDepth,
    frame,
    /** Record a floor prism and return its shape, as the kit's own helpers do. */
    slab: (plan, z, h, meta, steps = 8) => recorder.solid(A.slab(plan, z, h, meta, steps)),
    cyl: (cx, cy, r, z, h, meta) => recorder.solid(A.cylinder(cx, cy, r, z, h, meta)),
    box: (min, max, meta) => recorder.solid(A.box(min, max, meta)),
    ball: (centre, r, meta) => recorder.solid(A.ball(centre, r, meta)),
    solid: (F, profile, meta) => recorder.solid(A.solid(F, profile, meta)),
    disc: (F, s0, s1, r, meta) => recorder.solid(A.disc(F, s0, s1, r, meta)),
    ring: (F, s0, s1, rIn, rOut, meta) => recorder.solid(A.ring(F, s0, s1, rIn, rOut, meta)),
    tube: (points, radius, meta) => recorder.solid(A.tube(points, radius, meta)),
    route: (name, points, radius, opts) => recorder.route(name, points, radius, opts),
  };
}