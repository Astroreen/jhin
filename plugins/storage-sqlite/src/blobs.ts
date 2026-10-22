import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  StorageError,
  assertBlobKey,
  assertName,
  compareKeys,
  type BlobInfo,
  type BlobStore,
} from "@jhin/storage-api";

/** Where a name is kept on disk: escaped, so no name leaves its folder. */
const segment = (name: string) => encodeURIComponent(name).replaceAll(".", "%2E");
const unsegment = (name: string) => decodeURIComponent(name);

/**
 * `storage.blobs@1` as files under `dir`: `<namespace>/<key segments>`, every
 * name escaped. Each write goes through the file's own queue, so two appends
 * to one blob never interleave. `path` names the file, for agents that read files.
 */
export function openFileBlobs(dir: string): BlobStore {
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(file: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(file) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(file, settled);
    void settled.then(() => {
      if (queues.get(file) === settled) queues.delete(file);
    });
    return next;
  };
  const root = (namespace: string) => {
    assertName("namespace", namespace);
    return Path.join(dir, segment(namespace));
  };
  const fileOf = (namespace: string, key: string) => {
    assertBlobKey(key);
    return Path.join(root(namespace), ...key.split("/").map(segment));
  };
  const stat = async (file: string) => {
    try {
      const found = await Fs.promises.stat(file);
      return found.isFile() ? found : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const info = (key: string, found: Fs.Stats): BlobInfo => ({
    key,
    size: found.size,
    modifiedAt: found.mtime.toISOString(),
  });
  /** Removes folders left empty, up to the namespace's. */
  const prune = async (file: string, top: string) => {
    let folder = Path.dirname(file);
    while (folder.startsWith(top) && folder !== top) {
      try {
        await Fs.promises.rmdir(folder);
      } catch {
        return;
      }
      folder = Path.dirname(folder);
    }
  };

  return {
    async append(namespace, key, bytes, options = {}) {
      const file = fileOf(namespace, key);
      return queued(file, async () => {
        const size = (await stat(file))?.size ?? 0;
        if (options.offset !== undefined && options.offset !== size) {
          throw new StorageError(
            "CONFLICT",
            `Blob ${key} has ${size} bytes, expected ${options.offset}`,
            {
              key,
              size,
              offset: options.offset,
            },
          );
        }
        await Fs.promises.mkdir(Path.dirname(file), { recursive: true });
        await Fs.promises.appendFile(file, bytes);
        return size + bytes.length;
      });
    },
    async read(namespace, key, options = {}) {
      const file = fileOf(namespace, key);
      let handle: Fs.promises.FileHandle;
      try {
        handle = await Fs.promises.open(file, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const { size } = await handle.stat();
        const start = Math.min(options.offset ?? 0, size);
        const length = Math.min(options.length ?? size - start, size - start);
        const buffer = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await handle.read(buffer, done, length - done, start + done);
          if (bytesRead === 0) break;
          done += bytesRead;
        }
        return buffer.subarray(0, done);
      } finally {
        await handle.close();
      }
    },
    async stat(namespace, key) {
      const found = await stat(fileOf(namespace, key));
      return found === undefined ? undefined : info(key, found);
    },
    async move(namespace, from, to) {
      const source = fileOf(namespace, from);
      const target = fileOf(namespace, to);
      return queued(source, () =>
        queued(target, async () => {
          if ((await stat(source)) === undefined) return false;
          await Fs.promises.mkdir(Path.dirname(target), { recursive: true });
          await Fs.promises.rename(source, target);
          await prune(source, root(namespace));
          return true;
        }),
      );
    },
    async delete(namespace, key) {
      const file = fileOf(namespace, key);
      return queued(file, async () => {
        try {
          await Fs.promises.unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        await prune(file, root(namespace));
        return true;
      });
    },
    async list(namespace, options = {}) {
      const top = root(namespace);
      const prefix = options.prefix ?? "";
      const found: BlobInfo[] = [];
      const walk = async (folder: string, keyPrefix: string): Promise<void> => {
        let entries: Fs.Dirent[];
        try {
          entries = await Fs.promises.readdir(folder, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const key = `${keyPrefix}${unsegment(entry.name)}`;
          const full = Path.join(folder, entry.name);
          if (entry.isDirectory()) {
            // Only folders that can hold a matching key.
            if (
              prefix.startsWith(`${key}/`) ||
              `${key}/`.startsWith(prefix) ||
              key.startsWith(prefix)
            ) {
              await walk(full, `${key}/`);
            }
          } else if (entry.isFile() && key.startsWith(prefix)) {
            const stats = await stat(full);
            if (stats !== undefined) found.push(info(key, stats));
          }
        }
      };
      await walk(top, "");
      return found.toSorted((a, b) => compareKeys(a.key, b.key));
    },
    path(namespace, key) {
      return fileOf(namespace, key);
    },
  };
}
