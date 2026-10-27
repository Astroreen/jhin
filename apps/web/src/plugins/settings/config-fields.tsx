// The fields of a config section's form (D80–D83). Rows, switches, selects,
// inputs, secret inputs and lists follow T3 Code's settings forms (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/settings/ProviderSettingsForm.tsx,
// SecretInput.tsx and FoldedSettingsSection.tsx.
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  Input,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  cn,
} from "@jhin/ui";
import { configControlSlot, isRedactedSecret, type ConfigControlProps } from "@jhin/client-api";
import { Slot, useOptionalSlot } from "@jhin/ui";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import {
  equal,
  getAt,
  redact,
  renameKey,
  restore,
  isShown,
  Unparsed,
  type Field,
  type JsonSchema,
  type Option,
} from "../../lib/config-form.ts";
import { SettingResetButton, SettingsRow } from "../../lib/settings-layout.tsx";
import { InheritanceButton, type InheritanceLayer } from "./project-scope.tsx";

/** What every field of one section reads and changes. */
export interface FieldsContext {
  /** The edited file's part of the section, as edited. */
  readonly value: unknown;
  /**
   * The other file's part (D477): the project file wins over the node file,
   * the node file is what the project file wins over.
   */
  readonly other: { readonly layer: "node" | "project"; readonly value: unknown };
  /** Errors by path inside the section, joined with dots. */
  readonly errors: ReadonlyMap<string, readonly string[]>;
  /** The section's schema, for the references inside its fields' schemas. */
  readonly root: JsonSchema;
  /** Sets `path` in the node file's part; `undefined` removes the key. */
  set(path: readonly string[], next: unknown): void;
  /**
   * The settings page's project scope (D1463): where a top-level field's value
   * comes from, shown as T3's layers button.
   */
  readonly inheritance?: (field: Field) => FieldInheritance | undefined;
  /** What the reset says: T3's "Reset to inherited value" in a project's scope. */
  readonly resetTooltip?: string;
  /** Shown but not editable: a node-wide setting in a project's scope (D1463). */
  readonly disabled?: boolean;
  /** What an unset choice without a default is called, and offered as (T3's "Inherit"). */
  readonly unsetLabel?: string;
}

/** A field's layers (a project's scope) or only its summary (all projects). */
export interface FieldInheritance {
  readonly summary: string;
  readonly layers?: readonly InheritanceLayer[];
  readonly overridden: boolean;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
const brief = (value: unknown) => {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};
const dotted = (path: readonly string[]) => path.join(".");

/** The errors at `path`, or at and below it. */
function errorsAt(
  context: FieldsContext,
  path: readonly string[],
  below = false,
): readonly string[] {
  const key = dotted(path);
  if (!below) return context.errors.get(key) ?? [];
  return [...context.errors.entries()]
    .filter(([at]) => at === key || key === "" || at.startsWith(`${key}.`))
    .flatMap(([at, messages]) =>
      at === key ? messages : messages.map((message) => `${at.slice(key.length + 1)}: ${message}`),
    );
}

function Errors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <span className="block text-destructive-foreground" id={id} role="alert">
      {messages.join(" · ")}
    </span>
  );
}

const optionKey = (value: Option["value"] | null) => JSON.stringify(value);

/** The select item that removes the key. */
const UNSET = "\u0000unset";

/** A leaf value's control: text, number, switch or select. */
function LeafControl(props: {
  field: Field;
  label: string;
  value: unknown;
  onChange(next: unknown): void;
  invalid: boolean;
  describedBy?: string | undefined;
  className?: string;
  disabled?: boolean;
  /** A choice without a default offers this item for "unset" (T3's "Inherit", D1463). */
  unsetLabel?: string | undefined;
}) {
  const { field, value, onChange } = props;
  const aria = {
    "aria-label": props.label,
    ...(props.invalid ? { "aria-invalid": true as const } : {}),
    ...(props.describedBy === undefined ? {} : { "aria-describedby": props.describedBy }),
  };
  const placeholder =
    field.hasDefault && field.default !== null && typeof field.default !== "object"
      ? String(field.default)
      : (field.example ?? "Not set");
  const [numberText, setNumberText] = useState("");
  const width = cn("w-full @min-[32rem]/settings-row:w-56", props.className);
  switch (field.control.kind) {
    case "switch":
      return (
        <Switch
          {...aria}
          checked={typeof value === "boolean" ? value : field.default === true}
          disabled={props.disabled}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
      );
    case "select": {
      const options = field.control.options;
      const current =
        value === undefined || value instanceof Unparsed
          ? field.hasDefault
            ? field.default
            : undefined
          : value;
      const chosen = options.find((option) => equal(option.value, current));
      const unset = field.hasDefault ? undefined : props.unsetLabel;
      return (
        <Select
          disabled={props.disabled}
          onValueChange={(next) => {
            if (unset !== undefined && next === UNSET) return onChange(undefined);
            const option = options.find((item) => optionKey(item.value) === next);
            if (option !== undefined) onChange(option.value);
          }}
          value={
            chosen === undefined ? (unset === undefined ? "" : UNSET) : optionKey(chosen.value)
          }
        >
          <SelectTrigger {...aria} className={width} size="sm">
            <SelectValue>
              {chosen?.label ?? unset ?? <span className="text-muted-foreground">Not set</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {unset === undefined ? null : <SelectItem value={UNSET}>{unset}</SelectItem>}
            {options.map((option) => (
              <SelectItem key={optionKey(option.value)} value={optionKey(option.value)}>
                {option.label}
                {field.hasDefault && equal(option.value, field.default) ? (
                  <span className="text-muted-foreground"> (default)</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    }
    case "number": {
      // What was typed, while it still reads as the value ("1." for 1).
      const shown =
        value instanceof Unparsed
          ? value.text
          : isRedactedSecret(value)
            ? value
            : numberText.trim() !== "" && Number(numberText) === value
              ? numberText
              : typeof value === "number"
                ? String(value)
                : "";
      const integer = field.control.integer;
      return (
        <Input
          {...aria}
          className={width}
          disabled={props.disabled}
          inputMode={integer ? "numeric" : "decimal"}
          {...(field.secret ? { type: "password", autoComplete: "off" } : {})}
          nativeInput
          onChange={(event) => {
            const text = event.target.value;
            setNumberText(text);
            const number = Number(text);
            onChange(
              text.trim() === ""
                ? undefined
                : Number.isFinite(number)
                  ? number
                  : new Unparsed(text, integer ? "Enter a whole number" : "Enter a number"),
            );
          }}
          placeholder={placeholder}
          size="sm"
          value={shown}
        />
      );
    }
    default:
      // T3's text area, rows growing with the text (D1461).
      if (field.control.kind === "text" && field.control.multiline) {
        return (
          <Textarea
            {...aria}
            disabled={props.disabled}
            onChange={(event) =>
              onChange(
                event.target.value === "" && field.clearWhenEmpty === "omit"
                  ? undefined
                  : event.target.value,
              )
            }
            placeholder={value === "" ? "Empty" : placeholder}
            rows={4}
            value={typeof value === "string" ? value : ""}
          />
        );
      }
      // A secret is typed, never shown (D83).
      return (
        <Input
          {...aria}
          autoComplete="off"
          className={width}
          disabled={props.disabled}
          nativeInput
          onChange={(event) =>
            onChange(
              event.target.value === "" && field.clearWhenEmpty === "omit"
                ? undefined
                : event.target.value,
            )
          }
          placeholder={
            field.secret && typeof value === "string" && value !== ""
              ? "Stored secret, enter a new value to replace"
              : value === ""
                ? "Empty"
                : placeholder
          }
          size="sm"
          spellCheck={false}
          type={field.secret ? "password" : "text"}
          value={typeof value === "string" ? value : ""}
        />
      );
  }
}

/** A value the form cannot render, edited as JSON in place (D80). */
function JsonControl(props: {
  label: string;
  value: unknown;
  onChange(next: unknown): void;
  invalid: boolean;
  describedBy?: string | undefined;
  rows?: number;
  /** Why a value that parses is still refused here. */
  refuse?(value: unknown): string | undefined;
  /**
   * The value as shown: secrets replaced (D83). What is typed gets them back
   * from the value it edits, wherever the placeholder is left.
   */
  hide?(value: unknown): unknown;
}) {
  const [text, setText] = useState("");
  const shownValue = props.hide === undefined ? props.value : props.hide(props.value);
  const parsed = (() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false as const };
    }
  })();
  const shown =
    props.value instanceof Unparsed
      ? props.value.text
      : text.trim() !== "" && parsed.ok && equal(parsed.value, shownValue)
        ? text
        : shownValue === undefined
          ? ""
          : pretty(shownValue);
  return (
    <Textarea
      aria-label={props.label}
      className="mt-2 mb-2 font-mono text-xs"
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === "") return props.onChange(undefined);
        try {
          const value = JSON.parse(next) as unknown;
          const refused = props.refuse?.(value);
          props.onChange(
            refused !== undefined
              ? new Unparsed(next, refused)
              : props.hide === undefined
                ? value
                : restore(value, props.value),
          );
        } catch (error) {
          props.onChange(new Unparsed(next, `Invalid JSON: ${(error as Error).message}`));
        }
      }}
      placeholder="Not set (JSON)"
      rows={props.rows ?? 3}
      spellCheck={false}
      value={shown}
      {...(props.invalid ? { "aria-invalid": true } : {})}
      {...(props.describedBy === undefined ? {} : { "aria-describedby": props.describedBy })}
    />
  );
}

const isLeaf = (field: Field) =>
  field.control.kind === "text" ||
  field.control.kind === "number" ||
  field.control.kind === "switch" ||
  field.control.kind === "select";

/** One item of a list, or the value of a map entry. */
function ItemControl(props: {
  field: Field;
  label: string;
  path: readonly string[];
  context: FieldsContext;
}) {
  const { field, path, context } = props;
  const id = useId();
  const value = getAt(context.value, path);
  const messages = errorsAt(context, path, !isLeaf(field));
  const change = (next: unknown) => context.set(path, next);
  return (
    <div className="min-w-0 flex-1">
      {field.control.kind === "list" ? (
        <ListItems context={context} field={field} label={props.label} path={path} />
      ) : field.control.kind === "group" ? (
        <div className="rounded-lg border border-border/50">
          <Fields context={context} fields={field.control.fields} path={path} />
        </div>
      ) : isLeaf(field) ? (
        <LeafControl
          className="@min-[32rem]/settings-row:w-full"
          describedBy={messages.length === 0 ? undefined : id}
          field={field}
          invalid={messages.length > 0}
          label={props.label}
          onChange={change}
          value={value}
        />
      ) : (
        <JsonControl
          describedBy={messages.length === 0 ? undefined : id}
          hide={(shown) => redact(field.schema, shown, context.root, field.secret)}
          invalid={messages.length > 0}
          label={props.label}
          onChange={change}
          value={value}
        />
      )}
      {isLeaf(field) ? (
        <p className="mt-1 text-xs empty:hidden">
          <Errors id={id} messages={messages} />
        </p>
      ) : null}
    </div>
  );
}

/** The items of a list of values (D80). */
function ListItems(props: {
  field: Field;
  label: string;
  path: readonly string[];
  context: FieldsContext;
}) {
  const { field, path, context } = props;
  // An identity per item, moved with it, so what an item's fields hold (a
  // folded "Advanced", a key being renamed) stays with that item (D479).
  const ids = useRef<number[]>([]);
  const nextId = useRef(0);
  if (field.control.kind !== "list") return null;
  const item = field.control.item;
  const value = getAt(context.value, path);
  const items = Array.isArray(value) ? value : [];
  // Changed elsewhere (the JSON view, a reset): identities start over.
  if (ids.current.length !== items.length) {
    ids.current = items.map(() => nextId.current++);
  }
  const blank = (): unknown =>
    item.control.kind === "group"
      ? // Its required keys are reported until they are filled in (D479).
        {}
      : item.control.kind === "switch"
        ? false
        : item.control.kind === "select"
          ? item.control.options[0]?.value
          : item.control.kind === "number"
            ? new Unparsed("", "Enter a number")
            : "";
  const move = (from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const order = [...ids.current];
    const [id] = order.splice(from, 1);
    order.splice(to, 0, id!);
    ids.current = order;
    context.set(path, next);
  };
  if (item.control.kind === "group") {
    const fields = item.control.fields;
    return (
      <div className="mt-2 mb-2 min-w-0 space-y-2">
        {items.map((entry, index) => {
          const label = `${props.label} ${index + 1}`;
          const itemPath = [...path, String(index)];
          return (
            <div
              aria-label={label}
              className="rounded-lg border border-border/50"
              key={ids.current[index]}
              role="group"
            >
              <div className="flex items-center gap-1 border-b border-border/50 px-3 py-1.5 sm:px-4">
                <span className="me-auto text-xs font-medium text-foreground/80">{label}</span>
                <Button
                  aria-label={`Move ${label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  aria-label={`Move ${label} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    ids.current = ids.current.filter((_id, at) => at !== index);
                    context.set(
                      path,
                      items.filter((_item, at) => at !== index),
                    );
                  }}
                  size="icon-xs"
                  variant="ghost-destructive"
                >
                  <XIcon />
                </Button>
              </div>
              {typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (
                <div className="[&>*+*]:border-t [&>*+*]:border-border/50">
                  <Fields context={context} fields={fields} path={itemPath} />
                </div>
              ) : (
                <div className="px-3 sm:px-4">
                  <ItemControl
                    context={context}
                    field={{ ...item, control: { kind: "json" } }}
                    label={label}
                    path={itemPath}
                  />
                </div>
              )}
            </div>
          );
        })}
        <Button
          onClick={() => {
            ids.current = [...ids.current, nextId.current++];
            context.set(path, [...items, blank()]);
          }}
          size="xs"
          variant="outline"
        >
          <PlusIcon />
          Add
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 mb-2 min-w-0 space-y-1.5">
      {items.map((_, index) => (
        // Items have no identity but their place; the list re-renders whole on removal.
        // oxlint-disable-next-line react/no-array-index-key
        <div className="flex min-w-0 items-start gap-1.5" key={ids.current[index]}>
          <ItemControl
            context={context}
            field={item}
            label={`${props.label} ${index + 1}`}
            path={[...path, String(index)]}
          />
          <Button
            aria-label={`Remove ${props.label} ${index + 1}`}
            className="mt-1"
            onClick={() =>
              context.set(
                path,
                items.filter((_item, at) => at !== index),
              )
            }
            size="icon-xs"
            variant="ghost-destructive"
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button onClick={() => context.set(path, [...items, blank()])} size="xs" variant="outline">
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

/** The entries of a record: a key and a value each (D80). */
function MapEntries(props: {
  field: Field;
  label: string;
  path: readonly string[];
  context: FieldsContext;
}) {
  const { field, path, context } = props;
  const [draft, setDraft] = useState("");
  // A renamed row mounts again under its new key: it takes the focus back (D480).
  const [renamed, setRenamed] = useState<string | undefined>();
  if (field.control.kind !== "map") return null;
  const valueField = field.control.value;
  const current = getAt(context.value, path);
  const entries =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? Object.entries(current)
      : [];
  const taken = new Set(entries.map(([key]) => key));
  const add = () => {
    if (draft === "" || taken.has(draft)) return;
    const blank =
      valueField.control.kind === "list"
        ? []
        : valueField.control.kind === "switch"
          ? false
          : valueField.control.kind === "select"
            ? valueField.control.options[0]?.value
            : valueField.control.kind === "group"
              ? {}
              : "";
    context.set([...path, draft], blank);
    setDraft("");
  };
  return (
    <div className="mt-2 mb-2 min-w-0 space-y-2">
      {entries.map(([key]) => (
        <div className="flex min-w-0 items-start gap-1.5" key={key}>
          <KeyInput
            focus={key === renamed}
            label={`Key ${key} of ${props.label}`}
            onRename={(next) => {
              const value = renameKey(Object.fromEntries(entries), key, next);
              if (value === undefined) return false;
              setRenamed(next);
              context.set(path, value);
              return true;
            }}
            taken={(next) => next !== key && taken.has(next)}
            value={key}
          />
          <ItemControl
            context={context}
            field={valueField}
            label={`${props.label} ${key}`}
            path={[...path, key]}
          />
          <Button
            aria-label={`Remove ${props.label} ${key}`}
            className="mt-1"
            onClick={() => context.set([...path, key], undefined)}
            size="icon-xs"
            variant="ghost-destructive"
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          aria-label={`New key of ${props.label}`}
          className="w-40"
          nativeInput
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
          placeholder="New key"
          size="sm"
          spellCheck={false}
          value={draft}
        />
        <Button
          disabled={draft === "" || taken.has(draft)}
          onClick={add}
          size="xs"
          variant="outline"
        >
          <PlusIcon />
          Add
        </Button>
        {taken.has(draft) ? (
          <span className="text-xs text-destructive-foreground">That key is there already</span>
        ) : null}
      </div>
    </div>
  );
}

/** A record's key, renamed in place on Enter or when left; Escape gives it back (D480). */
function KeyInput(props: {
  value: string;
  /** Takes the focus when it mounts. */
  focus?: boolean;
  label: string;
  taken(next: string): boolean;
  /** Whether the entry took the new key. */
  onRename(next: string): boolean;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  const id = useId();
  const text = draft ?? props.value;
  const problem =
    text === ""
      ? "A key cannot be empty"
      : props.taken(text)
        ? "That key is there already"
        : undefined;
  const commit = () => {
    if (draft === undefined || draft === props.value) return setDraft(undefined);
    if (problem === undefined && props.onRename(draft)) setDraft(undefined);
  };
  // Leaving the field with a key that is refused gives the old key back (D480).
  const leave = () => {
    commit();
    if (problem !== undefined) setDraft(undefined);
  };
  return (
    <div className="w-40 shrink-0">
      <Input
        aria-label={props.label}
        autoFocus={props.focus === true}
        className="font-mono"
        nativeInput
        onBlur={leave}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(undefined);
        }}
        size="sm"
        spellCheck={false}
        value={text}
        {...(problem === undefined ? {} : { "aria-invalid": true, "aria-describedby": id })}
      />
      {problem === undefined ? null : (
        <span className="mt-1 block text-xs text-destructive-foreground" id={id} role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

/** A control a plugin contributes for the field (D482). */
function ContributedControl(props: ConfigControlProps & { name: string }) {
  const { name, ...control } = props;
  return <Slot first name={configControlSlot(name)} props={control} />;
}

/** Whether a plugin contributes the control a field asks for (D482). */
function useContributed(field: Field): boolean {
  const contributions = useOptionalSlot(
    field.controlName === undefined ? "" : configControlSlot(field.controlName),
  );
  return field.controlName !== undefined && contributions.length > 0;
}

function FieldTitle({ field }: { field: Field }) {
  return (
    <>
      {field.title}
      {field.deprecated ? (
        <Badge className="ms-1.5 align-middle" size="sm" variant="warning">
          Deprecated
        </Badge>
      ) : null}
    </>
  );
}

/** One field of the section: a row, or a group of rows with its own header. */
function FieldRow({
  field,
  path,
  context,
}: {
  field: Field;
  path: readonly string[];
  context: FieldsContext;
}) {
  const id = useId();
  const contributed = useContributed(field);
  const value = getAt(context.value, path);
  const set = value !== undefined;
  const reset =
    set && context.disabled !== true ? (
      <SettingResetButton
        label={field.title}
        onClick={() => context.set(path, undefined)}
        {...(context.resetTooltip === undefined ? {} : { tooltip: context.resetTooltip })}
      />
    ) : undefined;
  const inheritance = path.length === 1 ? context.inheritance?.(field) : undefined;
  const title = (
    <>
      <FieldTitle field={field} />
      {inheritance === undefined ? null : (
        <InheritanceButton
          overridden={inheritance.overridden}
          summary={inheritance.summary}
          title={field.title}
          {...(inheritance.layers === undefined ? {} : { layers: inheritance.layers })}
        />
      )}
    </>
  );
  const fromOther = getAt(context.other.value, path);
  const shownOther = field.secret ? (
    "it"
  ) : (
    <code>{brief(redact(field.schema, fromOther, context.root))}</code>
  );
  const override =
    fromOther === undefined ? null : context.other.layer === "project" ? (
      <span className="block">The project file sets {shownOther}, which wins.</span>
    ) : (
      <span className="block">The node file sets {shownOther}; this file wins over it.</span>
    );

  if (field.control.kind === "group") {
    const messages = errorsAt(context, path);
    return (
      <div aria-label={field.title} role="group">
        <div className="flex items-start gap-1.5 px-3 pt-3 pb-2 sm:px-4">
          <div className="min-w-0 flex-1 space-y-0.5">
            <h3 className="flex min-h-5 items-center gap-1.5 text-xs font-semibold tracking-wide text-foreground/80 uppercase">
              {title}
              <span className="inline-flex size-5 items-center justify-center">{reset}</span>
            </h3>
            {field.description === undefined ? null : (
              <p className="max-w-xl text-xs text-muted-foreground/80">{field.description}</p>
            )}
            <p className="text-xs empty:hidden">
              <Errors id={id} messages={messages} />
            </p>
          </div>
        </div>
        <div className="ms-3 border-s border-border/50 sm:ms-4 [&>*+*]:border-t [&>*+*]:border-border/50">
          <Fields context={context} fields={field.control.fields} path={path} />
        </div>
      </div>
    );
  }

  const below = !isLeaf(field);
  const messages = errorsAt(context, path, below);
  const describedBy = messages.length === 0 ? undefined : id;
  const status =
    messages.length === 0 && override === null ? undefined : (
      <>
        {override}
        <Errors id={id} messages={messages} />
      </>
    );
  const row = {
    title,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(status === undefined ? {} : { status }),
    ...(reset === undefined ? {} : { resetAction: reset }),
  };

  if (contributed && field.controlName !== undefined) {
    return (
      <SettingsRow
        {...row}
        control={
          <ContributedControl
            disabled={value === null || context.disabled === true}
            field={{
              key: field.key,
              path,
              title: field.title,
              schema: field.schema,
              hasDefault: field.hasDefault,
              ...(field.hasDefault ? { default: field.default } : {}),
              ...(field.example === undefined ? {} : { example: field.example }),
              secret: field.secret,
            }}
            invalid={messages.length > 0}
            label={field.title}
            name={field.controlName}
            onChange={(next) => context.set(path, next)}
            value={value}
            {...(describedBy === undefined ? {} : { describedBy })}
          />
        }
      />
    );
  }
  // T3's text area goes under its row's title, as a list does (D1461).
  if (field.control.kind === "text" && field.control.multiline) {
    return (
      <SettingsRow {...row}>
        <div className="mt-3 max-w-2xl pb-3.5">
          <LeafControl
            describedBy={describedBy}
            disabled={context.disabled === true}
            field={field}
            invalid={messages.length > 0}
            label={field.title}
            onChange={(next) => context.set(path, next)}
            value={value}
          />
        </div>
      </SettingsRow>
    );
  }
  switch (field.control.kind) {
    case "list":
      return (
        <SettingsRow {...row}>
          <ListItems context={context} field={field} label={field.title} path={path} />
        </SettingsRow>
      );
    case "map":
      return (
        <SettingsRow {...row}>
          <MapEntries context={context} field={field} label={field.title} path={path} />
        </SettingsRow>
      );
    case "json":
      return (
        <SettingsRow {...row}>
          <JsonControl
            describedBy={describedBy}
            hide={(shown) => redact(field.schema, shown, context.root, field.secret)}
            invalid={messages.length > 0}
            label={field.title}
            onChange={(next) => context.set(path, next)}
            value={value}
          />
        </SettingsRow>
      );
    default: {
      const leaf = (
        <LeafControl
          describedBy={describedBy}
          disabled={value === null || context.disabled === true}
          field={field}
          unsetLabel={context.unsetLabel}
          invalid={messages.length > 0}
          label={field.title}
          onChange={(next) => context.set(path, next)}
          value={value}
        />
      );
      return (
        <SettingsRow
          {...row}
          control={
            field.nullable ? (
              <>
                {leaf}
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    aria-label={`${field.title}: none`}
                    checked={value === null}
                    onCheckedChange={(checked) => context.set(path, checked ? null : undefined)}
                  />
                  None
                </label>
              </>
            ) : (
              leaf
            )
          }
        />
      );
    }
  }
}

/** Fields marked advanced, folded until asked for (D82). */
function Advanced({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Advanced ({count})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
          {children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The rows of `fields` under `path`, advanced ones folded at the end. */
export function Fields({
  fields,
  path,
  context,
}: {
  fields: readonly Field[];
  path: readonly string[];
  context: FieldsContext;
}) {
  const row = (field: Field) => (
    <FieldRow context={context} field={field} key={field.key} path={[...path, field.key]} />
  );
  // A field that is set or wrong is never hidden.
  const quiet = (field: Field) =>
    getAt(context.value, [...path, field.key]) === undefined &&
    errorsAt(context, [...path, field.key], true).length === 0;
  const folded = (field: Field) => field.advanced && quiet(field);
  // The sibling's value in effect for the edited file (D481).
  // Inside a list the other file's items are other items (arrays are written
  // whole per file), so only the edited file counts there.
  const inList = path.some((_part, at) => Array.isArray(getAt(context.value, path.slice(0, at))));
  const inEffect = (key: string) => {
    const edited = getAt(context.value, [...path, key]);
    const other = inList ? undefined : getAt(context.other.value, [...path, key]);
    // `null` is a value of its own; only an absent key falls through.
    const [first, second] = context.other.layer === "project" ? [other, edited] : [edited, other];
    if (first !== undefined) return first;
    if (second !== undefined) return second;
    return fields.find((field) => field.key === key)?.default;
  };
  const visible = fields.filter((field) => isShown(field, inEffect) || !quiet(field));
  const advanced = visible.filter(folded);
  return (
    <>
      {visible.filter((field) => !folded(field)).map(row)}
      {advanced.length === 0 ? null : (
        <Advanced count={advanced.length}>{advanced.map(row)}</Advanced>
      )}
    </>
  );
}

/** The edited file's part of a whole section as JSON: the escape hatch (D80). */
export function SectionJson(props: {
  /** What the field is called, for screen readers. */
  label: string;
  /** The section's schema: the values it marks `writeOnly` show hidden (D83). */
  schema: JsonSchema;
  value: unknown;
  onChange(next: unknown): void;
  messages: readonly string[];
}) {
  const id = useId();
  return (
    <>
      <JsonControl
        describedBy={props.messages.length === 0 ? undefined : id}
        hide={(shown) => redact(props.schema, shown, props.schema)}
        invalid={props.messages.length > 0}
        label={props.label}
        onChange={(next) => props.onChange(next ?? {})}
        refuse={(next) =>
          typeof next === "object" && next !== null && !Array.isArray(next)
            ? undefined
            : "The section's values must be a JSON object"
        }
        rows={8}
        value={props.value}
      />
      <p className="mb-2 text-xs empty:hidden">
        <Errors id={id} messages={props.messages} />
      </p>
    </>
  );
}
