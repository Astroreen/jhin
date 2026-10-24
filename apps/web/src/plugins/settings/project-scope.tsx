// The project scope of the settings page follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/SettingsScopeSentence.tsx (the scope sentence and its menu),
// SettingInheritance.tsx (settingInheritanceLayers and its popover) and settingsLayout.tsx
// (a project-scoped row's reset, an environment-wide row made inert).
import {
  Button,
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  InlineButton,
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { equal, getAt, type Field, type JsonSchema } from "../../lib/config-form.ts";

/** The key and the JSON Schema keyword of a section's project settings (config-ui.md D1462). */
export const PROJECT_SETTINGS_KEY = "projects";
const PROJECT_SETTINGS_META = "projectSettings";
/** A project setting's keyword naming the `t3.json` field that backs it (D1463, D1467). */
const T3_FILE_META = "t3File";
const ALL_PROJECTS = "";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ScopeProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** The schema of one project's entry, when the section keeps settings per project. */
export function projectEntrySchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  const record = isObject(schema?.["properties"])
    ? (schema["properties"] as Record<string, unknown>)[PROJECT_SETTINGS_KEY]
    : undefined;
  if (!isObject(record) || record[PROJECT_SETTINGS_META] !== true) return undefined;
  const entry = record["additionalProperties"];
  return isObject(entry) && isObject(entry["properties"]) ? entry : undefined;
}

/** The keys a project's entry may set. */
export const projectKeys = (entry: JsonSchema): readonly string[] =>
  Object.keys(entry["properties"] as Record<string, unknown>);

/** The `t3.json` field each project key is backed by. */
export function t3FileFields(entry: JsonSchema): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(entry["properties"] as Record<string, unknown>).flatMap(([key, value]) =>
      isObject(value) && typeof value[T3_FILE_META] === "string"
        ? [[key, value[T3_FILE_META] as string] as const]
        : [],
    ),
  );
}

/**
 * The form of a project's entry: its keys, each with the value it inherits as
 * its default, so a field shows what applies while the project sets nothing
 * and a `when` clause reads it (D481).
 */
export function projectFormSchema(
  section: JsonSchema,
  entry: JsonSchema,
  inherited: (key: string) => unknown,
): JsonSchema {
  const properties = Object.fromEntries(
    Object.entries(entry["properties"] as Record<string, unknown>).map(([key, value]) => {
      const inherits = inherited(key);
      const property = isObject(value) ? value : {};
      return [key, inherits === undefined ? property : { ...property, default: inherits }];
    }),
  );
  return {
    ...entry,
    properties,
    ...(section["$defs"] === undefined ? {} : { $defs: section["$defs"] }),
    ...(section["title"] === undefined ? {} : { title: section["title"] }),
    ...(section["description"] === undefined ? {} : { description: section["description"] }),
  };
}

/** One layer a project setting's value can come from (T3's `InheritanceLayer`). */
export interface InheritanceLayer {
  readonly key: "project" | "node" | "t3.json" | "default";
  readonly label: string;
  readonly value: string;
  /** The layer whose value is in effect. */
  readonly effective: boolean;
  readonly set: boolean;
}

/** A value as the layers popover shows it (T3's `formatValue`). */
function formatValue(field: Field | undefined, value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (field?.control.kind === "select") {
    const option = field.control.options.find((candidate) => equal(candidate.value, value));
    if (option !== undefined) return option.label;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number") return String(value);
  return "Custom";
}

/**
 * T3's `settingInheritanceLayers`, in `resolveProjectSettings`'s order:
 * the project, the node, the `t3.json` for a key it backs, the default.
 */
export function inheritanceLayers(input: {
  readonly field: Field | undefined;
  readonly nodeLabel: string;
  readonly project: unknown;
  readonly node: unknown;
  readonly t3File?: { readonly value: unknown } | undefined;
  readonly fallback: unknown;
}): readonly InheritanceLayer[] {
  const { field, project, node, t3File, fallback } = input;
  const source =
    project !== undefined
      ? "project"
      : node !== undefined
        ? "node"
        : t3File?.value !== undefined
          ? "t3.json"
          : "default";
  return [
    {
      key: "project",
      label: "Project",
      value: project === undefined ? "Inherits" : formatValue(field, project),
      effective: source === "project",
      set: project !== undefined,
    },
    {
      key: "node",
      label: input.nodeLabel,
      value: node === undefined ? "Inherits" : formatValue(field, node),
      effective: source === "node",
      set: node !== undefined,
    },
    ...(t3File === undefined
      ? []
      : [
          {
            key: "t3.json" as const,
            label: "t3.json",
            value: t3File.value === undefined ? "Inherits" : formatValue(field, t3File.value),
            effective: source === "t3.json",
            set: t3File.value !== undefined,
          },
        ]),
    {
      key: "default",
      label: "Default",
      value: formatValue(field, fallback),
      effective: source === "default",
      set: true,
    },
  ];
}

/** T3's layers button: where a project setting's value comes from. */
export function InheritanceButton(props: {
  readonly title: string;
  readonly summary: string;
  readonly layers?: readonly InheritanceLayer[];
  readonly overridden?: boolean;
}) {
  const icon = (
    <LayersIcon aria-hidden className={cn("size-3", props.overridden === true && "text-primary")} />
  );
  if (props.layers === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`${props.title}: ${props.summary}`}
              size="icon-micro"
              variant="ghost-muted"
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.summary}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`${props.title}: ${props.summary}. Show where this value comes from`}
            size="icon-micro"
            variant="ghost-muted"
          />
        }
      >
        {icon}
      </PopoverTrigger>
      <PopoverPopup align="start">
        <ol aria-label={`Where ${props.title} comes from`} className="w-64 text-sm">
          {props.layers.map((layer) => (
            <li
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                layer.effective && "bg-foreground/[0.06]",
              )}
              key={layer.key}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {layer.label}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 tabular-nums",
                  layer.effective
                    ? "text-foreground"
                    : layer.set
                      ? "text-muted-foreground"
                      : "text-muted-foreground/60",
                )}
              >
                <span className="max-w-32 truncate">{layer.value}</span>
                {layer.effective ? (
                  <CheckIcon aria-label="In effect" className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0" />
                )}
              </span>
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}

/** How many projects set `key` in their entry. */
export function overridesOf(file: unknown, key: string): number {
  const entries = getAt(file, [PROJECT_SETTINGS_KEY]);
  if (!isObject(entries)) return 0;
  return Object.values(entries).filter((entry) => isObject(entry) && entry[key] !== undefined)
    .length;
}

interface ScopeOption {
  readonly value: string;
  readonly label: string;
  readonly secondary?: string;
}

/**
 * T3's scope sentence: "Applying settings for [All projects ▾]", a menu of
 * the node's projects, with a search once there are more than six.
 */
export function ProjectScopeSentence(props: {
  readonly projects: readonly ScopeProject[];
  readonly value: string | undefined;
  readonly onChange: (projectId: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const options: ScopeOption[] = props.projects.map((project) => ({
    value: project.id,
    label: project.name,
    // Two projects of one name tell apart by their folder (T3's secondary line).
    ...(props.projects.some((other) => other.id !== project.id && other.name === project.name)
      ? { secondary: project.path }
      : {}),
  }));
  const all: ScopeOption = { value: ALL_PROJECTS, label: "All projects" };
  const choices = [all, ...options];
  const value = props.value ?? ALL_PROJECTS;
  const selected = choices.find((option) => option.value === value);
  const label = selected?.label ?? "Unavailable project";
  const choose = (next: string) => props.onChange(next === ALL_PROJECTS ? undefined : next);
  const triggerClass = "min-w-0 max-w-72";
  const triggerContent = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </>
  );
  const optionLabel = (option: ScopeOption) => (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{option.label}</span>
      {option.secondary === undefined ? null : (
        <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
      )}
    </span>
  );
  const menu =
    options.length > 6 ? (
      <Combobox
        autoHighlight
        filter={null}
        filteredItems={choices.filter((option) =>
          `${option.label} ${option.secondary ?? ""} ${option.value}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )}
        isItemEqualToValue={(a: ScopeOption, b: ScopeOption) => a.value === b.value}
        itemToStringLabel={(option: ScopeOption) => option.label}
        items={choices}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option: ScopeOption | null) => {
          if (option !== null) choose(option.value);
        }}
        value={selected ?? null}
      >
        <ComboboxTrigger
          aria-label={`Project scope: ${label}`}
          className={triggerClass}
          render={<InlineButton tone="picker" />}
        >
          {triggerContent}
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label="Search projects"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            value={query}
          />
          <ComboboxEmpty>No matches found.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                {optionLabel(option)}
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    ) : (
      <Menu>
        <MenuTrigger
          aria-label={`Project scope: ${label}`}
          className={triggerClass}
          render={<InlineButton tone="picker" />}
        >
          {triggerContent}
        </MenuTrigger>
        <MenuPopup align="start">
          <div className="w-72 max-w-full">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (typeof next === "string") choose(next);
              }}
              value={value}
            >
              {choices.map((option, index) => (
                <Fragment key={option.value === ALL_PROJECTS ? "all" : option.value}>
                  <MenuRadioItem closeOnClick value={option.value}>
                    <span className="flex min-w-0 items-center gap-2">
                      {optionLabel(option)}
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                  {index === 0 ? <MenuSeparator /> : null}
                </Fragment>
              ))}
            </MenuRadioGroup>
          </div>
        </MenuPopup>
      </Menu>
    );
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 pt-3 text-base text-muted-foreground sm:px-4">
      <span className="shrink-0">Applying settings for</span>
      {menu}
    </p>
  );
}
