/**
 * Which model actually ran a seat — observed in the seat's own session.
 *
 * A seat's brief names the model it was *pinned* to. That is intent, and it is
 * exactly what a retry fallback replaces; a seat asked "which model are you?"
 * can only repeat its brief. The seat's session knows better: its live model at
 * the moment it yields, and every `retry_fallback_applied` it went through. This
 * module compares that against the plan-time pin and words the difference.
 */
import { baseModel } from "./core.ts";

/** One settled seat whose model differs from what the run expected. */
export interface ModelObservation {
  agent: string;
  /** Concrete model the seat's session was running when it yielded. */
  ran: string;
  /** Plan-time resolution, when the plugin had one. */
  planned?: string;
  /** The session switched models through a retry fallback. */
  fallback: boolean;
  /** The model the fallback replaced, when there was one. */
  from?: string;
}

/**
 * The model a seat was expected to run on: the plan-time resolution, else the
 * pin itself when it is a concrete model. An unresolved `@alias` is not a model,
 * and treating it as a baseline would report "model changed" on every run.
 */
export function plannedModel(seat: { pinned: string; resolved?: string }): string | undefined {
  const planned = seat.resolved ?? (seat.pinned.startsWith("@") ? undefined : seat.pinned);
  return planned ? baseModel(planned) : undefined;
}

/** A divergence worth telling the user about, or undefined when the plan held. */
export function observeSeat(input: {
  agent: string;
  ran: string | undefined;
  planned: string | undefined;
  fallbackFrom?: string;
}): ModelObservation | undefined {
  if (!input.ran) return undefined;
  const ran = baseModel(input.ran);
  const fallback = input.fallbackFrom !== undefined;
  if (!fallback && (input.planned === undefined || input.planned === ran)) return undefined;
  return {
    agent: input.agent,
    ran,
    ...(input.planned ? { planned: input.planned } : {}),
    fallback,
    ...(input.fallbackFrom ? { from: baseModel(input.fallbackFrom) } : {}),
  };
}

/** One user-facing line per divergence: what was planned, what actually ran. */
export function renderObservation(o: ModelObservation): string {
  const parts = [
    o.planned
      ? `planned \`${o.planned}\`, ran \`${o.ran}\``
      : `ran \`${o.ran}\` (no plan-time baseline for this seat)`,
    o.fallback ? "FALLBACK" : "model changed",
    o.from && o.from !== o.planned ? `from \`${o.from}\`` : "",
  ].filter(Boolean);
  return `role-fleet: ${o.agent} — ${parts.join(", ")}`;
}
