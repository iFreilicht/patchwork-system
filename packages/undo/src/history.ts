import * as A from "@automerge/automerge/slim";
import type { Heads, Patch, Prop } from "@automerge/automerge/slim";
import type { DocHandle } from "@automerge/automerge-repo/slim";

import { CopyMap } from "./copies.js";
import {
  executeInverse,
  opsOf,
  pathOf,
  planInverse,
  type ConflictPolicy,
  type InverseContext,
  type OpRecord,
  type Skipped,
} from "./invert.js";
import {
  addRanges,
  changeRanges,
  mapRanges,
  textSplices,
  touches,
  type TextRanges,
} from "./ranges.js";
import { changedVisibly } from "./visible.js";

export type { ConflictPolicy, Skipped } from "./invert.js";

/** Decides whether a path is left out of undo. */
export type IgnorePath = (path: Prop[]) => boolean;

export type UndoHistoryOptions = {
  /**
   * Consecutive local changes less than this many milliseconds apart form
   * one step (if text edits also touch the step's range). Default 500, as
   * CodeMirror's `newGroupDelay` and Yjs's `captureTimeout`. `Infinity`
   * leaves the boundaries to {@link UndoHistory.checkpoint}.
   */
  groupDelayMs?: number;
  /**
   * Paths whose changes neither form steps nor end an undo run, and which
   * the inverse leaves alone. Top-level keys starting with `@` (Patchwork
   * metadata, comments) are always ignored.
   */
  ignore?: IgnorePath;
  /** What to do when someone else changed a value since. Default `"skip"`. */
  conflict?: ConflictPolicy;
  /** The clock steps are grouped by. Default `Date.now`. */
  now?: () => number;
};

export type UndoState = { canUndo: boolean; canRedo: boolean };

export type UndoResult = {
  /** Whether the press changed the document visibly. */
  applied: boolean;
  /** Patches between the document before and after the press. */
  patches: Patch[];
  /** Values left alone because someone else changed them, or gone. */
  skipped: Skipped[];
  /** Ops the inverse can't undo (rich-text marks). */
  unsupported: number;
};

export type AppliedEvent = UndoResult & { direction: "undo" | "redo" };

export type PressOptions = { conflict?: ConflictPolicy };

type Step = {
  changes: string[];
  lastTime: number;
  ranges: TextRanges;
};

/**
 * Consecutive undo and redo presses: a pointer that walks back and forth
 * through the steps. Every press is applied at once as a new change.
 */
type Run = {
  start: number;
  pointer: number;
  changes: string[];
  /** The changes that undid step `i` in this run, which a redo inverts. */
  undone: Map<number, string[]>;
};

export const defaultIgnore: IgnorePath = (path) =>
  typeof path[0] === "string" && path[0].startsWith("@");

const NOTHING: UndoResult = {
  applied: false,
  patches: [],
  skipped: [],
  unsupported: 0,
};

/**
 * The undo history of one realm's edits to one Automerge document.
 *
 * A change belongs to the realm if its actor is the document's actor here:
 * every realm loads documents with its own actor, so two tabs, or two
 * realms, undo independently, and collaborators' changes are never undone.
 */
/** What a tool's binding (`Undo`) and a history both offer. */
export interface UndoControls {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(options?: PressOptions): UndoResult;
  redo(options?: PressOptions): UndoResult;
  /** End the current step: tools call it where they know a boundary. */
  checkpoint(): void;
  /** Listen to `canUndo` / `canRedo`; called with the current state at once. */
  subscribe(listener: (state: UndoState) => void): () => void;
  /** Listen to applied presses, e.g. to move a selection to what changed. */
  onApplied(listener: (event: AppliedEvent) => void): () => void;
  dispose(): void;
}

export class UndoHistory implements UndoControls {
  readonly handle: DocHandle<unknown>;
  readonly #actor: string;
  #lastHeads: Heads;
  #steps: Step[] = [];
  #run: Run | undefined;
  #checkpoint = false;
  #applying: string[] | null = null;
  #disposed = false;

  readonly #ctx: InverseContext;
  readonly #ignores = new Set<IgnorePath>();
  readonly #delays = new Map<object, number>();
  #conflict: ConflictPolicy;
  #now: () => number;

  readonly #listeners = new Set<(state: UndoState) => void>();
  readonly #applied = new Set<(event: AppliedEvent) => void>();
  #state: UndoState = { canUndo: false, canRedo: false };

  readonly #onChange = () => this.#sync();

  constructor(handle: DocHandle<unknown>, options: UndoHistoryOptions = {}) {
    this.handle = handle;
    const doc = handle.doc() as A.Doc<unknown>;
    this.#actor = A.getActorId(doc);
    this.#lastHeads = A.getHeads(doc);
    this.#conflict = options.conflict ?? "skip";
    this.#now = options.now ?? Date.now;
    this.#ctx = {
      copies: new CopyMap(),
      owners: new Map(),
      values: new Map(),
      elements: new Map(),
      created: new Map(),
      ignore: (path) =>
        defaultIgnore(path) ||
        [...this.#ignores].some((ignore) => ignore(path)),
    };
    if (options.ignore) this.#ignores.add(options.ignore);
    if (options.groupDelayMs !== undefined) {
      this.#delays.set(this, options.groupDelayMs);
    }
    handle.on("change", this.#onChange);
  }

  /**
   * The grouping delay. Tools sharing a history may ask for different ones;
   * the largest wins, so a tool that sets `Infinity` and marks its own
   * boundaries with `checkpoint()` keeps its long gestures in one step.
   */
  get groupDelayMs(): number {
    return this.#delays.size === 0 ? 500 : Math.max(...this.#delays.values());
  }

  /** @internal Used by bindings to contribute their options. */
  configure(owner: object, options: UndoHistoryOptions): () => void {
    if (options.groupDelayMs !== undefined) {
      this.#delays.set(owner, options.groupDelayMs);
    }
    if (options.ignore) this.#ignores.add(options.ignore);
    if (options.conflict) this.#conflict = options.conflict;
    if (options.now) this.#now = options.now;
    return () => {
      this.#delays.delete(owner);
      if (options.ignore) this.#ignores.delete(options.ignore);
    };
  }

  get canUndo(): boolean {
    return this.#run ? this.#run.pointer > 0 : this.#steps.length > 0;
  }

  get canRedo(): boolean {
    return !!this.#run && this.#run.pointer < this.#run.start;
  }

  get state(): UndoState {
    return { canUndo: this.canUndo, canRedo: this.canRedo };
  }

  /** The number of steps, including steps made of undo runs. */
  get size(): number {
    this.#sync();
    return this.#steps.length;
  }

  /** End the current step: the next local change starts a new one. */
  checkpoint(): void {
    this.#sync();
    this.#checkpoint = true;
  }

  /** Undo the newest step not yet undone in this run. */
  undo(options: PressOptions = {}): UndoResult {
    this.#sync();
    if (!this.#run) {
      if (this.#steps.length === 0) return NOTHING;
      const top = this.#steps.length;
      this.#run = { start: top, pointer: top, changes: [], undone: new Map() };
    }
    const run = this.#run;
    let result = NOTHING;
    // A step whose inverse changes nothing visible is skipped, so that
    // every press visibly does something.
    while (run.pointer > 0 && !result.applied) {
      const i = run.pointer - 1;
      const { hashes, ...applied } = this.#apply(
        this.#steps[i]!.changes,
        options
      );
      run.undone.set(i, hashes);
      run.pointer = i;
      result = merge(result, applied);
    }
    this.#finish("undo", result);
    return result;
  }

  /** Redo the step the last undo in this run undid. Only inside a run. */
  redo(options: PressOptions = {}): UndoResult {
    this.#sync();
    const run = this.#run;
    if (!run) return NOTHING;
    let result = NOTHING;
    while (run.pointer < run.start && !result.applied) {
      const i = run.pointer;
      const { hashes: _, ...applied } = this.#apply(
        run.undone.get(i) ?? [],
        options
      );
      run.pointer = i + 1;
      result = merge(result, applied);
    }
    this.#finish("redo", result);
    return result;
  }

  /** Forget every step, e.g. when the document was replaced wholesale. */
  reset(): void {
    this.#lastHeads = A.getHeads(this.handle.doc() as A.Doc<unknown>);
    this.#steps = [];
    this.#run = undefined;
    this.#checkpoint = false;
    this.#ctx.copies.clear();
    this.#ctx.owners.clear();
    this.#ctx.values.clear();
    this.#ctx.elements.clear();
    this.#ctx.created.clear();
    this.#emit();
  }

  /** Listen to `canUndo` / `canRedo`. Called with the current state at once. */
  subscribe(listener: (state: UndoState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Listen to applied presses, e.g. to move a selection to what changed.
   * `patches` have whole-document paths.
   */
  onApplied(listener: (event: AppliedEvent) => void): () => void {
    this.#applied.add(listener);
    return () => this.#applied.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.handle.off("change", this.#onChange);
    this.#listeners.clear();
    this.#applied.clear();
  }

  #finish(direction: "undo" | "redo", result: UndoResult) {
    this.#emit();
    if (result === NOTHING) return;
    for (const listener of this.#applied) {
      try {
        listener({ ...result, direction });
      } catch (err) {
        console.error("[patchwork-undo] onApplied listener threw:", err);
      }
    }
  }

  #emit() {
    const state = this.state;
    if (
      state.canUndo === this.#state.canUndo &&
      state.canRedo === this.#state.canRedo
    ) {
      return;
    }
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("[patchwork-undo] state listener threw:", err);
      }
    }
  }

  #apply(
    hashes: readonly string[],
    options: PressOptions
  ): UndoResult & { hashes: string[] } {
    const handle = this.handle;
    const doc = handle.doc() as A.Doc<unknown>;
    // Heads are taken outside `change()`: reading them inside commits the
    // pending operations as a change of their own (automerge#1607).
    const before = A.getHeads(doc);
    const plan = planInverse(doc, hashes, this.#ctx);
    let outcome = { skipped: [] as Skipped[], unsupported: plan.unsupported };
    const collected: string[] = [];
    this.#applying = collected;
    try {
      if (plan.actions.length > 0) {
        handle.change((d: unknown) => {
          outcome = executeInverse(
            A.getBackend(d as A.Doc<unknown>),
            plan,
            this.#ctx,
            options.conflict ?? this.#conflict
          );
        });
      }
      this.#sync();
    } finally {
      this.#applying = null;
    }
    this.#run?.changes.push(...collected);
    const after = A.getHeads(handle.doc() as A.Doc<unknown>);
    const current = handle.doc() as A.Doc<unknown>;
    const patches = A.diff(current, before, after);
    return {
      applied: changedVisibly(
        current,
        before,
        after,
        patches,
        this.#ctx.ignore
      ),
      patches,
      skipped: outcome.skipped,
      unsupported: outcome.unsupported,
      hashes: collected,
    };
  }

  /** Take in every change since the last look. */
  #sync() {
    if (this.#disposed) return;
    const doc = this.handle.doc() as A.Doc<unknown> | undefined;
    if (!doc) return;
    const metas = A.getChangesMetaSince(doc, this.#lastHeads);
    if (metas.length === 0) return;
    const previous = this.#lastHeads;
    this.#lastHeads = A.getHeads(doc);

    const local = metas.filter((meta) => meta.actor === this.#actor);
    if (local.length === 0) {
      this.#mapOpenStep(doc, previous);
      return;
    }
    for (const meta of local) {
      const ops = opsOf(A.getBackend(doc), meta.hash, { n: 0 });
      this.#register(ops);
      if (this.#applying) {
        this.#applying.push(meta.hash);
        continue;
      }
      this.#record(doc, meta.hash, meta.deps, ops);
    }
    this.#emit();
  }

  // Keep the open step's text ranges in step with collaborators' edits, so
  // that typing on after a remote insertion still joins the step.
  #mapOpenStep(doc: A.Doc<unknown>, previous: Heads) {
    const step = this.#steps.at(-1);
    if (!step || step.ranges.size === 0 || this.#run) return;
    if (this.#now() - step.lastTime >= this.groupDelayMs) return;
    const patches = A.diff(doc, previous, A.getHeads(doc));
    mapRanges(
      step.ranges,
      textSplices(patches, isTextIn(doc, A.getHeads(doc)))
    );
  }

  // Remember which sequence each element lives in, and which value op last
  // overwrote a list element, for every local change, undos included.
  #register(ops: readonly OpRecord[]) {
    for (const { id, op, seq } of ops) {
      if (op.insert) {
        this.#ctx.created.set(id, seq);
        this.#ctx.owners.set(id, op.obj);
        this.#value(id, id);
      } else if (op.elemId !== undefined) {
        this.#ctx.owners.set(op.elemId, op.obj);
        if (op.action !== "del" && op.action !== "inc") {
          this.#ctx.owners.set(id, op.obj);
          this.#value(op.elemId, id);
        }
      }
    }
  }

  #value(elem: string, value: string) {
    let values = this.#ctx.values.get(elem);
    if (!values) this.#ctx.values.set(elem, (values = new Set()));
    values.add(value);
    this.#ctx.elements.set(value, elem);
  }

  #record(
    doc: A.Doc<unknown>,
    hash: string,
    deps: Heads,
    ops: readonly OpRecord[]
  ) {
    const be = A.getBackend(doc);
    let relevant = false;
    const paths = new Map<string, Prop[] | undefined>();
    for (const { op } of ops) {
      if (relevant) break;
      let path = paths.get(op.obj);
      if (!paths.has(op.obj)) {
        path = pathOf(be, op.obj, [hash]) ?? pathOf(be, op.obj, deps);
        paths.set(op.obj, path);
      }
      if (!path) relevant = true;
      else if (
        !this.#ctx.ignore(op.key !== undefined ? [...path, op.key] : path)
      ) {
        relevant = true;
      }
    }
    // Changes only to ignored paths neither form steps nor end a run.
    if (!relevant) return;

    this.#endRun();

    const patches = A.diff(doc, deps, [hash]);
    const splices = textSplices(patches, isTextIn(doc, [hash])).filter(
      (s) => !this.#ctx.ignore(JSON.parse(s.key) as Prop[])
    );
    const ranges = changeRanges(splices);
    const now = this.#now();
    const step = this.#steps.at(-1);
    let join =
      !!step && !this.#checkpoint && now - step.lastTime < this.groupDelayMs;
    // A text edit joins the step only if it touches the step's range.
    if (join && ranges.before.size > 0)
      join = touches(step!.ranges, ranges.before);
    this.#checkpoint = false;
    if (join) {
      step!.changes.push(hash);
      mapRanges(step!.ranges, splices);
      addRanges(step!.ranges, ranges.after);
      step!.lastTime = now;
    } else {
      this.#steps.push({
        changes: [hash],
        lastTime: now,
        ranges: ranges.after,
      });
    }
  }

  /**
   * The next local change that isn't an undo or redo ends the run. If the
   * run ended away from where it started, its changes become one new step
   * on top of the history, so nothing it undid becomes unreachable.
   */
  #endRun() {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    if (run.pointer !== run.start && run.changes.length > 0) {
      this.#steps.push({
        changes: run.changes,
        lastTime: -Infinity,
        ranges: new Map(),
      });
    }
    this.#checkpoint = true;
  }
}

function isTextIn(doc: A.Doc<unknown>, heads: Heads) {
  let view: A.Doc<unknown> | undefined;
  return (path: Prop[]) => {
    view ??= A.view(doc, heads);
    let value: unknown = view;
    for (const prop of path) {
      if (value === null || typeof value !== "object") return false;
      value = (value as Record<Prop, unknown>)[prop];
    }
    return typeof value === "string";
  };
}

function merge(a: UndoResult, b: UndoResult): UndoResult {
  return {
    applied: a.applied || b.applied,
    patches: [...a.patches, ...b.patches],
    skipped: [...a.skipped, ...b.skipped],
    unsupported: a.unsupported + b.unsupported,
  };
}
