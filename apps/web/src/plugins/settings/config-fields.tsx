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
import { isRedactedSecret } from "@jhin/client-api";
import { ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import {
  equal,
  getAt,
  redact,
  restore,
  Unparsed,
  type Field,
  type JsonSchema,
  type Option,
} from "../../lib/config-form.ts";
import { SettingResetButton, SettingsRow } from "../../lib/settings-layout.tsx";

/** What every field of one section reads and changes. */
export interface FieldsContext {
  /** The node file's part of the section, as edited. */
  readonly value: unknown;
  /** The project file's part: it wins over the node file. */
  readonly project: unknown;
  /** Errors by path inside the section, joined with dots. */
  readonly errors: ReadonlyMap<string, readonly string[]>;
  /** The section's schema, for the references inside its fields' schemas. */
  readonly root: JsonSchema;
  /** Sets `path` in the node file's part; `undefined` removes the key. */
  set(path: readonly string[], next: unknown): void;
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
      return (
        <Select
          disabled={props.disabled}
          onValueChange={(next) => {
            const option = options.find((item) => optionKey(item.value) === next);
            if (option !== undefined) onChange(option.value);
          }}
          value={chosen === undefined ? "" : optionKey(chosen.value)}
        >
          <SelectTrigger {...aria} className={width} size="sm">
            <SelectValue>
              {chosen?.label ?? <span className="text-muted-foreground">Not set</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
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
      // A secret is typed, never shown (D83).
      return (
        <Input
          {...aria}
          autoComplete="off"
          className={width}
          disabled={props.disabled}
          nativeInput
          onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
          placeholder={
            field.secret && typeof value === "string" && value !== ""
              ? "Stored secret, enter a new value to replace"
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
  if (field.control.kind !== "list") return null;
  const item = field.control.item;
  const value = getAt(context.value, path);
  const items = Array.isArray(value) ? value : [];
  const blank = (): unknown =>
    item.control.kind === "switch"
      ? false
      : item.control.kind === "select"
        ? item.control.options[0]?.value
        : item.control.kind === "number"
          ? new Unparsed("", "Enter a number")
          : "";
  return (
    <div className="mt-2 mb-2 min-w-0 space-y-1.5">
      {items.map((_, index) => (
        // Items have no identity but their place; the list re-renders whole on removal.
        // oxlint-disable-next-line react/no-array-index-key
        <div className="flex min-w-0 items-start gap-1.5" key={index}>
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
          <span
            className="mt-1 w-40 shrink-0 truncate rounded-md bg-muted/60 px-2 py-0.5 font-mono text-xs leading-5"
            title={key}
          >
            {key}
          </span>
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
  const value = getAt(context.value, path);
  const set = value !== undefined;
  const reset = set ? (
    <SettingResetButton label={field.title} onClick={() => context.set(path, undefined)} />
  ) : undefined;
  const fromProject = getAt(context.project, path);
  const override =
    fromProject === undefined ? null : (
      <span className="block">
        The project file sets{" "}
        {field.secret ? (
          "it"
        ) : (
          <code>{brief(redact(field.schema, fromProject, context.root))}</code>
        )}
        , which wins.
      </span>
    );

  if (field.control.kind === "group") {
    const messages = errorsAt(context, path);
    return (
      <div aria-label={field.title} role="group">
        <div className="flex items-start gap-1.5 px-3 pt-3 pb-2 sm:px-4">
          <div className="min-w-0 flex-1 space-y-0.5">
            <h3 className="flex min-h-5 items-center gap-1.5 text-xs font-semibold tracking-wide text-foreground/80 uppercase">
              <FieldTitle field={field} />
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
    title: <FieldTitle field={field} />,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(status === undefined ? {} : { status }),
    ...(reset === undefined ? {} : { resetAction: reset }),
  };

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
          disabled={value === null}
          field={field}
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
  // An advanced field that is set or wrong is not hidden.
  const folded = (field: Field) =>
    field.advanced &&
    getAt(context.value, [...path, field.key]) === undefined &&
    errorsAt(context, [...path, field.key], true).length === 0;
  const advanced = fields.filter(folded);
  return (
    <>
      {fields.filter((field) => !folded(field)).map(row)}
      {advanced.length === 0 ? null : (
        <Advanced count={advanced.length}>{advanced.map(row)}</Advanced>
      )}
    </>
  );
}

/** The node file's part of a whole section as JSON: the escape hatch (D80). */
export function SectionJson(props: {
  section: string;
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
        label={`${props.section} in the node file`}
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
