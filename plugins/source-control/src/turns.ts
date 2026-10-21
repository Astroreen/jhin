// When checkpoints are taken follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/RunExecutionService.ts (the baseline before the
// provider starts), CheckpointCaptureService.ts and CheckpointService.ts (the
// checkpoint after a completed or stopped run, its file summary, `missing` and
// `error` records that never fail the run) and checkpointing/CheckpointDiffQuery.ts
// (a turn's diff between two checkpoints); reverting follows CheckpointRollbackService.ts and
// CheckpointRestoreSafety.ts.
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { ThreadHooks, type TurnEndHookInput, type TurnHookInput } from "@jhin/agent-api";
import type { PluginContext } from "@jhin/sdk";
import {
  MAX_STATUS_FILES,
  SourceControlEvents,
  TurnCheckpoint,
  type Diff,
  type DiffFileContents,
  type DiffFileRequest,
} from "@jhin/source-control-api";
import type { Json, KeyValueStore } from "@jhin/storage-api";
import { z } from "@jhin/sdk";

import {
  captureCheckpoint,
  checkpointFiles,
  checkpointPatch,
  checkpointPrefix,
  checkpointRef,
  deleteCheckpoints,
  hasCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "./checkpoints.ts";
import {
  SourceControlError,
  createGit,
  locate,
  readDiffFileBetween,
  summarize,
  type Git,
} from "./git.ts";

const NAMESPACE = "jhin.source-control";

/** A checkpoint as kept: where it was taken, too. */
const StoredCheckpoint = TurnCheckpoint.extend({ cwd: z.string() });
type StoredCheckpoint = z.output<typeof StoredCheckpoint>;

/** Per thread: how many turns started, the one running, and the latest checkpoint. */
const ThreadTurns = z.object({
  threadId: z.string(),
  projectId: z.string(),
  count: z.number().int().nonnegative(),
  /** Where its latest turn ran: its checkpoint refs are in that repository. */
  cwd: z.string().optional(),
  running: z
    .object({
      turnId: z.string(),
      turn: z.number().int().positive(),
      /** Its start checkpoint was given up on: it may hold the agent's own first edits. */
      unreliable: z.boolean().optional(),
    })
    .optional(),
  latest: StoredCheckpoint.optional(),
});
type ThreadTurns = z.output<typeof ThreadTurns>;

const pad = (turn: number) => String(turn).padStart(8, "0");
const turnsKey = (threadId: string) => `turns/${threadId}`;
const checkpointKey = (threadId: string, turn: number) => `checkpoint/${threadId}/${pad(turn)}`;
/** A turn's count, kept for every turn started, failed ones too: what a revert goes back to. */
const numberKey = (threadId: string, turnId: string) => `turn-number/${threadId}/${turnId}`;

/** T3's CheckpointRestoreSafety message (D258). */
const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

/** What the threads plugin's rollback hook gets (D220, D257). */
interface RollbackInput {
  readonly thread: {
    readonly id: string;
    readonly projectId: string;
    readonly worktreePath?: string;
  };
  readonly turnIds: readonly string[];
  readonly toTurnId?: string;
  readonly restoreFiles?: boolean;
}

const publicOf = ({ cwd: _cwd, ...checkpoint }: StoredCheckpoint): TurnCheckpoint => checkpoint;

export interface TurnCheckpoints {
  /** Each thread's latest checkpoint. */
  latest(): Promise<TurnCheckpoint[]>;
  list(threadId: string): Promise<TurnCheckpoint[]>;
  diff(
    threadId: string,
    turn: number,
    options: { fromTurn?: number; ignoreWhitespace?: boolean },
  ): Promise<Diff>;
  /** One file of `diff`, both sides read from the two checkpoints (D921). */
  diffFile(
    threadId: string,
    turn: number,
    file: DiffFileRequest,
    options: { fromTurn?: number },
  ): Promise<DiffFileContents>;
  /** Forgets a thread's checkpoints and deletes their refs. */
  remove(threadId: string): Promise<void>;
}

export function followTurns(
  context: PluginContext,
  deps: {
    readonly kv: KeyValueStore;
    readonly gitPath: () => string;
    /** How long a turn's start waits for its checkpoint (the threads plugin fails a turn at 60 s). */
    readonly startTimeoutMs: () => number;
    readonly append: (type: string, payload: unknown) => Promise<void>;
    /** The scratch project (D51) is never a repository, wherever its folder sits. */
    readonly isScratch: (projectId: string) => Promise<boolean>;
  },
): TurnCheckpoints {
  const { kv } = deps;
  /**
   * Checkpoint operations run one at a time per working directory (T3's
   * KeyedLock), and a thread's end and removal one at a time per `thread:<id>`.
   */
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(cwd: string, task: () => Promise<T>): Promise<T> => {
    const result = (locks.get(cwd) ?? Promise.resolve()).then(task, task);
    const settled = result.catch(() => undefined);
    locks.set(cwd, settled);
    void settled.then(() => {
      if (locks.get(cwd) === settled) locks.delete(cwd);
    });
    return result;
  };

  const readTurns = async (threadId: string): Promise<ThreadTurns | undefined> => {
    const parsed = ThreadTurns.safeParse(await kv.get(NAMESPACE, turnsKey(threadId)));
    return parsed.success ? parsed.data : undefined;
  };
  const writeTurns = (record: ThreadTurns) =>
    kv.set(NAMESPACE, turnsKey(record.threadId), record as unknown as Json);

  /** The repository of a turn's directory, or nothing for one that is none. */
  const repositoryOf = async (projectId: string, cwd: string) => {
    if (await deps.isScratch(projectId)) return undefined;
    const location = await locate(deps.gitPath(), cwd);
    if (!location.isRepo) return undefined;
    return { git: createGit(deps.gitPath(), cwd), commonDir: location.commonDir };
  };

  /**
   * Stores a checkpoint and makes it its thread's latest before telling anyone:
   * an event that cannot be appended leaves both records agreeing.
   */
  const record = async (checkpoint: StoredCheckpoint) => {
    await kv.set(
      NAMESPACE,
      checkpointKey(checkpoint.threadId, checkpoint.turn),
      checkpoint as unknown as Json,
    );
    const known = await readTurns(checkpoint.threadId);
    if (known !== undefined) await writeTurns({ ...known, latest: checkpoint });
    await deps.append(SourceControlEvents.checkpointChanged, publicOf(checkpoint));
  };

  /** Writes `ref` unless it exists. */
  const ensure = async (git: Git, commonDir: string, ref: string) => {
    if (!(await hasCheckpoint(git, ref))) await captureCheckpoint(git, commonDir, ref);
  };

  // Before the agent starts: the state it starts from (D244).
  context.subscriptions.add(
    context.hooks.before<TurnHookInput>(ThreadHooks.turnStart, async (input) => {
      try {
        const known = await readTurns(input.threadId);
        const turn = (known?.count ?? 0) + 1;
        await writeTurns({
          threadId: input.threadId,
          projectId: input.projectId,
          count: turn,
          cwd: input.cwd,
          running: { turnId: input.turnId, turn },
          ...(known?.latest === undefined ? {} : { latest: known.latest }),
        });
        await kv.set(NAMESPACE, numberKey(input.threadId, input.turnId), turn);
        const repository = await repositoryOf(input.projectId, input.cwd);
        if (repository !== undefined) {
          // A start that takes too long is given up on here, well before the threads
          // plugin's deadline would fail the turn. It is not cancelled, so it may still
          // write once the agent works: the turn is marked, and ends with an `error` record.
          const capture = locked(input.cwd, () =>
            ensure(repository.git, repository.commonDir, checkpointRef(input.threadId, turn - 1)),
          );
          const giveUp = async () => {
            context.log.warn("a turn's starting checkpoint took too long; the agent starts", {
              threadId: input.threadId,
              turnId: input.turnId,
            });
            const current = await readTurns(input.threadId);
            if (current?.running?.turnId === input.turnId) {
              await writeTurns({ ...current, running: { ...current.running, unreliable: true } });
            }
            void capture.catch(() => undefined);
          };
          const ms = deps.startTimeoutMs();
          if (ms === 0) await giveUp();
          else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let late = false;
            await Promise.race([
              capture,
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  late = true;
                  resolve();
                }, ms);
              }),
            ]).finally(() => clearTimeout(timer));
            if (late) await giveUp();
          }
        }
      } catch (error) {
        context.log.warn("a turn's starting checkpoint could not be written", {
          threadId: input.threadId,
          turnId: input.turnId,
          error: String(error),
        });
      }
      return input;
    }),
  );

  // Before the turn's end is recorded: what it changed (D244, D245).
  context.subscriptions.add(
    context.hooks.before<TurnEndHookInput>(ThreadHooks.turnEnd, async (input) => {
      try {
        // One thread's end and its removal never interleave: no record outlives its thread.
        await locked(`thread:${input.threadId}`, () => endTurn(input));
      } catch (error) {
        context.log.warn("a turn's checkpoint could not be recorded", {
          threadId: input.threadId,
          turnId: input.turnId,
          error: String(error),
        });
      }
      return input;
    }),
  );

  async function endTurn(input: TurnEndHookInput) {
    const known = await readTurns(input.threadId);
    if (known?.running?.turnId !== input.turnId) return;
    const { turn, unreliable } = known.running;
    const { running: _running, ...rest } = known;
    await writeTurns(rest);
    // A failed turn leaves nothing to go back to; the next turn writes its own start.
    if (input.status === "failed") return;
    const repository = await repositoryOf(input.projectId, input.cwd);
    if (repository === undefined) return;
    const ref = checkpointRef(input.threadId, turn);
    const base = {
      threadId: input.threadId,
      turnId: input.turnId,
      turn,
      ref,
      cwd: input.cwd,
      capturedAt: new Date().toISOString(),
    };
    let checkpoint: StoredCheckpoint;
    try {
      const files = await locked(input.cwd, async () => {
        const { git, commonDir } = repository;
        await captureCheckpoint(git, commonDir, ref);
        const previous = checkpointRef(input.threadId, turn - 1);
        // Without the start (its write failed, or the directory became a repository
        // during the turn) what the turn changed is unknown: not "nothing".
        if (!(await hasCheckpoint(git, previous))) {
          throw new Error(`the checkpoint ${previous} the turn started from is missing`);
        }
        // Written after the agent may have started: what the turn changed is unknown.
        if (unreliable === true) {
          throw new Error(`the checkpoint ${previous} the turn started from was given up on`);
        }
        return checkpointFiles(git, previous, ref, { ignoreWhitespace: false });
      });
      const totals = summarize(files);
      checkpoint = {
        ...base,
        status: "ready",
        files: files.slice(0, MAX_STATUS_FILES),
        fileCount: totals.fileCount,
        insertions: totals.insertions,
        deletions: totals.deletions,
      };
    } catch (error) {
      context.log.error("writing a checkpoint failed", {
        threadId: input.threadId,
        turnId: input.turnId,
        error: String(error),
      });
      checkpoint = {
        ...base,
        status: "error",
        files: [],
        fileCount: 0,
        insertions: 0,
        deletions: 0,
      };
    }
    await record(checkpoint);
  }

  const listStored = async (threadId: string): Promise<StoredCheckpoint[]> =>
    (await kv.list(NAMESPACE, { prefix: `checkpoint/${threadId}/` }))
      .map((entry) => StoredCheckpoint.safeParse(entry.value))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data)
      .toSorted((a, b) => a.turn - b.turn);

  const unavailable = (threadId: string, turn: number) =>
    new SourceControlError("CHECKPOINT_UNAVAILABLE", `Turn ${turn} has no checkpoint`, {
      threadId,
      turn,
    });

  // Reverting to a turn (D257, D258): around the threads plugin's rollback, the
  // files go back once the turns are dropped, when asked, and the dropped turns'
  // checkpoints go stale.
  context.subscriptions.add(
    context.hooks.around<RollbackInput, unknown>(ThreadHooks.rollback, async (input, next) => {
      const threadId = input.thread.id;
      const numberOf = async (turnId: string) => {
        const value = await kv.get(NAMESPACE, numberKey(threadId, turnId));
        return typeof value === "number" ? value : undefined;
      };
      // Back to the state before the first dropped turn: the checkpoint it started
      // from. Only that turn's own count says which one; a thread from before counts
      // were kept has none, and its files are not restored.
      const first = input.turnIds[0] === undefined ? undefined : await numberOf(input.turnIds[0]);
      if (input.restoreFiles !== true) {
        const result = await next(input);
        const counts = (await Promise.all(input.turnIds.map(numberOf))).filter(
          (value): value is number => value !== undefined,
        );
        const lowest = first ?? (counts.length === 0 ? undefined : Math.min(...counts));
        if (lowest !== undefined) await afterRevert(threadId, lowest - 1);
        return result;
      }
      if (first === undefined) throw unavailable(threadId, 0);
      const target = first - 1;
      const cwd = await isolatedWorktree(input);
      const git = createGit(deps.gitPath(), cwd);
      const ref = checkpointRef(threadId, target);
      // Checked, dropped and restored under the directory's lock: no turn or other
      // revert writes there in between. A refused restore drops nothing.
      let dropped = false;
      try {
        return await locked(cwd, async () => {
          if (!(await hasCheckpoint(git, ref))) throw unavailable(threadId, target);
          const result = await next(input);
          dropped = true;
          try {
            await restoreCheckpoint(git, cwd, ref);
          } catch (error) {
            throw new SourceControlError(
              "GIT_FAILED",
              `The turns were dropped, but the files could not be restored: ${(error as Error).message}`,
              { threadId },
            );
          }
          return result;
        });
      } finally {
        // Outside the directory's lock, which forgetting the refs takes itself.
        if (dropped) await afterRevert(threadId, target);
      }
    }),
  );

  /** The dropped turns' records follow the thread; a failure is logged as an error. */
  const afterRevert = (threadId: string, target: number) =>
    locked(`thread:${threadId}`, () => forget(threadId, target)).catch((error: unknown) =>
      context.log.error("a revert's checkpoints could not be updated", {
        threadId,
        error: String(error),
      }),
    );

  /**
   * The thread's own worktree, when no other thread works in it; anything else may
   * hold another thread's changes (T3's CheckpointRestoreSafety).
   */
  async function isolatedWorktree(input: RollbackInput): Promise<string> {
    const cwd = input.thread.worktreePath;
    const real = (value: string) => Fs.realpath(value).catch(() => Path.resolve(value));
    const others =
      cwd === undefined
        ? []
        : await Promise.all(
            (
              (await context.commands.execute("threads.list", {})) as {
                id: string;
                worktreePath?: string;
              }[]
            )
              .filter((other) => other.id !== input.thread.id && other.worktreePath !== undefined)
              .map(async (other) => (await real(other.worktreePath!)) === (await real(cwd))),
          );
    if (cwd === undefined || others.some(Boolean)) {
      throw new SourceControlError("WORKTREE_INVALID", SHARED_WORKSPACE_RESTORE_MESSAGE, {
        threadId: input.thread.id,
      });
    }
    return cwd;
  }

  return {
    latest: async () =>
      (await kv.list(NAMESPACE, { prefix: "turns/" }))
        .map((entry) => ThreadTurns.safeParse(entry.value))
        .flatMap((parsed) =>
          parsed.success && parsed.data.latest !== undefined ? [publicOf(parsed.data.latest)] : [],
        ),
    list: async (threadId) => (await listStored(threadId)).map(publicOf),
    diff: async (threadId, turn, options) => {
      const { known, target, fromTurn, git, from } = await compared(threadId, turn, options);
      const ignoreWhitespace = options.ignoreWhitespace === true;
      const files = await checkpointFiles(git, from, target.ref, { ignoreWhitespace });
      const { patch, truncated } = await checkpointPatch(git, from, target.ref, files, {
        ignoreWhitespace,
      });
      const totals = summarize(files);
      return {
        projectId: known.projectId,
        scope: "turn",
        baseRef: null,
        headRef: null,
        fromTurn,
        turn,
        patch,
        truncated,
        files,
        insertions: totals.insertions,
        deletions: totals.deletions,
      };
    },
    diffFile: async (threadId, turn, file, options) => {
      const { target, git, from } = await compared(threadId, turn, options);
      const files = await checkpointFiles(git, from, target.ref, { ignoreWhitespace: false });
      return readDiffFileBetween(git, target.cwd, { from, to: target.ref }, files, file);
    },
    remove: (threadId) => locked(`thread:${threadId}`, () => removeThread(threadId)),
  };

  /** The two checkpoints a turn's diff compares, both still there. */
  async function compared(threadId: string, turn: number, options: { fromTurn?: number }) {
    const known = await readTurns(threadId);
    const target = (await listStored(threadId)).find((checkpoint) => checkpoint.turn === turn);
    if (known === undefined || target?.status !== "ready") throw unavailable(threadId, turn);
    const fromTurn = options.fromTurn ?? turn - 1;
    if (fromTurn < 0 || fromTurn > turn) throw unavailable(threadId, fromTurn);
    const git = createGit(deps.gitPath(), target.cwd);
    const from = checkpointRef(threadId, fromTurn);
    if (!(await hasCheckpoint(git, from)) || !(await hasCheckpoint(git, target.ref))) {
      throw unavailable(threadId, fromTurn);
    }
    return { known, target, fromTurn, git, from };
  }

  /**
   * The dropped turns' checkpoints go stale and their refs away; the thread's
   * count goes back to `target`, so its next turn takes the first dropped one's
   * place, and its latest checkpoint is the one it went back to.
   */
  async function forget(threadId: string, target: number) {
    const stored = await listStored(threadId);
    const dropped = stored.filter((checkpoint) => checkpoint.turn > target);
    const kept = stored.filter((checkpoint) => checkpoint.turn <= target).at(-1);
    const cwd = (await readTurns(threadId))?.cwd ?? stored.at(-1)?.cwd;
    if (cwd !== undefined) {
      const git = createGit(deps.gitPath(), cwd);
      const refs = (await listCheckpoints(git, checkpointPrefix(threadId))).filter(
        (ref) => Number(ref.slice(checkpointPrefix(threadId).length)) > target,
      );
      await locked(cwd, () => deleteCheckpoints(git, refs));
    }
    const known = await readTurns(threadId);
    if (known !== undefined) {
      const { latest: _latest, ...rest } = known;
      await writeTurns({ ...rest, count: target, ...(kept === undefined ? {} : { latest: kept }) });
    }
    for (const checkpoint of dropped) {
      const stale: StoredCheckpoint = { ...checkpoint, status: "stale" };
      await kv.set(NAMESPACE, checkpointKey(threadId, checkpoint.turn), stale as unknown as Json);
      await deps.append(SourceControlEvents.checkpointChanged, publicOf(stale));
    }
    // The checkpoint gone back to is the thread's latest again.
    if (kept !== undefined)
      await deps.append(SourceControlEvents.checkpointChanged, publicOf(kept));
  }

  async function removeThread(threadId: string) {
    const stored = await listStored(threadId);
    const cwd = (await readTurns(threadId))?.cwd ?? stored.at(-1)?.cwd;
    if (cwd !== undefined) {
      try {
        const git = createGit(deps.gitPath(), cwd);
        await locked(cwd, async () =>
          deleteCheckpoints(git, await listCheckpoints(git, checkpointPrefix(threadId))),
        );
      } catch (error) {
        context.log.warn("deleting a thread's checkpoints failed", {
          threadId,
          error: String(error),
        });
      }
    }
    for (const checkpoint of stored) {
      await kv.delete(NAMESPACE, checkpointKey(threadId, checkpoint.turn));
    }
    for (const entry of await kv.list(NAMESPACE, { prefix: `turn-number/${threadId}/` })) {
      await kv.delete(NAMESPACE, entry.key);
    }
    await kv.delete(NAMESPACE, turnsKey(threadId));
  }
}
