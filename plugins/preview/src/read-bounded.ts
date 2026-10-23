/** The parts of a file handle `readBounded` uses. */
interface BoundedFile {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

/**
 * The whole file, or undefined when it holds more than `max` bytes: the bound holds for the
 * read itself, so a file that grows after its size was taken cannot pass it (D1331).
 */
export async function readBounded(file: BoundedFile, max: number): Promise<Buffer | undefined> {
  const { size } = await file.stat();
  if (size > max) return undefined;
  let buffer = Buffer.alloc(size + 1);
  let length = 0;
  for (;;) {
    if (length === buffer.length) {
      const grown = Buffer.alloc(Math.min(max + 1, buffer.length * 2));
      buffer.copy(grown);
      buffer = grown;
    }
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) return buffer.subarray(0, length);
    length += bytesRead;
    if (length > max) return undefined;
  }
}
