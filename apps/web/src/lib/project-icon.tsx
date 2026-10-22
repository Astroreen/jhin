// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ProjectMonogram.tsx,
// apps/web/src/projectIdentity.ts and apps/web/src/projectIconColors.ts.
import { cn } from "@jhin/ui";
import { MessageSquareDashedIcon } from "lucide-react";

/** Full class strings, so Tailwind sees each one. */
const COLORS = [
  "text-gray-600 dark:text-gray-400",
  "text-red-600 dark:text-red-400",
  "text-orange-600 dark:text-orange-400",
  "text-amber-600 dark:text-amber-400",
  "text-yellow-600 dark:text-yellow-400",
  "text-lime-600 dark:text-lime-400",
  "text-green-600 dark:text-green-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-teal-600 dark:text-teal-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-sky-600 dark:text-sky-400",
  "text-blue-600 dark:text-blue-400",
  "text-indigo-600 dark:text-indigo-400",
  "text-violet-600 dark:text-violet-400",
  "text-purple-600 dark:text-purple-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-pink-600 dark:text-pink-400",
  "text-rose-600 dark:text-rose-400",
] as const;

const normalize = (name: string) => name.normalize("NFKC").trim();

/** Two letters for a project: "my-app" → "MP", "web2" → "W2". */
function projectMonogram(name: string): string {
  const words = normalize(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (firstWord === undefined) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

/** A stable color for a project name. */
function projectColorClass(name: string): string {
  const seed = normalize(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % COLORS.length;
  return COLORS[index] ?? COLORS[11];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function ProjectMonogram({ name, className }: { name: string; className?: string | undefined }) {
  const text = projectMonogram(name);
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          projectColorClass(name),
        )}
        style={{ backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
        viewBox="0 0 16 16"
      >
        <text
          className="font-mono"
          fill="currentColor"
          fontSize="8.25"
          fontWeight="700"
          lengthAdjust="spacingAndGlyphs"
          textAnchor="middle"
          textLength={Array.from(segmenter.segment(text)).length === 1 ? 6 : 12}
          textRendering="geometricPrecision"
          x="8"
          y="10.8"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}

/** The scratch project ("No project") has an icon instead of a monogram. */
export function ProjectIcon({
  project,
  className,
}: {
  project: { name: string; scratch: boolean };
  className?: string | undefined;
}) {
  if (project.scratch) {
    return (
      <MessageSquareDashedIcon
        aria-hidden="true"
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  return <ProjectMonogram className={className} name={project.name} />;
}
