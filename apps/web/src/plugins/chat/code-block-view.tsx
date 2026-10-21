// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ComposerCodeBlockNodeView.tsx
// and ComposerCodeBlockLanguagePicker.tsx (the language picker of a code block in the prompt).
import {
  Button,
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "@jhin/ui";
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
  useEditorState,
} from "@tiptap/react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import {
  CODE_BLOCK_LANGUAGES,
  type CodeBlockLanguage,
  codeLanguageEntry,
  codeLanguageLabel,
  languageOfInfoString,
  withInfoStringLanguage,
} from "../../lib/code-languages.ts";

/** The header's class, whose events the editor leaves alone (`stopEvent`). */
export const CODE_BLOCK_HEADER_CLASS_NAME = "composer-codeblock-header";

function LanguagePicker(props: {
  language: string;
  disabled: boolean;
  onChange: (language: string) => void;
}) {
  const [query, setQuery] = useState("");
  const current = codeLanguageEntry(props.language)?.id ?? props.language;
  const items: CodeBlockLanguage[] = CODE_BLOCK_LANGUAGES.some((entry) => entry.id === current)
    ? [...CODE_BLOCK_LANGUAGES]
    : [{ id: current, label: current }, ...CODE_BLOCK_LANGUAGES];
  const needle = query.trim().toLowerCase();
  const filteredItems = needle
    ? items.filter(
        (entry) => entry.label.toLowerCase().includes(needle) || entry.id.includes(needle),
      )
    : items;
  const selected = items.find((entry) => entry.id === current) ?? null;

  return (
    <span className="-ml-1.5 flex min-w-0">
      <Combobox
        items={items}
        filteredItems={filteredItems}
        autoHighlight
        itemToStringLabel={(entry) => entry.label}
        isItemEqualToValue={(a, b) => a.id === b.id}
        value={selected}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(entry) => {
          if (entry && entry.id !== current) props.onChange(entry.id);
        }}
      >
        <ComboboxTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              disabled={props.disabled}
              aria-label={`Code language: ${codeLanguageLabel(props.language)}`}
            />
          }
        >
          <span className="max-w-40 truncate font-mono text-2xs">
            {codeLanguageLabel(props.language)}
          </span>
          <ChevronDownIcon className="size-3 opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-56">
          <ComboboxSearchInput
            aria-label="Search languages"
            placeholder="Search languages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching languages.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {(entry: CodeBlockLanguage) => (
              <ComboboxItem key={entry.id || "plain"} value={entry}>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.id === current ? <CheckIcon className="ml-auto size-3.5" /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </span>
  );
}

/** A code block of the prompt: T3's frame, with the language picker in its header (D842). */
export function CodeBlockView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable });
  const info = typeof node.attrs["language"] === "string" ? node.attrs["language"] : "";
  const changeLanguage = (next: string) => {
    updateAttributes({ language: withInfoStringLanguage(info, next) });
    const position = getPos();
    if (typeof position === "number") editor.commands.focus(position + 1 + node.content.size);
  };
  return (
    <NodeViewWrapper
      className="my-1 overflow-hidden rounded-md border border-border/70 bg-muted"
      data-language={info}
    >
      <div
        className={`${CODE_BLOCK_HEADER_CLASS_NAME} flex items-center pt-1 pl-3 select-none`}
        contentEditable={false}
      >
        <LanguagePicker
          language={languageOfInfoString(info)}
          disabled={!editable}
          onChange={changeLanguage}
        />
      </div>
      <pre className="max-w-full overflow-x-auto px-3 pt-1 pb-2">
        {/* A caret needs a line to sit on even before any code is typed. */}
        <NodeViewContent<"code">
          as="code"
          className="block min-h-[1lh] font-mono whitespace-pre-wrap [overflow-wrap:anywhere]"
        />
      </pre>
    </NodeViewWrapper>
  );
}
