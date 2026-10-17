/**
 * The truth model: what `omp-role-fleet` actually does, and where every part of
 * the figure is at any moment.
 *
 * Zero imports on purpose. This module is the single source of both the geometry
 * the build draws and the motion the page plays: `build.mjs` inlines this file's
 * own source into the page, so the readout, the wagons and the crane cannot
 * disagree about which wave is running.
 *
 * Numbers, all from the repository:
 * - `wave.cap` is `DEFAULT_MAX_ROLES` (`src/core.ts`), `ceiling` is the hard
 *   `MAX_ROLES` in the extension entry.
 * - The cast and the dependencies are the base cast of `synthesizePlan`
 *   (`src/synthesize.ts`) for a code task that names no multi-file scope:
 *   scout → implementer → tester + reviewer, where the tester and the reviewer
 *   depend on the implementer and therefore leave in the same wave.
 * - `validatePlan` (`src/core.ts`) refuses a plan with no model, no acceptance
 *   criteria, no artifact path or an undeclared dependency: the gate's four
 *   checks.
 * - Read-only seats cannot place their own report, so the orchestrator writes
 *   every settled report at its path before the next wave starts (README,
 *   "Reports are full or absent").
 * - `RUN_DIR_RETENTION` (`src/pipeline.ts`) keeps the newest ten run
 *   directories.
 */

export const PLAN = {
  task: "fix the auth bug",
  cap: 4,
  ceiling: 8,
  retention: 10,
  checks: ["model", "acceptance", "artifact", "deps"],
  waves: [
    {
      n: 1,
      seats: [{ id: "scout", alias: "@smol", artifact: "scout.md", grant: "read", deps: [] }],
    },
    {
      n: 2,
      seats: [
        { id: "implementer", alias: "@task", artifact: "implementation.md", grant: "write", deps: ["scout"] },
      ],
    },
    {
      n: 3,
      seats: [
        { id: "tester", alias: "@smol", artifact: "test-report.md", grant: "write", deps: ["implementer"] },
        { id: "reviewer", alias: "@slow", artifact: "review.md", grant: "read", deps: ["implementer"] },
      ],
    },
  ],
};

/** Track geometry the motion and the rails share. */
export const TRACK = {
  gauge: 8.2,
  lift: 3.1,
  bank: { x0: -176, x1: -40 },
  crest: { x0: -40, x1: -6, top: 18.9 },
  wedge: { x0: -6, x1: 96 },
  roads: [
    { id: 0, y: -39, seat: "scout" },
    { id: 1, y: -13, seat: "implementer" },
    { id: 2, y: 13, seat: "tester" },
    { id: 3, y: 39, seat: "reviewer" },
  ],
  pair: 26,
  s1: 12,
  s2: 50,
  road: { x0: 96, x1: 176 },
  siding: { y: 60, x0: 116, x1: 176 },
  /** Where each wagon rests before its wave is pushed. */
  rest: -138,
  /** Where the engine waits between waves. */
  engineRest: -152,
  /** How far down its road a wagon runs: under the gantry. */
  unload: 150,
};

/** Ground height of the wedge at x, 0 on the level roads. */
export function wedgeTop(x) {
  const { wedge, crest } = TRACK;
  if (x <= wedge.x0) return crest.top;
  if (x >= wedge.x1) return 0;
  return (crest.top * (wedge.x1 - x)) / (wedge.x1 - wedge.x0);
}

/** Rail-centre height at x along the bank, the crest and the wedge. */
export function trackZ(x) {
  const { bank, crest, lift } = TRACK;
  if (x <= bank.x1) return lift + (crest.top * (x - bank.x0)) / (bank.x1 - bank.x0);
  if (x <= crest.x1) return lift + crest.top;
  return lift + wedgeTop(x);
}

/** The seat's road: each seat keeps its own road, so a wave's seats never collide. */
export function roadOf(seat) {
  const road = TRACK.roads.find((r) => r.seat === seat);
  if (!road) throw new Error(`no road for seat ${seat}`);
  return road;
}

/**
 * A seat's path: the crest track from the rest position, over the hump, then the
 * turnout that walks it out to its own road, then the run to the unloading spot.
 * The lateral shift happens between `s1` and `s2` — inside the fan, as a real
 * turnout does — so the wagon's yaw stays small.
 */
export function seatPath(seat) {
  const road = roadOf(seat);
  const { crest, wedge, road: level, s1, s2, unload, pair, lift } = TRACK;
  return [
    [TRACK.rest, 0, trackZ(TRACK.rest)],
    [crest.x0, 0, trackZ(crest.x0)],
    [crest.x1, 0, trackZ(crest.x1)],
    [s1, 0, trackZ(s1)],
    [s2, pair * Math.sign(road.y), trackZ(s2)],
    [level.x0, road.y, trackZ(level.x0)],
    [unload, road.y, trackZ(unload)],
  ].filter((point, index, all) => index === 0 || Math.abs(point[0] - all[index - 1][0]) > 1e-6 || Math.abs(point[1] - all[index - 1][1]) > 1e-6);
}

/** Arc-length positions of each control point of a path, for travel along it. */
export function pathPoints(points) {
  const out = [{ at: 0, point: points[0] }];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push({ at: total, point: b });
  }
  return { points, spans: out, length: total };
}

/** Position and yaw at arc length `s` of a path: floor-space point and heading. */
export function along(path, s) {
  const { points, length } = path;
  const want = Math.max(0, Math.min(length, s));
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const leg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (travelled + leg >= want || i === points.length - 1) {
      const t = leg === 0 ? 0 : Math.max(0, Math.min(1, (want - travelled) / leg));
      const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
      return {
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        z: a[2] + (b[2] - a[2]) * t,
        theta,
      };
    }
    travelled += leg;
  }
  const end = points[points.length - 1];
  return { x: end[0], y: end[1], z: end[2], theta: 0 };
}

/** Timing of one wave, in seconds. */
export const TIMING = { push: 2.8, gate: 1.3, stagger: 0.62, run: 2.9, place: 1.9, settle: 0.9, hold: 8 };

/** Smoothstep, so nothing in the figure starts or stops dead. */
export const ease = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/** The run's timeline: one entry per wave, in order. */
export function timeline() {
  const out = [];
  let at = 0;
  for (const wave of PLAN.waves) {
    const start = at;
    const pushEnd = start + TIMING.push;
    const gateEnd = pushEnd + TIMING.gate;
    const arrival = wave.seats.map((_, i) => gateEnd + i * TIMING.stagger + TIMING.run);
    const unload = arrival.map((a) => a + TIMING.place);
    const end = Math.max(...unload) + TIMING.settle;
    out.push({ wave, start, pushEnd, gateEnd, arrival, unload, end });
    at = end;
  }
  return out;
}

export const RUN_SECONDS = timeline()[timeline().length - 1].end;

/**
 * Every wagon's path, built once: the same polylines the rails are drawn along.
 */
export const PATHS = Object.fromEntries(
  PLAN.waves.flatMap((w) => w.seats.map((s) => [s.id, pathPoints(seatPath(s.id))])),
);

/** Where a wagon of this wave sits before the push: coupled, engine behind. */
function restOrder(wave) {
  return wave.seats.map((seat, index) => ({ seat, index }));
}

/**
 * The figure's whole state at time `t` (seconds into the run) for the given gate
 * verdict. Pure: no clocks, no DOM, no randomness.
 */
export function stateAt(t, { verdict = "approve", cycle = 0 } = {}) {
  const waves = timeline();
  const clamped = Math.max(0, Math.min(RUN_SECONDS, t));
  const entry = waves.find((w) => clamped < w.end) ?? waves[waves.length - 1];
  const { wave, start, pushEnd, gateEnd, arrival, end } = entry;
  const held = verdict === "reject";
  const gateDone = held ? clamped >= pushEnd : clamped >= gateEnd;

  // Where the cut is: coupled behind the crest before the push, at the crest
  // through the gate, then each wagon leaves on its own.
  const push = ease((clamped - start) / TIMING.push);
  const cutLead = held ? Math.min(push, 1) : Math.min(push, 1);
  const seats = restOrder(wave).map(({ seat, index }) => {
    const path = PATHS[seat.id];
    const crestAt = path.length - (TRACK.unload - TRACK.crest.x1);
    const restS = 0;
    if (held && clamped >= pushEnd) {
      const at = along(path, crestAt - index * 0 + restS);
      return { ...seat, state: "held", ...at, s: crestAt };
    }
    const release = gateEnd + index * TIMING.stagger;
    if (clamped < release) {
      // Still in the cut: the whole cut advances together to the crest.
      const s = restS + (crestAt - restS) * cutLead - index * 0;
      return { ...seat, state: "coupled", ...along(path, s), s };
    }
    const travel = (clamped - release) / TIMING.run;
    const s = crestAt + (path.length - crestAt) * ease(travel);
    const done = travel >= 1;
    return { ...seat, state: done ? "arrived" : "running", ...along(path, s), s };
  });

  // The engine: pushes the cut to the crest, then runs back down the bank for
  // the next one. It never enters the fan.
  const engineX = clamped < pushEnd ? TRACK.rest - 62 + (TRACK.rest - 62 - (TRACK.rest - 62)) * 0 : null;
  const engineS =
    clamped < pushEnd
      ? ease((clamped - start) / TIMING.push) * (crestLeadS() - engineRestS())
      : Math.max(0, 1 - ease((clamped - pushEnd) / (TIMING.run + TIMING.place)));
  const enginePath = PATHS[wave.seats[0].id];
  const engineAt = along(enginePath, engineRestS() + engineS * (crestLeadS() - engineRestS()));

  // The retarder grips the leading wagon as it passes the crest.
  const grip =
    clamped < pushEnd
      ? ease((clamped - (pushEnd - 0.5)) / 0.5)
      : clamped < gateEnd
        ? 1
        : Math.max(0, 1 - ease((clamped - gateEnd) / 1.2));

  // The gantry crane: one lift per wagon, in arrival order, travelling out to
  // the report van on the cripple siding.
  const jobs = wave.seats
    .map((seat, index) => ({ seat, index, from: arrival[index], to: unloadAt(index) }))
    .filter((job) => clamped >= job.from);
  const job = jobs.find((j) => clamped < j.to) ?? null;
  const crane = craneState({ jobs, job, clamped, seats });
  const placed = job ? Math.max(0, jobs.indexOf(job)) : jobs.length;

  const readout = readoutFor({ wave, seats, crane, job, placed, held, clamped, pushEnd, gateEnd, cycle });

  return {
    cycle,
    t: clamped,
    wave: wave.n,
    phase: clamped < pushEnd ? "push" : clamped < gateEnd ? "gate" : job ? "place" : "run",
    verdict,
    held,
    seats,
    engine: { ...engineAt, x: engineAt.x },
    retarder: grip,
    signal: clamped < gateEnd ? (held ? "red" : "green") : "green",
    crane,
    report: REPORT_STACK.slice(0, index => 0).length + crane.loaded.length,
    placed,
    tickets: Math.min(PLAN.retention, cycle + 1),
    readout,
  };

  function crestLeadS() {
    const path = PATHS[wave.seats[0].id];
    return path.length - (TRACK.unload - TRACK.crest.x1);
  }
  function engineRestS() {
    return 12;
  }
  function unloadAt(index) {
    return arrival[index] + TIMING.place;
  }
}

/** A stable list for the van's stack: one slot per seat, in plan order. */
export const REPORT_STACK = PLAN.waves.flatMap((w) => w.seats).map((s) => s.id);

function craneState({ jobs, job, clamped, seats }) {
  const loaded = [];
  for (const j of jobs) {
    if (clamped >= j.to) loaded.push(j.seat.id);
  }
  if (!job) {
    return { y: TRACK.siding.y, lift: 1, seated: false, load: null, loaded };
  }
  const share = ease((clamped - job.from) / TIMING.place);
  const seat = seats.find((s) => s.id === job.seat.id);
  const from = { x: TRACK.unload, y: seat ? seat.y : 0 };
  const to = { x: TRACK.unload, y: TRACK.siding.y };
  const travel = share < 0.25 ? share / 0.25 : share < 0.7 ? 0 : (share - 0.7) / 0.3;
  const y = share < 0.7 ? from.y : from.y + (to.y - from.y) * ease((share - 0.7) / 0.3);
  const lift = share < 0.25 ? ease(share / 0.25) : share < 0.7 ? 1 : 1 - ease((share - 0.7) / 0.3) * 0.85;
  return { y, lift, seated: share < 0.1, load: share < 0.7 ? job.seat.id : null, loaded, travel };
}

function readoutFor({ wave, seats, crane, job, placed, held, clamped, pushEnd, gateEnd, cycle }) {
  const seatsThisWave = wave.seats.length;
  const cut = `${seatsThisWave} seat${seatsThisWave === 1 ? "" : "s"}`;
  if (held && clamped >= pushEnd) return `wave ${wave.n} of ${PLAN.waves.length} · gate hold · no acceptance criteria`;
  if (clamped < pushEnd) return `wave ${wave.n} of ${PLAN.waves.length} · cut ${cut} · pushing to the crest`;
  if (clamped < gateEnd) return `wave ${wave.n} of ${PLAN.waves.length} · gate approve · ${PLAN.checks.length} checks each`;
  if (job) {
    const seat = job.seat;
    const who = seat.grant === "read" ? "gantry places" : "seat places";
    return `wave ${wave.n} of ${PLAN.waves.length} · ${who} ${seat.artifact}`;
  }
  const moving = seats.filter((s) => s.state === "running").length;
  if (moving) return `wave ${wave.n} of ${PLAN.waves.length} · ${cut} · ${moving} running · cap ${PLAN.cap}`;
  return `run ${cycle + 1} · placed ${REPORT_STACK.length} of ${REPORT_STACK.length} · tickets ${Math.min(PLAN.retention, cycle + 1)} of ${PLAN.retention}`;
}