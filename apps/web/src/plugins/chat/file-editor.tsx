// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/FilePreviewPanel.tsx (EditableFileSurface: Pierre's editor on the
// file, comments on its lines, a change from elsewhere taken in place of its own text),
// fileCommentAnnotations.ts and fileEditorDismissal.ts.
//
// A project's file edited in the file panel, and commented on (t3-parity.md D1438, D1439,
// D1647), in the file panel's chunk. The panel saves it (file-edits.ts).
import type { ReviewCommentContextRecord } from "@jhin/agent-api";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { Editor, type EditorChangeEvent, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useRef, useState } from "react";

import { DiffComment, DiffCommentAnnotation } from "../../lib/comment-annotation.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import { SOURCE_UNSAFE_CSS, useLineReveal } from "./attachment-source.tsx";
import { buildFileReviewComment, reviewCommentRecord } from "../../lib/review-comment-record.ts";

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
 * T3's EditableFileSurface: the file in Pierre's editor. `text` is the panel's (what it read, under
 * its unsaved edits): a change of it from elsewhere (the file changed on disk, D1647) replaces the
 * editor's text; its own edits coming back do not.
 */
export function FileEditor(props: {
  readonly name: string;
  readonly path: string;
  readonly text: string;
  readonly wordWrap: boolean;
  readonly reveal?: { readonly line: number; readonly id: number } | undefined;
  /** The text was edited here: the panel keeps and saves it. */
  onChange(contents: string): void;
  /** Puts a comment's record into the open thread's composer; whether it went in. */
  comment(record: ReviewCommentContextRecord): boolean;
  uncomment(contextId: string): void;
}) {
  const theme = useResolvedTheme();
  // The editor owns the draft, so its own edits echoing back keep the file; only a change from
  // elsewhere replaces it (T3's externalFile and editedContents).
  const [external, setExternal] = useState(() => ({ name: props.name, contents: props.text }));
  const [edited, setEdited] = useState<string | null>(null);
  if (props.text !== (edited ?? external.contents)) {
    setExternal({ name: props.name, contents: props.text });
    setEdited(null);
  }
  // What the editor shows now.
  const contents = edited ?? external.contents;
  const onPostRender = useLineReveal(contents, props.reveal);
  const [annotations, setAnnotations] = useState<CommentAnnotation[]>([]);
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);
  const editor = useRef<Editor<"file", CommentGroup, undefined> | null>(null);

  const onEditChange = ({
    file: changed,
    lineAnnotations,
  }: EditorChangeEvent<"file", CommentGroup, undefined>) => {
    if (changed.contents === contents) return;
    setEdited(changed.contents);
    props.onChange(changed.contents);
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
        contents,
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
          file={external}
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
