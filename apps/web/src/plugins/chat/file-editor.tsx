// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/FilePreviewPanel.tsx (EditableFileSurface: Pierre's editor on the
// file, comments on its lines), fileSaveCoordinator.ts and useFileSaveCoordinator.ts (saving half
// a second after the last change, one write at a time), fileCommentAnnotations.ts and
// fileEditorDismissal.ts.
//
// A project's file edited and saved in the file panel, and commented on (t3-parity.md D1438,
// D1439), in the file panel's chunk.
import type { ReviewCommentContextRecord } from "@jhin/agent-api";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { Editor, type EditorChangeEvent, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useRef, useState } from "react";

import { DiffComment, DiffCommentAnnotation } from "../../lib/comment-annotation.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import { SOURCE_UNSAFE_CSS, useLineReveal } from "./attachment-source.tsx";
import { buildFileReviewComment, reviewCommentRecord } from "../../lib/review-comment-record.ts";

/** T3's FILE_SAVE_DEBOUNCE_MS. */
const SAVE_DEBOUNCE_MS = 500;

interface CommentEntry {
  readonly id: string;
  readonly kind: "draft" | "comment";
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  /** The record of a sent comment, to take it out of the composer again. */
  readonly contextId?: string;
}

interface CommentGroup {
  readonly entries: readonly CommentEntry[];
}

type CommentAnnotation = LineAnnotation<CommentGroup>;

const createFileEditor: EditorFactory<CommentGroup, undefined> = (type, options, key) =>
  new Editor(type, options, key);

/** T3's formatFileCommentRange. */
const rangeLabel = (startLine: number, endLine: number) =>
  startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;

/**
 * T3's FileSaveCoordinator: the latest contents written half a second after the last change, one
 * write at a time, the newest winning; what is left is written when the file closes.
 */
export function createSaveCoordinator(options: {
  readonly debounceMs: number;
  persist(contents: string): Promise<void>;
  onPendingChange(pending: boolean): void;
  onError(error: unknown): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = "";
  let revision = 0;
  let confirmed = 0;
  let saving = false;
  let disposed = false;
  const persistLatest = async (): Promise<void> => {
    if (saving || revision === confirmed) return;
    saving = true;
    const contents = latest;
    const saved = revision;
    try {
      await options.persist(contents);
      confirmed = saved;
    } catch (error) {
      options.onError(error);
    } finally {
      saving = false;
    }
    if (saved === revision) {
      if (confirmed === saved) options.onPendingChange(false);
      return;
    }
    if (disposed) void persistLatest();
    else schedule();
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void persistLatest();
    }, options.debounceMs);
  };
  return {
    change(contents: string) {
      if (disposed) return;
      latest = contents;
      revision += 1;
      options.onPendingChange(true);
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (revision !== confirmed) void persistLatest();
    },
  };
}

/** T3's EditableFileSurface: the file in Pierre's editor, saved as it changes. */
export function FileEditor(props: {
  readonly name: string;
  readonly path: string;
  readonly text: string;
  readonly wordWrap: boolean;
  readonly reveal?: { readonly line: number; readonly id: number } | undefined;
  save(contents: string): Promise<void>;
  onSaveError(error: unknown): void;
  /** Puts a comment's record into the open thread's composer; whether it went in. */
  comment(record: ReviewCommentContextRecord): boolean;
  uncomment(contextId: string): void;
}) {
  const theme = useResolvedTheme();
  const [file] = useState(() => ({ name: props.name, contents: props.text }));
  const onPostRender = useLineReveal(props.text, props.reveal);
  const latest = useRef(props.text);
  const [annotations, setAnnotations] = useState<CommentAnnotation[]>([]);
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);
  const editor = useRef<Editor<"file", CommentGroup, undefined> | null>(null);
  const saveRef = useRef(props.save);
  saveRef.current = props.save;
  const errorRef = useRef(props.onSaveError);
  errorRef.current = props.onSaveError;
  const [coordinator] = useState(() =>
    createSaveCoordinator({
      debounceMs: SAVE_DEBOUNCE_MS,
      persist: (contents) => saveRef.current(contents),
      onPendingChange: () => undefined,
      onError: (error) => errorRef.current(error),
    }),
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  const onEditChange = ({
    file: edited,
    lineAnnotations,
  }: EditorChangeEvent<"file", CommentGroup, undefined>) => {
    if (edited.contents === latest.current) return;
    latest.current = edited.contents;
    coordinator.change(edited.contents);
    // T3's remapFileCommentAnnotations: a comment follows its lines as the text moves.
    if (lineAnnotations !== undefined) {
      setAnnotations(
        lineAnnotations.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((entry) => {
              const span = entry.endLine - entry.startLine;
              return {
                ...entry,
                endLine: annotation.lineNumber,
                startLine: Math.max(1, annotation.lineNumber - span),
              };
            }),
          },
        })),
      );
    }
  };

  const withoutEntry = (current: CommentAnnotation[], id: string) =>
    current.flatMap((annotation) => {
      const entries = annotation.metadata.entries.filter((entry) => entry.id !== id);
      return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
    });
  /** T3's beginComment: a draft under the last line of the selection. */
  const beginComment = (range: SelectedLineRange) => {
    editor.current?.setSelections([]);
    editor.current?.blur();
    const startLine = Math.min(range.start, range.end);
    const endLine = Math.max(range.start, range.end);
    const draft: CommentEntry = {
      id: crypto.randomUUID(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setAnnotations((current) => {
      const kept = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const at = kept.findIndex((annotation) => annotation.lineNumber === endLine);
      if (at < 0) return [...kept, { lineNumber: endLine, metadata: { entries: [draft] } }];
      return kept.map((annotation, index) =>
        index === at
          ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, draft] } }
          : annotation,
      );
    });
  };
  const submit = (entry: CommentEntry, text: string) => {
    setSelected(null);
    const record = reviewCommentRecord(
      buildFileReviewComment({
        filePath: props.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        text,
        contents: latest.current,
      }),
      entry.id,
    );
    if (!props.comment(record)) return;
    setAnnotations((current) =>
      current.map((annotation) => ({
        ...annotation,
        metadata: {
          entries: annotation.metadata.entries.map((candidate) =>
            candidate.id === entry.id
              ? { ...candidate, kind: "comment" as const, text, contextId: record.contextId }
              : candidate,
          ),
        },
      })),
    );
  };
  const commenting = annotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );

  return (
    <EditProvider createEditor={createFileEditor}>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        contentClassName="min-h-full"
      >
        <File<CommentGroup>
          className="min-h-full"
          disableWorkerPool
          edit
          editorOptions={{
            onAttach: (attached) => {
              editor.current = attached;
            },
            onComplete: () => {
              editor.current = null;
            },
          }}
          file={file}
          lineAnnotations={annotations}
          onEditChange={onEditChange}
          options={{
            disableFileHeader: true,
            enableGutterUtility: !commenting,
            enableLineSelection: !commenting,
            onGutterUtilityClick: setSelected,
            onLineSelectionChange: setSelected,
            onLineSelectionEnd: (range) => {
              setSelected(range);
              if (range !== null) beginComment(range);
            },
            overflow: props.wordWrap ? "wrap" : "scroll",
            theme: theme === "dark" ? "pierre-dark" : "pierre-light",
            themeType: theme,
            unsafeCSS: SOURCE_UNSAFE_CSS,
            onPostRender,
          }}
          renderAnnotation={(annotation) => (
            <div className="py-1">
              {annotation.metadata.entries.map((entry) =>
                entry.kind === "draft" ? (
                  <DraftComment
                    entry={entry}
                    key={entry.id}
                    onCancel={() => {
                      setSelected(null);
                      setAnnotations((current) => withoutEntry(current, entry.id));
                    }}
                    onComment={(text) => submit(entry, text)}
                  />
                ) : (
                  <DiffComment
                    key={entry.id}
                    onDelete={() => {
                      if (entry.contextId !== undefined) props.uncomment(entry.contextId);
                      setAnnotations((current) => withoutEntry(current, entry.id));
                    }}
                    text={entry.text}
                  />
                ),
              )}
            </div>
          )}
          selectedLines={selected}
        />
      </Virtualizer>
    </EditProvider>
  );
}

/** A draft comment under its lines, its text kept while it is typed. */
function DraftComment(props: {
  entry: CommentEntry;
  onCancel(): void;
  onComment(text: string): void;
}) {
  const [text, setText] = useState("");
  return (
    <DiffCommentAnnotation
      onCancel={props.onCancel}
      onComment={props.onComment}
      onTextChange={setText}
      pending={false}
      rangeLabel={rangeLabel(props.entry.startLine, props.entry.endLine)}
      text={text}
    />
  );
}
