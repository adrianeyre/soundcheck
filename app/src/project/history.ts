/**
 * The only way to change the Project: commands, with undo and redo.
 *
 * Each step is a Change (ADR 0007): the values it wrote, keyed by id over the
 * flat form of the Project (`flat.ts`), found by diffing the Projects before
 * and after it. Undo is a new Change that puts back what the step actually
 * did, but only where each value still holds what the step left. With one
 * person that is exactly the Project before the step; with Collaborators it
 * never overwrites what they have changed since.
 *
 * The Project is where it started plus every Change, this copy's and its
 * Collaborators', in one order that every copy agrees on. A Change that
 * arrives late is slotted into its place and what follows is applied again.
 *
 * Several commands can be grouped into one step: everything the Assistant
 * does for one Request undoes and redoes together. A group belongs to
 * whoever opened it: while one is open the history is busy, and every other
 * change, undo and redo of this person's waits for it, so the step stays one.
 * Collaborators' Changes don't wait: they land around it, and the Request
 * still undoes in one step.
 */
import { applyChange, type Change, type ChangeKind, compareChanges, compose, inverse, type Outcome, SYNC_VERSION, type Write } from "./change";
import { applyCommands, COMMAND_LABELS, type Command, type Result } from "./commands";
import { diffProjects, type Flat, flatten, type Json, keep, same, unflatten } from "./flat";
import type { Project } from "./model";
import { listed, whatKeysName } from "./notice";

/**
 * One Request's worth of changes, on its way to becoming a single step.
 * Only the holder of the group can change the Project until it ends.
 */
export interface ProjectGroup {
  /** Apply commands as part of the group, exactly as `execute` does. */
  execute(commands: Command | readonly Command[]): Result;
  /** Whether this is still the group the history has open. */
  readonly open: boolean;
  /** Close the group: what it changed becomes one step. Doing it twice is harmless. */
  end(): void;
  /**
   * Whether the step the group became is undone now: undone and not redone,
   * or undone and then replaced by a change. Never, while it is open or if
   * it changed nothing.
   */
  readonly undone: boolean;
}

/** Told to whoever tries to change the Project while a Request is running. */
export const BUSY = "The Assistant is working on the Project. Wait until it has finished.";

/** Something this person should know about what happened to their own Change. */
export interface Notice {
  /** `left`: an undo or redo left what a Collaborator changed. `refused`: part of a Change couldn't land. `update`: a copy uses another version. */
  kind: "left" | "refused" | "update";
  text: string;
}

export interface HistoryOptions {
  /** This copy's id, kept from one session to the next in a Shared Project. */
  copy?: string;
  /** Whose Changes this copy's are, as Collaborators are told. */
  by?: string;
  /** Changes already made to the Project, e.g. read from a Shared Project folder. */
  changes?: readonly Change[];
}

/**
 * One undo step: the Change that last did or undid it, whose writes undo or
 * redo reverses, and the Projects either side of it. Where undo or redo gives
 * back one of those exactly, it is that very object.
 */
interface Step {
  label: string;
  change: string | null;
  before: Project;
  after: Project;
}

interface OpenGroup {
  label: string;
  before: Project;
  /** Everything the group has written so far, not yet a Change. */
  writes: Write[];
  /** Whether a Collaborator's Change landed while it was open. */
  crossed: boolean;
  /** The step it became, once it has closed, if it changed anything. */
  step: Step | null;
}

/** The flat form before `log[index]`, so a late Change needn't replay the whole log. */
interface Checkpoint {
  index: number;
  flat: Flat;
}

const CHECKPOINT_EVERY = 64;

/** Called after every change, e.g. so the Audio Engine can follow the data. */
export type ProjectListener = (project: Project, previous: Project) => void;

export class ProjectHistory {
  /** What everyone sees: the log's Project, with an open group's writes on top. */
  #project: Project;
  /** Where the log starts: the Project as it was when it was shared, or first made. */
  #base: Project;
  /** The Project after the log's first `#applied` Changes, as the flat form. */
  #flat: Flat;
  #applied = 0;
  #checkpoints: Checkpoint[];
  readonly #copy: string;
  #by: string | undefined;
  #seq = 0;
  #clock = 0;
  /** Every Change, in the order every copy puts them in. */
  #log: Change[] = [];
  #ids = new Set<string>();
  /** The first Change made with other rules than this copy's: nothing from it on is applied. */
  #stopped: Change | null = null;
  /** What applying each of this copy's own Changes did, and what it was, by id. */
  #outcomes = new Map<string, Outcome>();
  #labels = new Map<string, string>();
  #undo: Step[] = [];
  #redo: Step[] = [];
  #group: OpenGroup | null = null;
  #listeners = new Set<ProjectListener>();
  #changeListeners = new Set<(change: Change) => void>();
  #noticeListeners = new Set<(notice: Notice) => void>();

  constructor(project: Project, { copy, by, changes = [] }: HistoryOptions = {}) {
    this.#project = project;
    this.#base = project;
    this.#flat = flatten(project);
    this.#checkpoints = [{ index: 0, flat: this.#flat }];
    this.#copy = copy ?? newCopyId();
    this.#by = by;
    if (changes.length > 0) {
      this.#take(changes);
      this.#project = keep(project, unflatten(this.#flat));
    }
  }

  get project(): Project {
    return this.#project;
  }

  /** The Project the log starts from: every copy with the same base and Changes has the same Project. */
  get base(): Project {
    return this.#base;
  }

  /** Which copy of the Project this is: every Change it makes says so. */
  get copy(): string {
    return this.#copy;
  }

  /** Whose this copy's Changes are, as Collaborators are told: set from Settings. */
  get by(): string | undefined {
    return this.#by;
  }

  /** Put `name` on this copy's Changes from now on. */
  signAs(name: string | undefined): void {
    this.#by = name?.trim() || undefined;
  }

  /** Every Change so far, this copy's and everyone's, in order. */
  get log(): readonly Change[] {
    return this.#log;
  }

  /** The latest of each copy's Changes this copy has, by copy: what a Collaborator needn't send again. */
  get have(): Record<string, number> {
    const have: Record<string, number> = {};
    for (const change of this.#log) have[change.copy] = Math.max(have[change.copy] ?? 0, change.seq);
    return have;
  }

  /** Why nobody can change the Project here until they update, if a Collaborator's copy uses other rules. */
  get stopped(): string | null {
    return this.#stopped ? updateMessage(this.#stopped) : null;
  }

  /** Whether a group is open: someone else is changing the Project. */
  get busy(): boolean {
    return this.#group !== null;
  }

  get canUndo(): boolean {
    return !this.busy && !this.#stopped && this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return !this.busy && !this.#stopped && this.#redo.length > 0;
  }

  /** What undo would undo, e.g. "Add Track". */
  get undoLabel(): string | null {
    return this.canUndo ? (this.#undo.at(-1)?.label ?? null) : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? (this.#redo.at(-1)?.label ?? null) : null;
  }

  /**
   * Apply one command, or several as one step. If any is rejected nothing
   * changes, and the result says why.
   */
  execute(commands: Command | readonly Command[], label?: string): Result {
    if (this.#group) return { ok: false, error: BUSY };
    if (this.#stopped) return { ok: false, error: updateMessage(this.#stopped) };
    const list = Array.isArray(commands) ? commands : [commands as Command];
    const result = this.#apply(list);
    if (!result.ok || list.length === 0) return result;

    const before = this.#project;
    const name = label ?? labelFor(list);
    const change = this.#author("edit", diffProjects(before, result.project), name, true);
    this.#project = result.project;
    this.#redo = [];
    this.#undo.push({ label: name, change: change?.id ?? null, before, after: result.project });
    this.#notify(before);
    return result;
  }

  /**
   * Start a group: everything done through the group it returns becomes one
   * undo step called `label`, such as one Request to the Assistant. Until
   * the group ends the history is busy, and everyone else waits.
   */
  beginGroup(label: string): ProjectGroup {
    // A group left open by something that never finished doesn't hold the
    // next one up: it closes here, with what it did as its own step.
    const stale = this.#group;
    if (stale) this.#close(stale);
    const mine: OpenGroup = { label, before: this.#project, writes: [], crossed: false, step: null };
    this.#group = mine;
    const open = () => this.#group === mine;
    const undone = () => mine.step !== null && !this.#undo.includes(mine.step);
    return {
      execute: (commands) => (open() ? this.#applyInGroup(mine, commands) : { ok: false, error: BUSY }),
      get open() {
        return open();
      },
      end: () => {
        if (!open()) return;
        this.#close(mine);
      },
      get undone() {
        return undone();
      },
    };
  }

  #applyInGroup(group: OpenGroup, commands: Command | readonly Command[]): Result {
    if (this.#stopped) return { ok: false, error: updateMessage(this.#stopped) };
    const list = Array.isArray(commands) ? commands : [commands as Command];
    const result = this.#apply(list);
    if (!result.ok || list.length === 0) return result;
    const before = this.#project;
    group.writes = compose(group.writes, diffProjects(before, result.project));
    this.#project = result.project;
    this.#redo = [];
    this.#notify(before);
    return result;
  }

  /**
   * Apply commands to the Project as it is. Commands copy the whole Project,
   * so the result is made of the Project's own objects again wherever it is
   * the same: what didn't change is skipped by the diff, the Audio Engine and
   * the UI.
   */
  #apply(list: readonly Command[]): Result {
    const result = applyCommands(this.#project, list);
    return result.ok ? { ok: true, project: keep(this.#project, result.project) } : result;
  }

  /** What a group changed becomes its step. */
  #close(group: OpenGroup) {
    this.#group = null;
    if (group.writes.length === 0 || this.#stopped) return;
    // Where a Collaborator's Change landed meanwhile, what the Project is
    // now wasn't only a command's to check.
    const change = this.#author("edit", group.writes, group.label, !group.crossed);
    group.step = { label: group.label, change: change?.id ?? null, before: group.before, after: this.#project };
    this.#undo.push(group.step);
    if (group.crossed) this.#set(this.#flat, this.#project);
  }

  /** Undo the last step. A group in progress is left to finish first. */
  undo(): boolean {
    if (!this.canUndo) return false;
    const step = this.#undo.pop()!;
    this.#reverse(step, "undo", step.before);
    this.#redo.push(step);
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const step = this.#redo.pop()!;
    this.#reverse(step, "redo", step.after);
    this.#undo.push(step);
    return true;
  }

  /**
   * Make the Project as it is now where the log starts: the base a Shared
   * Project's folder is written with (ADR 0007). Every Change so far is part
   * of it and the log starts again empty, but undo and redo still reach
   * back past it, as what each of this copy's Changes did is kept.
   */
  rebase(): void {
    if (this.#group) throw new Error(BUSY);
    this.#base = this.#project;
    this.#log = [];
    this.#ids = new Set();
    this.#applied = 0;
    this.#checkpoints = [{ index: 0, flat: this.#flat }];
    this.#stopped = null;
  }

  /**
   * Take `project` as it is, for what changes outside the commands and
   * isn't this person's to undo: a VST3 Plugin's state, which its instance
   * holds, as a Shared Project is saved. It is checked as a Collaborator's
   * Change would be. Whether anything changed.
   */
  record(project: Project, label: string): boolean {
    if (this.#group || this.#stopped) return false;
    const change = this.#author("edit", diffProjects(this.#project, project), label, false);
    if (!change) return false;
    this.#set(this.#flat, project);
    return true;
  }

  subscribe(listener: ProjectListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called with every Change this copy makes, for passing on to its Collaborators. */
  onChange(listener: (change: Change) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Called when an undo leaves what someone else changed, part of a Change is refused, or a copy needs updating. */
  onNotice(listener: (notice: Notice) => void): () => void {
    this.#noticeListeners.add(listener);
    return () => this.#noticeListeners.delete(listener);
  }

  /**
   * Take Collaborators' Changes, in any order, any of them again: each is
   * put in its place among the rest, and the Project is what they all make.
   * Neither undo stack changes, so undo is still of this person's own steps.
   */
  receive(changes: readonly Change[]): void {
    const refusedBefore = new Map([...this.#outcomes].map(([id, outcome]) => [id, outcome.refused.length]));
    const wasStopped = this.#stopped;
    if (!this.#take(changes)) return;

    const group = this.#group;
    if (group) group.crossed = true;
    // While a Request runs, what it has done so far stays on top.
    const shown = group ? applyChange(this.#flat, { kind: "edit", writes: group.writes }).flat : this.#flat;
    this.#set(shown, this.#project);

    for (const [id, outcome] of this.#outcomes) {
      if (outcome.refused.length > 0 && (refusedBefore.get(id) ?? 0) === 0) this.#tellRefused(id, outcome);
    }
    if (this.#stopped && !wasStopped) this.#tell({ kind: "update", text: updateMessage(this.#stopped) });
  }

  /** Put new Changes in the log and apply from the first of them. Whether any was new. */
  #take(changes: readonly Change[]): boolean {
    let from = this.#log.length;
    let fresh = false;
    for (const change of changes) {
      if (this.#ids.has(change.id)) continue;
      fresh = true;
      this.#ids.add(change.id);
      this.#clock = Math.max(this.#clock, change.clock);
      if (change.copy === this.#copy) this.#seq = Math.max(this.#seq, change.seq);
      let index = this.#log.length;
      while (index > 0 && compareChanges(this.#log[index - 1]!, change) > 0) index -= 1;
      this.#log.splice(index, 0, change);
      from = Math.min(from, index);
    }
    if (fresh) this.#replay(from);
    return fresh;
  }

  /** Apply the log again from `from`, starting from the latest checkpoint before it. */
  #replay(from: number) {
    if (from < this.#applied) {
      while (this.#checkpoints.at(-1)!.index > from) this.#checkpoints.pop();
      const checkpoint = this.#checkpoints.at(-1)!;
      this.#flat = checkpoint.flat;
      this.#applied = checkpoint.index;
    }
    this.#stopped = null;
    this.#run();
  }

  /** Apply every Change in the log not yet applied, stopping at one made with other rules. */
  #run() {
    for (; this.#applied < this.#log.length; this.#applied += 1) {
      const change = this.#log[this.#applied]!;
      if (change.sync !== SYNC_VERSION) {
        this.#stopped = change;
        return;
      }
      this.#checkpoint();
      const applied = applyChange(this.#flat, change);
      this.#flat = applied.flat;
      if (change.copy === this.#copy) this.#outcomes.set(change.id, applied.outcome);
    }
  }

  /** Keep the flat form as it is before the next Change to apply, every so often. */
  #checkpoint() {
    const index = this.#applied;
    if (index > 0 && index % CHECKPOINT_EVERY === 0 && this.#checkpoints.at(-1)!.index < index) {
      this.#checkpoints.push({ index, flat: this.#flat });
    }
  }

  /** Put back what the step's last Change did, wherever it still holds what that Change left. */
  #reverse(step: Step, kind: ChangeKind, hint: Project) {
    const done = step.change === null ? null : this.#outcomes.get(step.change);
    if (!done) return;
    const before = this.#flat;
    const change = this.#author(kind, inverse(done.applied), step.label, false);
    step.change = change?.id ?? null;
    this.#set(this.#flat, hint);
    const outcome = change && this.#outcomes.get(change.id);
    if (!outcome) return;
    if (outcome.left.length > 0) {
      const what = whatKeysName(
        outcome.left.map((each) => each.key),
        this.#flat,
        before,
      );
      const who = listed(this.#lastWriters(outcome.left.map((each) => each.key)));
      const doing = kind === "undo" ? "Undo" : "Redo";
      this.#tell({ kind: "left", text: `${doing} of “${step.label}” left ${what} as ${who} changed it since.` });
    }
    if (outcome.refused.length > 0) this.#tellRefused(change.id, outcome);
  }

  /** Who last changed each key, other than this copy: the names their Changes carry. */
  #lastWriters(keys: readonly string[]): string[] {
    const names = new Set<string>();
    for (const key of keys) {
      const last = this.#log.findLast((change) => change.copy !== this.#copy && change.writes.some((each) => each.key === key));
      names.add(last?.by ?? "a Collaborator");
    }
    return [...names];
  }

  #tellRefused(id: string, outcome: Outcome) {
    const change = this.#log.find((each) => each.id === id);
    const label = this.#labels.get(id) ?? "a change";
    const what = whatKeysName(
      outcome.refused.map((each) => each.key),
      this.#flat,
    );
    const doing = change?.kind === "undo" ? "Undo of " : change?.kind === "redo" ? "Redo of " : "";
    const reason = outcome.reason ? ` ${outcome.reason}.` : "";
    this.#tell({ kind: "refused", text: `${doing}“${label}” couldn't change ${what} after a Collaborator's edit.${reason}` });
  }

  /**
   * Make a Change of this copy's own and apply it. `trusted` when the
   * Project it leaves is the one a command has just checked.
   */
  #author(kind: ChangeKind, writes: Write[], label: string, trusted: boolean): Change | null {
    if (writes.length === 0) return null;
    this.#seq += 1;
    this.#clock += 1;
    const change: Change = {
      id: `${this.#copy}:${this.#seq}`,
      copy: this.#copy,
      seq: this.#seq,
      clock: this.#clock,
      kind,
      sync: SYNC_VERSION,
      ...(this.#by ? { by: this.#by } : {}),
      writes,
    };
    // Its clock is past every Change this copy has, so it goes last.
    this.#checkpoint();
    this.#log.push(change);
    this.#ids.add(change.id);
    this.#labels.set(change.id, label);
    const applied = applyChange(this.#flat, change, { trusted });
    this.#flat = applied.flat;
    this.#applied = this.#log.length;
    this.#outcomes.set(change.id, applied.outcome);
    for (const listener of this.#changeListeners) listener(change);
    return change;
  }

  /**
   * Show the Project the flat form holds, keeping every object that didn't
   * change, or `hint` itself if that is what it holds.
   */
  #set(flat: Flat, hint: Project) {
    const before = this.#project;
    const next = keep(before, unflatten(flat));
    this.#project = next !== before && same(next as unknown as Json, hint as unknown as Json) ? hint : next;
    if (this.#project !== before) this.#notify(before);
  }

  #tell(notice: Notice) {
    for (const listener of this.#noticeListeners) listener(notice);
  }

  #notify(previous: Project) {
    for (const listener of this.#listeners) listener(this.#project, previous);
  }
}

/** What to tell someone whose Collaborator's copy applies Changes by other rules. */
function updateMessage(change: Change): string {
  const who = change.by ?? "A Collaborator";
  return newer(change.sync, SYNC_VERSION)
    ? `${who} is using a newer Soundcheck. Update Soundcheck to keep editing this Project together.`
    : `${who} is using an older Soundcheck, and needs to update it before you can keep editing this Project together.`;
}

function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let index = 0; index < Math.max(x!.length, y!.length); index += 1) {
    const difference = (x![index] ?? 0) - (y![index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * An id for this copy of the Project, told apart from every other copy's.
 * Not from `crypto.randomUUID`, which makes the ids of items: a copy's id is
 * no item's, and making one mustn't change the ids a Request gives them.
 */
function newCopyId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function labelFor(commands: readonly Command[]): string {
  const first = commands[0]!;
  return commands.length === 1 ? COMMAND_LABELS[first.type] : `${COMMAND_LABELS[first.type]} and more`;
}
