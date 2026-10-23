// The mission view in Civilization mode (docs/plans/agents.md, A3: D653–D656),
// a chunk of its own (D440): loaded once the Missions section or a mission shows.
import {
  THREAD_TRANSCRIPT_SLOT,
  targetKey,
  type Connections,
  type MeshMembership,
  type Navigation,
  type NodeTarget,
  type Route,
  type ThreadsCatalog,
  type ThreadTranscriptProps,
} from "@jhin/client-api";
import {
  missionsOf,
  slicesOf,
  wavesOf,
  type Mission,
  type MissionStatus,
  type MissionsState,
  type ProjectIntent,
  type ReviewCheck,
  type ProofItem,
  type Slice,
  type SliceStatus,
  type SliceThread,
} from "@jhin/missions-api";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  Slot,
  Spinner,
  useSlot,
} from "@jhin/ui";
import {
  BadgeCheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  TargetIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { useDirectory, type Directory } from "./directory.ts";
import { DirectoryNotices } from "./notice.tsx";
import { IntentDialog, MissionDialog, SliceDialog, type Call } from "./edit.tsx";
import {
  assigneeLabel,
  MISSION_ASIDE_SLOT,
  missionRank,
  placeOf,
  reviewCheckFailed,
  reviewCheckLines,
  routeOf,
  sameThread,
  STATUS_LABELS,
  statusVariant,
  threadTarget,
  VERDICT_LABELS,
  type ReviewCheckView,
  type MissionAsideProps,
  type MissionPlace,
} from "./route.ts";
import type { MissionsStore, MissionsView } from "./store.ts";

/** What the mission view's components use of the plugin that shows them. */
export interface MissionsServices {
  readonly navigation: Navigation;
  readonly connections: Connections;
  readonly threads: ThreadsCatalog;
  readonly mesh: MeshMembership | undefined;
  readonly store: MissionsStore;
}

/** The route's connection, or the first open one when the route names none. */
function useConnection(services: MissionsServices, route: Route): string | undefined {
  const { connections } = services;
  const nodes = useExternal(connections, connections.list);
  return (
    route.node ?? nodes.find((node) => node.state === "open")?.id ?? nodes.at(0)?.id ?? undefined
  );
}

const NO_VIEW: MissionsView = {
  status: "loading",
  state: { intents: {}, missions: {}, slices: {} },
};

function useMissions(store: MissionsStore, connection: string | undefined): MissionsView {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      if (connection === undefined) return () => undefined;
      const subscription = store.subscribe(connection, listener);
      return () => subscription.dispose();
    },
    [store, connection],
  );
  return useSyncExternalStore(subscribe, () =>
    connection === undefined ? NO_VIEW : store.view(connection),
  );
}

/** The connected node's own id in its mesh, to tell its threads from members' (D647). */
function useSelfNode(mesh: MeshMembership | undefined, connection: string | undefined) {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      if (mesh === undefined || connection === undefined) return () => undefined;
      const subscription = mesh.subscribe(connection, listener);
      return () => subscription.dispose();
    },
    [mesh, connection],
  );
  return useSyncExternalStore(subscribe, () =>
    connection === undefined
      ? undefined
      : mesh?.members(connection)?.find((member) => member.self)?.nodeId,
  );
}

/** Project names from the node's catalog; a project it does not list shows its id. */
function useProjectNames(threads: ThreadsCatalog, connection: string | undefined) {
  const catalog = useCatalog(threads, connection === undefined ? undefined : { node: connection });
  return useMemo(
    () => new Map((catalog?.projects ?? []).map((project) => [project.id, project.name])),
    [catalog],
  );
}

function StatusBadge({ status }: { status: MissionStatus | SliceStatus }) {
  return (
    <Badge data-status={status} size="sm" variant={statusVariant(status)}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const DOT: Readonly<Record<MissionStatus, string>> = {
  active: "bg-info",
  planned: "bg-muted-foreground/40",
  done: "bg-success",
  dropped: "bg-transparent border border-muted-foreground/40",
};

// --- The Missions section of the sidebar (D654) -----------------------------------

function SidebarNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{children}</p>;
}

export function MissionsSidebar({ services }: { services: MissionsServices }) {
  const { navigation, store, threads } = services;
  const route = useExternal(navigation, navigation.current);
  const connection = useConnection(services, route);
  const view = useMissions(store, connection);
  const names = useProjectNames(threads, connection);
  const place = placeOf(route);
  const shownMission =
    place?.kind === "mission"
      ? place.missionId
      : place?.kind === "slice"
        ? view.state.slices[place.sliceId]?.missionId
        : undefined;
  const shownProject =
    shownMission === undefined ? undefined : view.state.missions[shownMission]?.projectId;

  const [creating, setCreating] = useState(false);

  if (view.status === "unavailable") return <SidebarNote>This node has no missions.</SidebarNote>;
  if (view.status === "loading") return <SidebarNote>Loading missions…</SidebarNote>;
  const projects = projectsWithMissions(view.state);
  // Planning a mission from the client (D1081): any project of the node's catalog.
  const create =
    connection === undefined ? null : (
      <>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-sidebar-muted-foreground"
              disabled={names.size === 0}
              onClick={() => setCreating(true)}
              size="sm"
            >
              <PlusIcon aria-hidden className="size-3.5" />
              <span>New mission</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {creating ? (
          <MissionDialog
            call={(method, input) => threads.call({ node: connection }, method, input)}
            onClose={() => setCreating(false)}
            onCreated={(mission) =>
              navigation.navigate(routeOf(route, { kind: "mission", missionId: mission.id }))
            }
            projects={[...names].map(([id, name]) => ({ id, name }))}
            {...(shownProject === undefined ? {} : { projectId: shownProject })}
          />
        ) : null}
      </>
    );
  if (projects.length === 0) {
    return (
      <>
        <SidebarNote>
          {view.status === "error"
            ? `Couldn't load missions: ${view.error ?? "unknown error"}`
            : "No missions yet."}
        </SidebarNote>
        {create}
      </>
    );
  }
  return (
    <nav aria-label="Missions list">
      {projects.map(({ projectId, missions }) => (
        <div key={projectId} data-mission-project={projectId}>
          {projects.length > 1 || names.has(projectId) ? (
            <div className="truncate px-2 pt-1 text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground/70">
              {names.get(projectId) ?? projectId}
            </div>
          ) : null}
          <SidebarMenu>
            {missions.map((mission) => (
              <SidebarMenuItem key={mission.id}>
                <SidebarMenuButton
                  aria-label={`${mission.title}, ${STATUS_LABELS[mission.status]}`}
                  className={
                    mission.status === "dropped"
                      ? "text-sidebar-muted-foreground line-through"
                      : undefined
                  }
                  data-mission={mission.id}
                  isActive={shownMission === mission.id}
                  onClick={() =>
                    navigation.navigate(routeOf(route, { kind: "mission", missionId: mission.id }))
                  }
                  size="sm"
                >
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${DOT[mission.status]}`}
                  />
                  <span className="truncate">{mission.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>
      ))}
      {create}
    </nav>
  );
}

/** Projects with missions, each with its missions open first; projects by their first mission. */
function projectsWithMissions(state: MissionsState) {
  const projects = new Set(Object.values(state.missions).map((mission) => mission.projectId));
  return [...projects]
    .map((projectId) => ({
      projectId,
      missions: missionsOf(state, projectId).toSorted(
        (a, b) => missionRank(a.status) - missionRank(b.status),
      ),
    }))
    .toSorted((a, b) =>
      (a.missions[0]?.createdAt ?? "").localeCompare(b.missions[0]?.createdAt ?? ""),
    );
}

// --- The view in `civilization.views` (D653, D655, D656) ---------------------------

function PageEmpty({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TargetIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

interface Crumb {
  readonly label: string;
  readonly place?: MissionPlace;
}

function Header({
  route,
  crumbs,
  navigation,
}: {
  route: Route;
  crumbs: readonly Crumb[];
  navigation: Navigation;
}) {
  return (
    <header className="drag-region flex h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 border-b border-border pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) wco:pr-(--workspace-native-controls-inset) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${index}:${crumb.label}`}>
              {index > 0 ? (
                <ChevronRightIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                />
              ) : null}
              {crumb.place === undefined || last ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={`truncate ${last ? "font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  {crumb.label}
                </span>
              ) : (
                <button
                  className="no-drag truncate text-muted-foreground hover:text-foreground"
                  onClick={() => crumb.place && navigation.navigate(routeOf(route, crumb.place))}
                  type="button"
                >
                  {crumb.label}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
    </header>
  );
}

function Section({
  title,
  children,
  label,
  action,
}: {
  title: string;
  children: ReactNode;
  label?: string;
  action?: ReactNode;
}) {
  return (
    <section aria-label={label ?? title} className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The user's text as written: an intent, outcome or spec keeps its lines (D649 renders it as Markdown). */
function Prose({ text, empty }: { text: string; empty: string }) {
  return text.trim() === "" ? (
    <p className="text-sm text-muted-foreground">{empty}</p>
  ) : (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
      {text}
    </p>
  );
}

function Steps({
  steps,
  current,
}: {
  steps: readonly { id: string }[];
  current?: string | undefined;
}) {
  if (steps.length === 0) return <span className="text-xs text-muted-foreground">none</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {steps.map((step, index) => (
        <Fragment key={step.id}>
          {index > 0 ? (
            <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground/60" />
          ) : null}
          <Badge
            aria-current={current === step.id ? "step" : undefined}
            size="sm"
            variant={current === step.id ? "info" : "outline"}
          >
            {step.id}
          </Badge>
        </Fragment>
      ))}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function MissionsMain({ services }: { services: MissionsServices }) {
  const { navigation, store, threads, mesh } = services;
  const route = useExternal(navigation, navigation.current);
  const place = placeOf(route);
  const connection = useConnection(services, route);
  const view = useMissions(store, place === undefined ? undefined : connection);
  const names = useProjectNames(threads, place === undefined ? undefined : connection);
  const self = useSelfNode(mesh, place === undefined ? undefined : connection);
  const shownThread =
    place?.kind === "slice" && place.thread !== undefined && connection !== undefined
      ? {
          target: threadTarget({ node: connection }, place.thread, self),
          threadId: place.thread.threadId,
        }
      : undefined;
  const threadTitle = useThreadTitle(threads, shownThread?.target, shownThread?.threadId);
  const directory = useDirectory(
    threads,
    place === undefined || connection === undefined ? undefined : { node: connection },
  );
  // Another contribution's panel (an agent's page): this view shows nothing.
  if (place === undefined) return null;
  if (connection === undefined) return null;

  const body = (() => {
    if (view.status === "loading") {
      return (
        <div className="flex flex-1 justify-center py-24">
          <Spinner tone="muted" />
        </div>
      );
    }
    if (view.status === "unavailable") {
      return (
        <PageEmpty
          text="This node has no missions, or this client may not read them."
          title="No missions here"
        />
      );
    }
    return undefined;
  })();
  const { state } = view;
  const slice = place.kind === "slice" ? state.slices[place.sliceId] : undefined;
  const mission =
    state.missions[place.kind === "mission" ? place.missionId : (slice?.missionId ?? "")];
  const project =
    mission === undefined ? undefined : (names.get(mission.projectId) ?? mission.projectId);
  const crumbs: Crumb[] = [];
  if (project !== undefined) crumbs.push({ label: project });
  if (mission !== undefined)
    crumbs.push({ label: mission.title, place: { kind: "mission", missionId: mission.id } });
  if (slice !== undefined)
    crumbs.push({ label: slice.title, place: { kind: "slice", sliceId: slice.id } });
  if (place.kind === "slice" && place.thread !== undefined)
    crumbs.push({ label: threadTitle ?? "Thread" });
  if (crumbs.length === 0) crumbs.push({ label: "Missions" });

  const target: NodeTarget = { node: connection };
  const call: Call = (method, input) => threads.call(target, method, input);
  const content =
    body ??
    (mission === undefined ? (
      <PageEmpty
        text={
          view.status === "error"
            ? `Couldn't load missions: ${view.error ?? "unknown error"}`
            : "No mission or slice has this id on this node."
        }
        title="Not found"
      />
    ) : place.kind === "mission" ? (
      <MissionPage
        call={call}
        directory={directory}
        target={target}
        intent={state.intents[mission.projectId]}
        mission={mission}
        project={project ?? mission.projectId}
        open={(next) => navigation.navigate(routeOf(route, next))}
        slices={slicesOf(state, mission.id)}
      />
    ) : slice === undefined ? null : place.thread === undefined ? (
      <SlicePage
        call={call}
        directory={directory}
        mission={mission}
        open={(next) => navigation.navigate(routeOf(route, next))}
        services={services}
        slice={slice}
        state={state}
        target={target}
      />
    ) : (
      <ThreadPage slice={slice} target={shownThread?.target ?? target} thread={place.thread} />
    ));

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-mission-view={
        place.kind === "mission" ? "mission" : place.thread === undefined ? "slice" : "thread"
      }
    >
      <Header crumbs={crumbs} navigation={navigation} route={route} />
      {content}
    </div>
  );
}

/** A small action beside a heading, named for what it edits (D1083). */
function EditButton(props: { label: string; onClick: () => void; add?: boolean }) {
  const Icon = props.add === true ? PlusIcon : PencilIcon;
  return (
    <Button onClick={props.onClick} size="compact" type="button" variant="ghost-muted">
      <Icon aria-hidden />
      {props.label}
    </Button>
  );
}

function MissionPage(props: {
  target: NodeTarget;
  mission: Mission;
  project: string;
  intent: ProjectIntent | undefined;
  slices: readonly Slice[];
  directory: Directory;
  call: Call;
  open: (place: MissionPlace) => void;
}) {
  const { target, mission, project, intent, slices, directory, call, open } = props;
  const aside = useSlot(MISSION_ASIDE_SLOT).length > 0;
  const [editing, setEditing] = useState<"intent" | "mission" | "slice" | undefined>();
  const close = () => setEditing(undefined);
  const waves = wavesOf(slices);
  const closed = mission.status === "done" || mission.status === "dropped";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={`mx-auto flex w-full flex-col gap-6 px-4 py-6 xl:flex-row-reverse xl:items-start ${aside ? "max-w-[calc(var(--chat-content-max-width)+20rem)]" : "max-w-(--chat-content-max-width)"}`}
      >
        {/* Beside the mission (D1087): the orchestrator, and any other contribution. */}
        {aside ? (
          <div className="flex shrink-0 flex-col gap-3 xl:sticky xl:top-0 xl:w-72">
            <Slot<MissionAsideProps>
              name={MISSION_ASIDE_SLOT}
              props={{
                target,
                mission,
                slices,
                nodeId: directory.nodeId,
                titles: directory.titles,
              }}
            />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <Section
            action={<EditButton label="Edit intent" onClick={() => setEditing("intent")} />}
            label="Project intent"
            title="Intent"
          >
            <Prose empty="No intent yet." text={intent?.intent ?? ""} />
          </Section>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                {mission.title}
              </h1>
              <StatusBadge status={mission.status} />
              <span className="ms-auto">
                <EditButton label="Edit mission" onClick={() => setEditing("mission")} />
              </span>
            </div>
            <Section title="Outcome">
              <Prose empty="No outcome yet." text={mission.outcome} />
            </Section>
          </div>
          <DirectoryNotices notices={directory.notices} />
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Fact label="Slice process">
              <Steps steps={mission.process.slice} />
            </Fact>
            <Fact label="Mission process">
              <Steps current={mission.step} steps={mission.process.mission} />
            </Fact>
          </dl>
          <ReviewCheckSection call={call} mission={mission} slices={slices} />
          <Section
            action={
              closed ? undefined : (
                <EditButton add label="Add slice" onClick={() => setEditing("slice")} />
              )
            }
            title="Waves"
          >
            {waves.length === 0 ? (
              <p className="text-sm text-muted-foreground">No slices yet.</p>
            ) : (
              <ol className="flex flex-col gap-4">
                {waves.map(({ wave, slices: members }) => (
                  <li key={wave}>
                    <section aria-label={`Wave ${wave}`} className="flex flex-col gap-1.5">
                      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        Wave {wave}
                        <span className="text-muted-foreground/60">
                          {members.filter((slice) => slice.status === "done").length}/
                          {members.length} done
                        </span>
                      </h3>
                      <ul className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
                        {members.map((slice) => (
                          <li className="border-b border-border/40 last:border-b-0" key={slice.id}>
                            <SliceRow
                              onOpen={() => open({ kind: "slice", sliceId: slice.id })}
                              slice={slice}
                              titles={directory.titles}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
      {editing === "intent" ? (
        <IntentDialog
          call={call}
          intent={intent}
          onClose={close}
          project={project}
          projectId={mission.projectId}
        />
      ) : editing === "mission" ? (
        <MissionDialog call={call} mission={mission} onClose={close} projects={[]} />
      ) : editing === "slice" ? (
        <SliceDialog
          call={call}
          directory={directory}
          mission={mission}
          onClose={close}
          slices={slices}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether the mission may take a step that needs a review (D1278):
 * `missions.review.check`, asked again whenever the mission or one of its
 * slices changes on the `missions` stream. A node without the orchestrator,
 * or a failing call, says so here.
 */
function ReviewCheckSection(props: { call: Call; mission: Mission; slices: readonly Slice[] }) {
  const { call, mission, slices } = props;
  const [view, setView] = useState<ReviewCheckView>({ status: "loading" });
  // Any change of the mission or of a slice's work, proof or review changes this key.
  const key = [
    mission.updatedAt,
    ...slices.map((slice) => `${slice.id}:${slice.updatedAt}:${slice.review?.recordedAt ?? ""}`),
  ].join("|");
  useEffect(() => {
    let current = true;
    call<ReviewCheck>("missions.review.check", { missionId: mission.id }).then(
      (answer) =>
        current && setView({ status: "ready", clear: answer.clear, unreviewed: answer.unreviewed }),
      (error: unknown) => current && setView(reviewCheckFailed(error)),
    );
    return () => {
      current = false;
    };
  }, [mission.id, key]);
  const titles = new Map(slices.map((slice) => [slice.id, slice.title]));
  const lines = reviewCheckLines(view, (id) => titles.get(id) ?? id);
  return (
    <Section label="Review check" title="Reviews">
      <p
        className="text-sm text-foreground"
        data-review-check={
          view.status === "ready" ? (view.clear ? "clear" : "unreviewed") : view.status
        }
      >
        {lines.headline}
      </p>
      {lines.unreviewed.length === 0 ? null : (
        <ul className="list-disc ps-5 text-sm text-muted-foreground">
          {lines.unreviewed.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SliceRow(props: {
  slice: Slice;
  titles: ReadonlyMap<string, string>;
  onOpen: () => void;
}) {
  const { slice, titles, onOpen } = props;
  return (
    <button
      aria-label={`${slice.title}, ${STATUS_LABELS[slice.status]}, ${assigneeLabel(slice.assignee, titles)}`}
      className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
      data-slice={slice.id}
      onClick={onOpen}
      type="button"
    >
      <StatusBadge status={slice.status} />
      <span
        className={`min-w-0 flex-1 truncate text-sm ${slice.status === "dropped" ? "text-muted-foreground line-through" : "text-foreground"}`}
      >
        {slice.title}
      </span>
      {slice.step === undefined || slice.status === "done" ? null : (
        <Badge size="sm" variant="outline">
          {slice.step}
        </Badge>
      )}
      {slice.threads.length === 0 ? null : (
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title="Threads"
        >
          <MessagesSquareIcon aria-hidden className="size-3.5" />
          {slice.threads.length}
        </span>
      )}
      {slice.proof === undefined ? null : (
        <BadgeCheckIcon aria-label="Proven" className="size-4 shrink-0 text-success-foreground" />
      )}
      {slice.review === undefined ? null : (
        <Badge
          aria-label={`Review: ${VERDICT_LABELS[slice.review.verdict]}`}
          data-review={slice.review.verdict}
          size="sm"
          variant={slice.review.verdict === "approved" ? "success" : "warning"}
        >
          {VERDICT_LABELS[slice.review.verdict]}
        </Badge>
      )}
      <span
        className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground"
        title={slice.assignee}
      >
        {assigneeLabel(slice.assignee, titles)}
      </span>
    </button>
  );
}

function SlicePage(props: {
  slice: Slice;
  mission: Mission;
  state: MissionsState;
  target: NodeTarget;
  services: MissionsServices;
  directory: Directory;
  call: Call;
  open: (place: MissionPlace) => void;
}) {
  const { slice, mission, state, target, services, directory, call, open } = props;
  const [editing, setEditing] = useState(false);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-6 px-4 py-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{slice.title}</h1>
          <StatusBadge status={slice.status} />
          {/* A dropped slice stays dropped (D651): plan a new one instead. */}
          {slice.status === "dropped" ? null : (
            <span className="ms-auto">
              <EditButton label="Edit slice" onClick={() => setEditing(true)} />
            </span>
          )}
        </div>
        <DirectoryNotices notices={directory.notices} />
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact label="Assignee">
            <span title={slice.assignee}>{assigneeLabel(slice.assignee, directory.titles)}</span>
          </Fact>
          <Fact label="Wave">{slice.wave}</Fact>
          <Fact label="Step">
            <Steps current={slice.step} steps={mission.process.slice} />
          </Fact>
          <Fact label="Mission">{mission.title}</Fact>
        </dl>
        {slice.dependsOn.length === 0 ? null : (
          <Section title="Depends on">
            <ul className="flex flex-wrap gap-1.5">
              {slice.dependsOn.map((id) => {
                const dependency = state.slices[id];
                return (
                  <li key={id}>
                    <button
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent/40"
                      onClick={() => open({ kind: "slice", sliceId: id })}
                      type="button"
                    >
                      {dependency === undefined ? null : <StatusBadge status={dependency.status} />}
                      {dependency?.title ?? id}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
        {slice.reviews === undefined || slice.reviews.length === 0 ? null : (
          <Section title="Reviews">
            <ul className="flex flex-wrap gap-1.5">
              {slice.reviews.map((id) => {
                const reviewed = state.slices[id];
                return (
                  <li key={id}>
                    <button
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent/40"
                      onClick={() => open({ kind: "slice", sliceId: id })}
                      type="button"
                    >
                      {reviewed === undefined ? null : <StatusBadge status={reviewed.status} />}
                      {reviewed?.title ?? id}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
        <Section title="Spec">
          <Prose empty="No spec yet." text={slice.spec} />
        </Section>
        <Section title="Proof">
          {slice.proof === undefined ? (
            <p className="text-sm text-muted-foreground">
              {slice.status === "done"
                ? "No proof."
                : "Recorded with slices.prove when the slice is done."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Recorded {new Date(slice.proof.recordedAt).toLocaleString()}
                {slice.proof.by === undefined ? "" : ` by ${slice.proof.by}`}
              </p>
              <ul className="flex flex-col gap-2">
                {slice.proof.items.map((item, index) => (
                  <li key={index}>
                    <ProofEntry item={item} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
        <Section title="Review">
          {slice.review === undefined ? (
            <p className="text-sm text-muted-foreground">Not reviewed yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  data-review={slice.review.verdict}
                  size="sm"
                  variant={slice.review.verdict === "approved" ? "success" : "warning"}
                >
                  {VERDICT_LABELS[slice.review.verdict]}
                </Badge>
                {new Date(slice.review.recordedAt).toLocaleString()}
                {slice.review.by === undefined ? "" : ` by ${slice.review.by}`}
              </p>
              <Prose empty="No notes." text={slice.review.notes ?? ""} />
            </div>
          )}
        </Section>
        <Section title="Threads">
          {slice.threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No thread works on this slice yet.</p>
          ) : (
            <ul className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
              {slice.threads.map((thread) => (
                <li
                  className="border-b border-border/40 last:border-b-0"
                  key={`${thread.nodeId ?? ""}/${thread.threadId}`}
                >
                  <ThreadRow
                    onOpen={() => open({ kind: "slice", sliceId: slice.id, thread })}
                    services={services}
                    target={target}
                    thread={thread}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      {editing ? (
        <SliceDialog
          call={call}
          directory={directory}
          mission={mission}
          onClose={() => setEditing(false)}
          slice={slice}
          slices={slicesOf(state, mission.id)}
        />
      ) : null}
    </div>
  );
}

function ProofEntry({ item }: { item: ProofItem }) {
  if (item.kind === "command") {
    return (
      <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        <span className="text-muted-foreground">$ </span>
        {item.command}
        {"\n"}
        {item.output}
      </pre>
    );
  }
  // Proof URLs are http(s) only (D646): a link here never runs a script.
  const label =
    item.kind === "screenshot" ? (item.caption ?? "Screenshot") : (item.title ?? item.url);
  return (
    <a
      className="inline-flex max-w-full items-center gap-1.5 text-sm text-info-foreground hover:underline"
      href={item.url}
      rel="noopener noreferrer"
      target="_blank"
    >
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {item.kind === "screenshot" ? `Screenshot: ${label}` : label}
      </span>
    </a>
  );
}

/** A thread's title once its node answers `threads.get`; undefined until then, or if it cannot. */
function useThreadTitle(
  threads: ThreadsCatalog,
  target: NodeTarget | undefined,
  threadId: string | undefined,
): string | undefined {
  const [title, setTitle] = useState<{ key: string; title: string } | undefined>();
  const key =
    target === undefined || threadId === undefined ? undefined : `${targetKey(target)}|${threadId}`;
  useEffect(() => {
    if (target === undefined || threadId === undefined || key === undefined) return;
    let current = true;
    threads.call<{ thread: { title: string } }>(target, "threads.get", { threadId }).then(
      (answer) => current && setTitle({ key, title: answer.thread.title }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [threads, key]);
  return title?.key === key ? title?.title : undefined;
}

/** A linked thread, titled once the node answers `threads.get`. */
function ThreadRow(props: {
  thread: SliceThread;
  target: NodeTarget;
  services: MissionsServices;
  onOpen: () => void;
}) {
  const { thread, target, services, onOpen } = props;
  const self = useSelfNode(services.mesh, target.node);
  const at = threadTarget(target, thread, self);
  const title = useThreadTitle(services.threads, at, thread.threadId);
  return (
    <button
      className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
      data-slice-thread={thread.threadId}
      onClick={onOpen}
      type="button"
    >
      <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {title ?? thread.threadId}
      </span>
      {thread.nodeId === undefined ? null : (
        <span className="truncate text-xs text-muted-foreground">{thread.nodeId}</span>
      )}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

/** A thread working on the slice, read only (D741): its transcript, no composer. */
function ThreadPage(props: { slice: Slice; thread: SliceThread; target: NodeTarget }) {
  const { slice, thread, target } = props;
  const filled = useSlot(THREAD_TRANSCRIPT_SLOT).length > 0;
  const linked = slice.threads.some((item) => sameThread(item, thread));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-4">
      {linked ? null : (
        <p className="mx-auto mb-2 w-full max-w-(--chat-content-max-width) px-4 text-xs text-muted-foreground">
          This thread no longer works on the slice.
        </p>
      )}
      {filled ? (
        <Slot<ThreadTranscriptProps>
          first
          name={THREAD_TRANSCRIPT_SLOT}
          props={{ target, threadId: thread.threadId }}
        />
      ) : (
        <PageEmpty text="No plugin shows a thread's transcript here." title="No transcript" />
      )}
    </div>
  );
}

export { createMissionsStore } from "./store.ts";
