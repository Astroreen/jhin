// The page follows T3 Code's archive settings (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/SettingsPanels.tsx (Archived threads).
import { targetKey, type NodeTarget } from "@jhin/client-api";
import { Button } from "@jhin/ui";
import { ArchiveXIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { formatRelativeTimeLabel } from "../../lib/format.ts";
import { useExternal } from "../../lib/hooks.ts";
import { useMeshMembers } from "../../lib/mesh.ts";
import { ProjectIcon } from "../../lib/project-icon.tsx";
import { SettingsEmpty, SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import { useSettingsServices } from "./index.tsx";

/** Tells the page how many archived threads a node shows, for its empty state. */
type Report = (key: string, count: number) => void;

function NodeArchive(props: { target: NodeTarget; label: string; report: Report }) {
  const { target, label, report } = props;
  const { threads, actions } = useSettingsServices();
  const catalog = useSyncExternalStore(
    (listener) => {
      const subscription = threads.subscribe(target, listener);
      return () => subscription.dispose();
    },
    () => threads.catalog(target),
  );
  const archived = catalog.threads
    .filter((thread) => thread.archivedAt !== undefined)
    .toSorted((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const key = targetKey(target);
  useEffect(() => {
    report(key, archived.length);
    return () => report(key, 0);
  }, [report, key, archived.length]);
  if (archived.length === 0) return null;
  return (
    <>
      {catalog.projects.map((project) => {
        const own = archived.filter((thread) => thread.projectId === project.id);
        if (own.length === 0) return null;
        return (
          <SettingsSection
            icon={<ProjectIcon project={project} />}
            key={project.id}
            title={`${project.name} · ${label}`}
          >
            {own.map((thread) => (
              <SettingsRow
                control={
                  <div className="flex items-center gap-1.5">
                    <Button
                      onClick={() => void actions.unarchive(target, thread)}
                      size="xs"
                      variant="outline"
                    >
                      <ArchiveXIcon className="size-3.5" />
                      <span>Unarchive</span>
                    </Button>
                    <Button
                      aria-label={`Delete ${thread.title}`}
                      onClick={() => void actions.remove(target, thread)}
                      size="icon-xs"
                      variant="ghost-muted"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                }
                description={`Archived ${formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)} · Created ${formatRelativeTimeLabel(thread.createdAt)}`}
                key={thread.id}
                title={thread.title}
              />
            ))}
          </SettingsSection>
        );
      })}
    </>
  );
}

function MeshArchives({ node, report }: { node: string; report: Report }) {
  const { mesh } = useSettingsServices();
  const members = useMeshMembers(mesh, node) ?? [];
  return (
    <>
      {members
        .filter((member) => !member.self && member.reachable)
        .map((member) => (
          <NodeArchive
            key={member.nodeId}
            label={member.name}
            report={report}
            target={{ node, remote: member.nodeId }}
          />
        ))}
    </>
  );
}

export function ArchivedSection() {
  const { connections } = useSettingsServices();
  const nodes = useExternal(connections, connections.list);
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const [report] = useState<Report>(
    () => (key: string, count: number) =>
      setCounts((current) => (current[key] === count ? current : { ...current, [key]: count })),
  );
  const anyArchived = Object.values(counts).some((count) => count > 0);
  return (
    <>
      {nodes.map((node) => (
        <div className="contents" key={node.id}>
          <NodeArchive label={node.label} report={report} target={{ node: node.id }} />
          {node.state === "open" ? <MeshArchives node={node.id} report={report} /> : null}
        </div>
      ))}
      {anyArchived ? null : (
        <SettingsSection title="Archived threads">
          <SettingsRow
            description="Archived threads will appear here."
            title="No archived threads"
          />
        </SettingsSection>
      )}
      {nodes.length === 0 ? <SettingsEmpty>No node connected.</SettingsEmpty> : null}
    </>
  );
}
