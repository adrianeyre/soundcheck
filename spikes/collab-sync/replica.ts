/**
 * One person's copy of a shared Project.
 *
 * The Project is the base it started from with every Change anyone has made
 * applied in one order: by Lamport clock, then by peer. Every replica that
 * has the same Changes puts them in the same order and applies them the same
 * way, so it has the same Project, whatever order they arrived in and however
 * late. A Change that arrives out of order is put in its place and everything
 * after it applied again.
 *
 * Undo and redo only ever touch this person's own steps. Undoing one is a new
 * Change that puts back what the step changed wherever it still holds what
 * the step left, so what anyone else has done since stays. Changes arriving
 * from others never clear the redo stack; only this person's own edits do.
 */
import {
  applyChange,
  type Change,
  type ChangeKind,
  compareChanges,
  compose,
  diff,
  inverse,
  type Outcome,
  type Validate,
  type Write,
} from "./change.ts";
import { type Flat, flatten, type JsonObject, unflatten } from "./flat.ts";

export interface RequestHandle {
  /** One command's worth of the Request; false if it would leave the Project invalid. */
  edit(update: (doc: JsonObject) => JsonObject): boolean;
  /** Everything the Request did becomes one Change, and one undo step. */
  end(): Change | null;
}

export class Replica {
  readonly peer: string;
  readonly #validate: Validate;
  readonly #base: Flat;
  #log: Change[] = [];
  /** The Project after each Change in the log, and what applying it did. */
  #states: Flat[] = [];
  #outcomes: Outcome[] = [];
  #ids = new Set<string>();
  #seq = 0;
  #clock = 0;
  #undo: string[] = [];
  #redo: string[] = [];
  /** An open Request's writes so far, not yet a Change. */
  #request: Write[] | null = null;

  constructor(peer: string, doc: JsonObject, validate: Validate) {
    this.peer = peer;
    this.#validate = validate;
    this.#base = flatten(doc);
  }

  get doc(): JsonObject {
    return unflatten(this.#current());
  }

  get canUndo(): boolean {
    return this.#request === null && this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#request === null && this.#redo.length > 0;
  }

  /** Every Change this replica has, to send to anyone who hasn't. */
  get changes(): readonly Change[] {
    return this.#log;
  }

  /** What applying a Change did here, in the order as this replica knows it now. */
  outcome(id: string): Outcome | null {
    const index = this.#log.findIndex((change) => change.id === id);
    return index === -1 ? null : this.#outcomes[index]!;
  }

  /** One step of this person's own. Null if it changes nothing or is invalid. */
  edit(update: (doc: JsonObject) => JsonObject): Change | null {
    if (this.#request) throw new Error("A Request is open");
    const writes = this.#writesFor(this.#current(), update);
    if (!writes || writes.length === 0) return null;
    return this.#step(writes);
  }

  /**
   * Start a Request: its edits are this person's alone, however many Changes
   * from others arrive while it runs, and it becomes one undo step.
   */
  beginRequest(): RequestHandle {
    if (this.#request) throw new Error("A Request is open");
    this.#request = [];
    return {
      edit: (update) => {
        if (!this.#request) return false;
        const writes = this.#writesFor(this.#current(), update);
        if (!writes) return false;
        this.#request = compose(this.#request, writes);
        return true;
      },
      end: () => {
        const writes = this.#request;
        this.#request = null;
        return writes && writes.length > 0 ? this.#step(writes) : null;
      },
    };
  }

  /** Undo this person's last step, leaving what others changed since. */
  undo(): { change: Change; outcome: Outcome } | null {
    if (!this.canUndo) return null;
    const step = this.#undo.pop()!;
    const change = this.#author("undo", inverse(this.outcome(step)!.applied));
    if (!change) return null;
    this.#redo.push(change.id);
    return { change, outcome: this.outcome(change.id)! };
  }

  redo(): { change: Change; outcome: Outcome } | null {
    if (!this.canRedo) return null;
    const undone = this.#redo.pop()!;
    const change = this.#author("redo", inverse(this.outcome(undone)!.applied));
    if (!change) return null;
    this.#undo.push(change.id);
    return { change, outcome: this.outcome(change.id)! };
  }

  /** Take in Changes from anyone, in any order, as often as they come. */
  receive(changes: Iterable<Change>) {
    const fresh = [...changes].filter((change) => !this.#ids.has(change.id));
    if (fresh.length === 0) return;
    for (const change of fresh) {
      this.#ids.add(change.id);
      this.#clock = Math.max(this.#clock, change.clock);
    }
    const first = fresh.toSorted(compareChanges)[0]!;
    const from = this.#log.findIndex((change) => compareChanges(change, first) > 0);
    this.#log = [...this.#log, ...fresh].toSorted(compareChanges);
    this.#replay(from === -1 ? this.#log.length - fresh.length : from);
  }

  #writesFor(before: Flat, update: (doc: JsonObject) => JsonObject): Write[] | null {
    const after = update(unflatten(before));
    if (this.#validate(after) !== null) return null;
    return diff(before, flatten(after));
  }

  #step(writes: Write[]): Change | null {
    const change = this.#author("edit", writes);
    if (change) {
      this.#undo.push(change.id);
      this.#redo = [];
    }
    return change;
  }

  #author(kind: ChangeKind, writes: Write[]): Change | null {
    if (writes.length === 0) return null;
    this.#seq += 1;
    this.#clock += 1;
    const id = `${this.peer}:${this.#seq}`;
    const change: Change = { id, peer: this.peer, seq: this.#seq, clock: this.#clock, kind, writes };
    this.receive([change]);
    return change;
  }

  #confirmed(): Flat {
    return this.#states.at(-1) ?? this.#base;
  }

  /** The Project with an open Request's edits on top. */
  #current(): Flat {
    const confirmed = this.#confirmed();
    if (!this.#request || this.#request.length === 0) return confirmed;
    const pending: Change = { id: "", peer: this.peer, seq: 0, clock: 0, kind: "edit", writes: this.#request };
    return applyChange(confirmed, pending, this.#validate).flat;
  }

  #replay(from: number) {
    this.#states.length = from;
    this.#outcomes.length = from;
    let flat = from === 0 ? this.#base : this.#states[from - 1]!;
    for (const change of this.#log.slice(from)) {
      const applied = applyChange(flat, change, this.#validate);
      flat = applied.flat;
      this.#states.push(flat);
      this.#outcomes.push(applied.outcome);
    }
  }
}
