// The quiet line that says why a title or a picker entry is missing (docs/plans/agents.md,
// C2: D1277). Part of the view's chunk (D440).
export function DirectoryNotices({ notices }: { notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5" data-directory-notices role="status">
      {notices.map((notice) => (
        <p className="text-xs text-muted-foreground" key={notice}>
          {notice}
        </p>
      ))}
    </div>
  );
}
