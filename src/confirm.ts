/**
 * Cast confirmation — the one screen the user sees before anything is spent.
 *
 * The cast is proposed by rule, not by luck: the same task and the same flags
 * always produce the same seats. This module exists because a proposal nobody
 * looked at is not a decision, and because every seat is a paid run. What comes
 * back from here is a set of seat ids, which the pipeline treats as the plan.
 *
 * Two screens, because the host's dialog primitives have a shape that decides
 * the design (measured in a live session, not read):
 *
 * - **Presets, single choice.** `recommended` on a single-choice question sets
 *   the cursor and the "(Recommended)" label, so the common case is one Enter.
 * - **Seat picker, multi.** A multi question returns `selectedOptions`, but its
 *   initial `selectedOptions` is always empty: there is no API to pre-check a
 *   proposed set. So it is offered as an explicit choice, reached on purpose,
 *   rather than as the first thing a user is dropped into.
 *
 * `ctx.ui.select` with `selectionMarker: "checkbox"` was the obvious third
 * option and is not usable: given a pre-checked set of four, it returned a
 * single label (`"ReviewerC1"`). The checked set lives inside the picker and
 * never reaches the extension, so it cannot confirm a cast.
 */
import { grantsWrite, isCouncilMember, SEAT_PURPOSE, type RolePlan, type RoleSpec } from "./core.ts";

/** A choice on the preset screen. */
export type PresetId = "as-planned" | "analysis-only" | "single-reviewer" | "pick-seats";

export interface Preset {
  id: PresetId;
  label: string;
  /** One line on what this choice changes. */
  description: string;
  /**
   * The roster this choice runs, one seat per line.
   *
   * It cannot go in the description: the dialog renders descriptions as one
   * inline paragraph and folds the line breaks away, which turns four seats into
   * a single run-on sentence. `preview` is the field that splits on newlines and
   * draws a line each, so a role per line is what the reader actually gets.
   */
  preview: string;
  /** Seats this preset keeps, in plan order. Empty for the manual picker. */
  seats: string[];
}

export interface SeatRow {
  /** The seat id, so a selected label can be mapped back to the plan. */
  id: string;
  label: string;
  description: string;
  /** Model and wave, shown as the row's detail when the host renders one. */
  preview: string;
}

/**
 * A seat that can change the code — the one question this screen answers.
 *
 * The rule lives in `core.grantsWrite` rather than here, because the answer is
 * `edit`, `write` *or* a shell, and a shell is the wider of the three: it can
 * write any path it can name. A screen that read `edit` alone would print
 * "read-only" for the tester and the implementer while both hold a shell, which
 * is precisely the understated consent this screen exists to prevent.
 */
const councilMembers = (plan: RolePlan): RoleSpec[] => plan.roles.filter((r) => isCouncilMember(r.id));
/**
 * Council size → the word the preset's copy uses.
 *
 * A named list can seat two to five members, so the sentence has to count the
 * council in front of the reader instead of asserting the default three. Every
 * size the parser can produce is here; anything else falls back to the digit.
 */
const COUNCIL_WORD: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five" };

/**
 * What a seat is called to the person choosing it.
 *
 * `reviewer-c1` is machinery: it is what the dependency graph and the dispatch
 * batch address the seat by, and it tells a reader nothing about the three
 * people paying for it. The title is the human name ("Reviewer 1"), and the
 * purpose is the sentence that says what comes back.
 */
function seatLabel(role: RoleSpec): string {
  return role.title || role.id;
}

/**
 * What a seat is for, on the confirmation screen.
 *
 * The lookup is total in both directions because a seat carries two names: the
 * id it was minted with and the `core` it executes as. `security-auditor` and
 * `designer` are catalog seats — their ids are the keys, and their cores
 * (`security`, `designer`) are not all of `SEAT_PURPOSE`'s keys. Keying on
 * `core` alone showed the raw string `security` where the sentence belongs; the
 * council mints the opposite case (`reviewer-c1` is not a key, `reviewer` is).
 * So: id first, then core, then the honest fallback of the core itself.
 *
 * Own properties only, for the reason `agents.frontmatter` gives: a generated
 * id such as `constructor` passes the id regex and would otherwise resolve to
 * an inherited Function instead of a string.
 */
function seatPurpose(role: RoleSpec): string {
  const own = (key: string): string | undefined =>
    Object.hasOwn(SEAT_PURPOSE, key) ? SEAT_PURPOSE[key] : undefined;
  return own(role.id) ?? own(role.core) ?? role.core;
}

/**
 * The model a seat runs on, in the form a reader can judge cost and vendor by.
 *
 * The alias is never shown as if it were a model: `@task` says what class of
 * work a seat is for and nothing about who answers, which is the whole point of
 * naming seats here. When the host could not resolve the alias the seat still
 * runs — on whatever the parent session falls back to — so the row says that
 * rather than inventing a provider or printing the alias as if it were one.
 */
function seatModel(role: RoleSpec): string {
  if (role.modelResolved) return role.modelResolved;
  return role.model.startsWith("@") ? `${role.model} — unresolved` : role.model;
}

/**
 * The authority a seat holds, in the words the screen shows.
 *
 * Three phrases, and one home for them: the roster line and the picker row both
 * print this, so the wording cannot drift between the two screens that are
 * asking the user the same question.
 *
 * A shell gets its own phrase because it is not an editor's grant — it can run
 * anything, delete anything it can reach and write any path it can name, where
 * `edit` changes files and `write` cannot edit one at all. Calling it "can change
 * the code" would understate the one thing a reader is consenting to.
 */
const AUTHORITY = {
  shell: "can change the code and run commands",
  code: "can change the code",
  read: "read-only",
} as const;

function authority(role: RoleSpec): string {
  if (role.tools.includes("bash")) return AUTHORITY.shell;
  return grantsWrite(role.tools) ? AUTHORITY.code : AUTHORITY.read;
}

/**
 * The roster this choice runs, one seat per line.
 *
 * The dialog's `description` is rendered as one inline paragraph and folds line
 * breaks away, so four seats end up as a single run-on sentence and the reader
 * has to hold them in their head. `preview` is the field that splits on newlines
 * and draws a line each, so the roster goes there and `description` keeps only
 * what the *choice* changes.
 *
 * The authority tag is on every line, not in the description: this roster *is*
 * the first screen the user sees, and a consent taken without knowing which seats
 * can write is not a decision.
 */
function rosterLines(roles: RoleSpec[]): string {
  return roles.map((r) => `${seatLabel(r)} — ${seatPurpose(r)} (${seatModel(r)}) — ${authority(r)}`).join("\n");
}

/**
 * Presets for one plan, most-recommended first.
 *
 * Every preset is a deterministic transformation of the plan — no guessing, and
 * no option whose meaning depends on what the host happens to render. A preset
 * that would change nothing is not offered: a list with two identical options is
 * worse than a shorter list.
 */
export function castPresets(plan: RolePlan): Preset[] {
  const seatIds = (roles: RoleSpec[]) => roles.map((r) => r.id);

  /**
   * What a choice will *actually* run: the seats it names, minus any left
   * waiting on a seat the choice removed.
   *
   * The pipeline applies this same rule when the cast is confirmed, so a preset
   * that skipped it promised seats that were silently dropped — a consul whose
   * three reviewers the choice just removed, or a reviewer waiting on an
   * implementer that is no longer there. Filtering here means the screen and the
   * run agree by construction, and whatever falls away is named in the text.
   */
  const withDeps = (seats: string[]): { roles: RoleSpec[]; lost: string[] } => {
    const kept = filterToSeats(plan.roles, new Set(seats));
    const lost = plan.roles.filter((r) => seats.includes(r.id) && !kept.includes(r)).map(seatLabel);
    return { roles: kept, lost };
  };

  /**
   * Build one choice.
   *
   * The description is composed from what *survives* the dependency rule, never
   * from what the choice nominally asked for: an earlier version listed a
   * consul and two reviewers that the filter was about to remove, so the screen
   * named seats which never ran. The clause about repo-wide write is the same
   * story — it has to count the writers that are actually left.
   */
  const preset = (
    id: PresetId,
    label: string,
    seats: string[],
    describe: (kept: RoleSpec[], lost: string[]) => string,
  ): Preset => {
    const { roles: kept, lost } = withDeps(seats);
    return {
      id,
      label,
      description: describe(kept, lost),
      preview: rosterLines(kept),
      seats: seatIds(kept),
    };
  };

  /** The seats a choice loses to the dependency rule, spelled out. */
  const lostClause = (lost: string[]): string =>
    lost.length
      ? ` ${lost.join(", ")} ${lost.length > 1 ? "go" : "goes"} too: nothing left for ${lost.length > 1 ? "them" : "it"} to do.`
      : "";

  const presets: Preset[] = [
    preset("as-planned", "Run all of them", seatIds(plan.roles), (_kept, lost) => `All seats, exactly as planned.${lostClause(lost)}`),
  ];

  const codeWriters = plan.roles.filter((r) => grantsWrite(r.tools));
  if (codeWriters.length && codeWriters.length < plan.roles.length) {
    const readers = plan.roles.filter((r) => !grantsWrite(r.tools));
    presets.push(
      preset(
        "analysis-only",
        "Look, don't touch",
        seatIds(readers),
        // Nothing left in this cast can write: `grantsWrite` is the rule — `edit`,
        // `write` or a shell — and this choice drops every seat holding one.
        (_kept, lost) => `Drops ${codeWriters.map(seatLabel).join(", ")} — no seat can change the code.${lostClause(lost)}`,
      ),
    );
  }

  const council = councilMembers(plan);
  if (council.length > 1) {
    const others = plan.roles.filter((r) => !isCouncilMember(r.id));
    // The copy counts the council that is actually seated: a two-model list runs
    // a council of two and a named list can run five, and "instead of three"
    // described a review nobody was looking at. Spelled out rather than printed
    // as a digit because this is prose on a consent screen.
    const size = COUNCIL_WORD[council.length] ?? String(council.length);
    presets.push(
      preset(
        "single-reviewer",
        `One reviewer instead of ${size}`,
        [...seatIds(others), council[0]!.id],
        (_kept, lost) =>
          `One opinion instead of ${size} — the review cost drops to a single run. Drops ${council
            .slice(1)
            .map(seatLabel)
            .join(", ")}.` + lostClause(lost),
      ),
    );
  }

  presets.push({
    id: "pick-seats",
    label: "Choose each seat yourself",
    description: "Opens a checklist: every seat, what it does, which model it runs on, what it can write",
    preview: "",
    seats: [],
  });
  return presets;
}

/**
 * One row per seat: what it is called, what it will do, and what it runs on.
 *
 * The row is labelled by the seat's human name, with the id kept alongside
 * rather than shown: `reviewer-c1` is what the dependency graph and the
 * dispatch batch address the seat by, and it is the one string in the plan that
 * tells a reader nothing. A duplicated title is numbered, because two rows with
 * the same label cannot be told apart in a checklist.
 */
export function seatRows(plan: RolePlan, waves: RoleSpec[][]): SeatRow[] {
  const waveOf = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((r) => waveOf.set(r.id, i + 1)));
  const seen = new Map<string, number>();
  return plan.roles.map((r) => {
    const title = seatLabel(r);
    const count = (seen.get(title) ?? 0) + 1;
    seen.set(title, count);
    return {
      id: r.id,
      label: count > 1 ? `${title} ${count}` : title,
      description: `${seatPurpose(r)}: ${authority(r)}.`,
      preview: `${seatModel(r)} · wave ${waveOf.get(r.id) ?? "?"}`,
    };
  });
}

/**
 * Keep the chosen seats, dropping anything left waiting on a seat that left.
 *
 * Iterated to a fixed point, because one pass is not enough: the consul asks for
 * every reviewer, and the reviewers ask for the implementer. Drop the
 * implementer and the reviewers go — in a single pass the consul still looks
 * fine, since the seats it named *were* all requested. What survives then waits
 * on seats that are not in the plan, and the gate refuses the whole run rather
 * than the one seat that lost its footing.
 *
 * Unchecking an implementer has to take its dependents with it: a tester whose
 * implementer is gone has nothing to test, and a plan with a dangling edge is
 * refused by the gate as a whole. Dropping the dependent is the honest reading
 * of "I don't want that one".
 */
export function filterToSeats(roles: RoleSpec[], seats: ReadonlySet<string>): RoleSpec[] {
  const wanted = new Set(seats);
  let kept = roles.filter((r) => wanted.has(r.id));
  for (;;) {
    const alive = new Set(kept.map((r) => r.id));
    const next = kept.filter((r) => (r.dependsOn ?? []).every((d) => alive.has(d)));
    if (next.length === kept.length) return next;
    kept = next;
  }
}