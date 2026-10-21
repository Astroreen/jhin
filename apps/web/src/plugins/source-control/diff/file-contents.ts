// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/diffFileContents.ts.
import type { FileDiffContentsLoader } from "@pierre/diffs";
import type { DiffScopeResult } from "@jhin/source-control-api";

import { resolveFileDiffPath } from "./rendering.ts";

/**
 * Pierre's loader of a file's two sides (D921), from a scope's `loadFile`;
 * `cacheKey` names the diff they belong to, so a diff read again highlights afresh.
 */
export function diffFileContentsLoader(
  loadFile: NonNullable<DiffScopeResult["loadFile"]>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await loadFile({
      path: newPath,
      ...(oldPath === newPath ? {} : { previousPath: oldPath }),
    });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
