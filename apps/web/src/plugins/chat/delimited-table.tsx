// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/DelimitedTablePreview.tsx and packages/shared/src/delimitedPreview.ts.
//
// A CSV or TSV file as a table, its first 100 rows and 30 columns (t3-parity.md D1436).
/* oxlint-disable react/no-array-index-key -- Rows and columns have stable places and may repeat values. */

/** T3's `filePreviewDelimiter`: by its type, else its name. */
export function filePreviewDelimiter(file: {
  readonly name: string;
  readonly mimeType?: string;
}): "," | "\t" | null {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "text/csv") return ",";
  if (mime === "text/tab-separated-values") return "\t";
  if (mime && mime !== "text/plain" && mime !== "application/octet-stream") return null;
  if (/\.csv$/i.test(file.name)) return ",";
  if (/\.tsv$/i.test(file.name)) return "\t";
  return null;
}

/** T3's `parseDelimitedPreview`: quoted cells, at most 100 rows, 30 columns, 2000 characters a cell. */
export function parseDelimitedPreview(
  text: string,
  delimiter: "," | "\t",
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (row.length < 30) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let index = rowStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        if (cell.length < 2000) cell += '"';
        else truncated = true;
        index++;
        continue;
      }
      if (quoted || cell === "") {
        quoted = !quoted;
        continue;
      }
    }
    if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      endCell();
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
        rowStart = index + 1;
        if (rows.length === 100) return { rows, truncated: truncated || index < text.length - 1 };
      }
    } else if (cell.length < 2000) cell += char;
    else truncated = true;
  }
  if (rowStart < text.length) {
    endCell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}

/** T3's DelimitedTablePreview. */
export function DelimitedTablePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly delimiter: "," | "\t";
}) {
  const table = parseDelimitedPreview(props.text, props.delimiter);
  const [header, ...body] = table.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {table.truncated ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
          Table limited to the first 100 rows and 30 columns. Switch to source for the rest.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          aria-label={props.name}
          className="min-w-full border-separate border-spacing-0 text-xs"
        >
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, columnIndex) => (
                  <th
                    className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                    key={columnIndex}
                    scope="col"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr className="even:bg-muted/30" key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                    key={columnIndex}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
