// Editing the intent chain from the mission view (docs/plans/agents.md, C2:
// D1081–D1085): dialogs that call `missions.*` and `slices.*` and nothing else.
// The view shows what the stream says afterwards; a dialog never writes the fold.
import { ownerAddress } from "@jhin/agent-api";
import {
  MISSION_STATUSES,
  type Mission,
  type MissionStatus,
  type ProjectIntent,
  type Slice,
  type SliceStatus,
} from "@jhin/missions-api";
import {
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@jhin/ui";
import { useId, useState, type ReactNode } from "react";

import type { Directory } from "./directory.ts";
import { DirectoryNotices } from "./notice.tsx";
import { intentChanges, missionChanges, sliceChanges, sliceStatusOptions } from "./changes.ts";
import { assigneeLabel, formatSteps, parseSteps, STATUS_LABELS } from "./route.ts";

/** Runs a command on the view's node and returns its output. */
export type Call = <T = unknown>(method: string, input: unknown) => Promise<T>;

const NONE = "none";

/** A form in a dialog: submits once at a time and shows the command's error (D1083). */
function EditDialog(props: {
  title: string;
  description: string;
  submitLabel: string;
  onClose: () => void;
  submit: () => Promise<void>;
  children: ReactNode;
}) {
  const { title, description, submitLabel, onClose, submit, children } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      open
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(undefined);
            submit().then(
              () => {
                setPending(false);
                onClose();
              },
              (failure: unknown) => {
                setPending(false);
                setError(failure instanceof Error ? failure.message : String(failure));
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">{children}</div>
            {error === undefined ? null : (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: { label: string; id: string; hint?: string; children: ReactNode }) {
  return (
    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={props.id}>
      {props.label}
      {props.children}
      {props.hint === undefined ? null : (
        <span className="text-xs font-normal text-muted-foreground">{props.hint}</span>
      )}
    </Label>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  required?: boolean;
  multiline?: boolean;
  type?: "text" | "number";
}) {
  const id = useId();
  return (
    <Field id={id} label={props.label} {...(props.hint === undefined ? {} : { hint: props.hint })}>
      {props.multiline === true ? (
        <Textarea
          id={id}
          onChange={(event) => props.onChange(event.target.value)}
          required={props.required}
          rows={4}
          value={props.value}
        />
      ) : (
        <Input
          className="h-9 sm:h-8"
          id={id}
          min={props.type === "number" ? 1 : undefined}
          nativeInput
          step={props.type === "number" ? 1 : undefined}
          onChange={(event) => props.onChange(event.target.value)}
          required={props.required}
          type={props.type ?? "text"}
          value={props.value}
        />
      )}
    </Field>
  );
}

function SelectField<V extends string>(props: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  const id = useId();
  const items = Object.fromEntries(props.options.map((option) => [option.value, option.label]));
  return (
    <Field id={id} label={props.label}>
      <Select
        items={items}
        onValueChange={(value) => props.onChange(value as V)}
        value={props.value}
      >
        <SelectTrigger aria-label={props.label} className="min-w-0" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

const STEPS_HINT = "Step ids in order, e.g. spec → build → test.";

/** The project's intent and its process between missions (`missions.intent.set`, D643). */
export function IntentDialog(props: {
  projectId: string;
  project: string;
  intent: ProjectIntent | undefined;
  call: Call;
  onClose: () => void;
}) {
  const { projectId, project, intent, call, onClose } = props;
  const [text, setText] = useState(intent?.intent ?? "");
  const [process, setProcess] = useState(formatSteps(intent?.process ?? []));
  return (
    <EditDialog
      description={`What ${project} is for, in one paragraph; every mission serves it.`}
      onClose={onClose}
      submit={async () => {
        const changes = intentChanges(intent, { intent: text, process });
        if (Object.keys(changes).length > 0) {
          await call("missions.intent.set", { projectId, ...changes });
        }
      }}
      submitLabel="Save intent"
      title="Project intent"
    >
      <TextField label="Intent" multiline onChange={setText} value={text} />
      <TextField
        hint={STEPS_HINT}
        label="Process between missions"
        onChange={setProcess}
        value={process}
      />
    </EditDialog>
  );
}

/** Plans a mission (`missions.create`) or changes one (`missions.update`, only what changed). */
export function MissionDialog(props: {
  mission?: Mission;
  projects: readonly { id: string; name: string }[];
  projectId?: string;
  call: Call;
  onClose: () => void;
  onCreated?: (mission: Mission) => void;
}) {
  const { mission, projects, call, onClose, onCreated } = props;
  const [projectId, setProjectId] = useState(
    mission?.projectId ?? props.projectId ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(mission?.title ?? "");
  const [outcome, setOutcome] = useState(mission?.outcome ?? "");
  const [status, setStatus] = useState<MissionStatus>(mission?.status ?? "planned");
  const [sliceProcess, setSliceProcess] = useState(
    mission === undefined ? "spec → build → test" : formatSteps(mission.process.slice),
  );
  const [missionProcess, setMissionProcess] = useState(
    mission === undefined ? "merge" : formatSteps(mission.process.mission),
  );
  return (
    <EditDialog
      description={
        mission === undefined
          ? "A mission is an outcome the team works toward, slice by slice."
          : "Changes go to the mission through missions.update."
      }
      onClose={onClose}
      submit={async () => {
        const process = {
          slice: parseSteps(sliceProcess, mission?.process.slice),
          mission: parseSteps(missionProcess, mission?.process.mission),
        };
        if (mission === undefined) {
          const created = await call<Mission>("missions.create", {
            projectId,
            title,
            outcome,
            status,
            process,
          });
          onCreated?.(created);
          return;
        }
        const changes = missionChanges(mission, {
          title,
          outcome,
          status,
          sliceProcess,
          missionProcess,
        });
        if (Object.keys(changes).length > 0) {
          await call("missions.update", { missionId: mission.id, ...changes });
        }
      }}
      submitLabel={mission === undefined ? "Create mission" : "Save mission"}
      title={mission === undefined ? "New mission" : "Edit mission"}
    >
      {mission === undefined ? (
        <SelectField
          label="Project"
          onChange={setProjectId}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          value={projectId}
        />
      ) : null}
      <TextField label="Title" onChange={setTitle} required value={title} />
      <TextField
        hint="What holds when the mission is done."
        label="Outcome"
        multiline
        onChange={setOutcome}
        value={outcome}
      />
      <SelectField
        label="Status"
        onChange={setStatus}
        options={MISSION_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
        value={status}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          hint={STEPS_HINT}
          label="Slice process"
          onChange={setSliceProcess}
          value={sliceProcess}
        />
        <TextField
          hint="Between the mission's waves, e.g. merge."
          label="Mission process"
          onChange={setMissionProcess}
          value={missionProcess}
        />
      </div>
    </EditDialog>
  );
}

/** Who a slice can go to: nobody, the node's owner, or one of its agents; the current one stays. */
function assigneeOptions(directory: Directory, current: string | undefined) {
  const options: { value: string; label: string }[] = [{ value: NONE, label: "Unassigned" }];
  if (directory.nodeId !== undefined) {
    options.push({ value: ownerAddress(directory.nodeId), label: "Owner" });
  }
  for (const agent of directory.agents) {
    options.push({ value: agent.address, label: agent.title });
  }
  if (current !== undefined && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: assigneeLabel(current, directory.titles) });
  }
  return options;
}

/**
 * Adds a slice (`slices.create`) or changes one (`slices.update`, only what
 * changed). Done is reached with a proof (D646), so it is offered only to a
 * slice that is done already; the order rules are the command's (D644).
 */
export function SliceDialog(props: {
  mission: Mission;
  slice?: Slice;
  slices: readonly Slice[];
  directory: Directory;
  call: Call;
  onClose: () => void;
  onCreated?: (slice: Slice) => void;
}) {
  const { mission, slice, slices, directory, call, onClose, onCreated } = props;
  const [title, setTitle] = useState(slice?.title ?? "");
  const [spec, setSpec] = useState(slice?.spec ?? "");
  const [assignee, setAssignee] = useState(slice?.assignee ?? NONE);
  const [wave, setWave] = useState(slice === undefined ? "" : String(slice.wave));
  const [dependsOn, setDependsOn] = useState<readonly string[]>(slice?.dependsOn ?? []);
  const [status, setStatus] = useState<SliceStatus>(slice?.status ?? "planned");
  const [step, setStep] = useState(slice?.step ?? NONE);
  const others = slices.filter(
    (other) =>
      other.id !== slice?.id && (other.status !== "dropped" || dependsOn.includes(other.id)),
  );
  const statuses = sliceStatusOptions(slice);
  const dependsId = useId();
  return (
    <EditDialog
      description={
        slice === undefined
          ? `A slice of ${mission.title}: one change with a spec of what must work.`
          : "Changes go to the slice through slices.update."
      }
      onClose={onClose}
      submit={async () => {
        const waveNumber = wave.trim() === "" ? undefined : Number(wave);
        if (slice === undefined) {
          const created = await call<Slice>("slices.create", {
            missionId: mission.id,
            title,
            spec,
            dependsOn,
            status,
            ...(assignee === NONE ? {} : { assignee }),
            ...(waveNumber === undefined ? {} : { wave: waveNumber }),
          });
          onCreated?.(created);
          return;
        }
        // The wave is required when editing: an emptied field never saves silently.
        const changes = sliceChanges(slice, {
          title,
          spec,
          assignee: assignee === NONE ? undefined : assignee,
          wave: waveNumber ?? slice.wave,
          dependsOn,
          status,
          step: step === NONE ? undefined : step,
        });
        if (Object.keys(changes).length > 0) {
          await call("slices.update", { sliceId: slice.id, ...changes });
        }
      }}
      submitLabel={slice === undefined ? "Add slice" : "Save slice"}
      title={slice === undefined ? "New slice" : "Edit slice"}
    >
      <TextField label="Title" onChange={setTitle} required value={title} />
      <TextField
        hint="What must work when the slice is done."
        label="Spec"
        multiline
        onChange={setSpec}
        value={spec}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          label="Assignee"
          onChange={setAssignee}
          options={assigneeOptions(directory, slice?.assignee)}
          value={assignee}
        />
        <SelectField
          label="Status"
          onChange={setStatus}
          options={statuses.map((value) => ({
            value,
            // Dropped is final (D651): the option says so before it is saved.
            label: value === "dropped" ? "Dropped (final)" : STATUS_LABELS[value],
          }))}
          value={status}
        />
        <TextField
          hint={slice === undefined ? "Empty: the wave after its dependencies." : undefined}
          label="Wave"
          onChange={setWave}
          required={slice !== undefined}
          type="number"
          value={wave}
        />
        {slice === undefined ? null : (
          <SelectField
            label="Step"
            onChange={setStep}
            options={[
              { value: NONE, label: "None" },
              ...mission.process.slice.map((item) => ({ value: item.id, label: item.id })),
              // A step the process no longer has still shows (D648 refuses it on save).
              ...(slice.step === undefined ||
              mission.process.slice.some((item) => item.id === slice.step)
                ? []
                : [{ value: slice.step, label: slice.step }]),
            ]}
            value={step}
          />
        )}
      </div>
      <DirectoryNotices notices={directory.notices} />
      {others.length === 0 ? null : (
        <fieldset aria-labelledby={dependsId} className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium" id={dependsId}>
            Depends on
          </legend>
          {others.map((other) => (
            <Label className="flex items-center gap-2 font-normal" key={other.id}>
              <Checkbox
                aria-label={other.title}
                checked={dependsOn.includes(other.id)}
                onCheckedChange={(checked) =>
                  setDependsOn((current) =>
                    checked ? [...current, other.id] : current.filter((id) => id !== other.id),
                  )
                }
              />
              <span className="truncate">{other.title}</span>
              <span className="text-xs text-muted-foreground">wave {other.wave}</span>
            </Label>
          ))}
        </fieldset>
      )}
    </EditDialog>
  );
}
