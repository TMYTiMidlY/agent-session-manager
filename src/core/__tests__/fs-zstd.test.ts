import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { readJsonl } from "../fs.js";
import { splitZstdFrames } from "../zstd.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function file(bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asmgr-zstd-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl.zstd");
  await writeFile(path, bytes);
  return path;
}

const frame = (text: string | Uint8Array) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function block(type: number, size: number, last = true): Buffer {
  const header = Buffer.alloc(3);
  header.writeUIntLE((size << 3) | (type << 1) | Number(last), 0, 3);
  return header;
}

function rawFrame(payload: Buffer, single = true, sizeFlag = payload.length < 256 ? 0 : 2, dictFlag = 0): Buffer {
  const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag;
  const size = Buffer.alloc(sizeBytes);
  if (sizeBytes === 8) size.writeBigUInt64LE(BigInt(payload.length));
  else if (sizeBytes) size.writeUIntLE(sizeBytes === 2 ? payload.length - 256 : payload.length, 0, sizeBytes);
  return Buffer.concat([
    magic, Buffer.from([(sizeFlag << 6) | (single ? 0x20 : 0) | dictFlag]),
    single ? Buffer.alloc(0) : Buffer.from([0]), // 1 KiB window
    Buffer.alloc(dictFlag === 0 ? 0 : 1 << (dictFlag - 1)), size,
    block(0, payload.length), payload,
  ]);
}

function skippable(payload: Buffer, id = 0): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50 + id, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function scan(input: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const bytes of splitZstdFrames(input)) result.push(bytes);
  return result;
}

function useStream(input: Readable): void {
  vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
}

describe("Zstandard JSONL", () => {
  it("reads all concatenated checksummed frames and supports header-only sampling", async () => {
    const path = await file(Buffer.concat([frame('{"header":true}\n'), frame('{"text":"你好"}\n'), frame('{"last":true}\n')]));
    await expect(readJsonl(path)).resolves.toEqual([{ header: true }, { text: "你好" }, { last: true }]);
    await expect(readJsonl(path, 1)).resolves.toEqual([{ header: true }]);
  });

  it.each([1, 2, 3, 7, 64, 65_536])("handles frames and every structural field split into %i-byte chunks", async (size) => {
    const bytes = Buffer.concat([
      frame('{"first":true}\r'), skippable(Buffer.from("metadata"), 15),
      frame('\n{"text":"你好🙂"}'), frame('\n{"last":true}'),
    ]);
    useStream(Readable.from(chunks(bytes, size)));
    await expect(readJsonl("unused.jsonl.zstd")).resolves.toEqual([{ first: true }, { text: "你好🙂" }, { last: true }]);
  });

  it("preserves a UTF8 code point split across frames with empty and skippable frames between", async () => {
    const text = Buffer.from('{"text":"你好🙂"}\n');
    const start = text.indexOf(Buffer.from("🙂"));
    const bytes = Buffer.concat([
      frame(text.subarray(0, start + 1)), frame(Buffer.alloc(0)), skippable(Buffer.from("ignored")),
      frame(text.subarray(start + 1, start + 3)), frame(text.subarray(start + 3)),
    ]);
    await expect(readJsonl(await file(bytes))).resolves.toEqual([{ text: "你好🙂" }]);
  });

  it("reads a frame spanning multiple real filesystem chunks", async () => {
    const text = "界".repeat(30_000);
    const bytes = rawFrame(Buffer.from(JSON.stringify({ text }) + "\n"));
    const path = await file(Buffer.concat([bytes, frame('{"last":true}\n')]));
    await expect(readJsonl(path)).resolves.toEqual([{ text }, { last: true }]);
  });

  it("samples before a huge corrupt tail without reading it or leaving the fd open", async () => {
    const first = frame('{"header":true}\n');
    const path = await file(Buffer.concat([first, Buffer.alloc(16 * 1024 * 1024, 0xff)]));
    await expect(readJsonl(path, 1)).resolves.toEqual([{ header: true }]);
    const source = vi.mocked(createReadStream).mock.results.at(-1)!.value as ReadStream;
    expect(source.destroyed).toBe(true);
    expect(source.closed).toBe(true);
    expect(source.bytesRead).toBeLessThanOrEqual(2 * source.readableHighWaterMark);
    await expect(readJsonl(path)).rejects.toThrow(/magic/);
  });

  it("stops before inspecting a corrupt next frame even when it shares the same chunk", async () => {
    useStream(Readable.from([Buffer.concat([frame('{"header":true}\n'), Buffer.from("bad!")])]));
    await expect(readJsonl("unused.jsonl.zstd", 1)).resolves.toEqual([{ header: true }]);
  });

  it("reads native multi-block frames with unknown content size and optional checksums", async () => {
    const text = "abc".repeat(10_000);
    const frames = [0, 1].map((checksum) => zstdCompressSync(JSON.stringify({ text }) + "\n", {
      params: {
        [constants.ZSTD_c_contentSizeFlag]: 0,
        [constants.ZSTD_c_checksumFlag]: checksum,
        [constants.ZSTD_c_windowLog]: 10,
      },
    }));
    useStream(Readable.from(chunks(Buffer.concat(frames), 7)));
    await expect(readJsonl("unused.jsonl.zstd")).resolves.toEqual([{ text }, { text }]);
  });

  it("lets the decoder reject frames requiring an unavailable dictionary", async () => {
    const bytes = rawFrame(Buffer.from('{}\n'), true, 0, 1);
    bytes[5] = 123;
    await expect(readJsonl(await file(bytes))).rejects.toThrow();
  });

  it("reports checksum corruption rather than returning a complete-looking transcript", async () => {
    const bytes = frame('{"last":true}\n');
    bytes[bytes.length - 1] ^= 0xff;
    const path = await file(Buffer.concat([frame('{"header":true}\n'), bytes]));
    await expect(readJsonl(path)).rejects.toThrow();
    await expect(readJsonl(path, 1)).resolves.toEqual([{ header: true }]);
  });

  it("reports an incomplete final compressed frame", async () => {
    const bytes = frame('{"last":true}\n');
    const path = await file(Buffer.concat([frame('{"header":true}\n'), bytes.subarray(0, bytes.length - 2)]));
    await expect(readJsonl(path)).rejects.toThrow(/Truncated/);
  });

  it("skips every metadata magic variant before, between and after data frames", async () => {
    const metadata = Array.from({ length: 16 }, (_, id) => skippable(id === 0 ? Buffer.alloc(0) : magic, id));
    const bytes = Buffer.concat([...metadata, frame('{"first":true}\n'), ...metadata, frame('{"last":true}\n'), ...metadata]);
    await expect(readJsonl(await file(bytes))).resolves.toEqual([{ first: true }, { last: true }]);
    await expect(readJsonl(await file(Buffer.concat(metadata)))).resolves.toEqual([]);
    await expect(readJsonl(await file(Buffer.alloc(0)))).resolves.toEqual([]);
  });

  it("reports truncated skippable data after a complete frame", async () => {
    const bytes = skippable(Buffer.from("metadata"));
    await expect(readJsonl(await file(Buffer.concat([frame('{}\n'), bytes.subarray(0, bytes.length - 1)])))).rejects.toThrow(/Truncated/);
  });

  it("propagates source-open errors through the frame reader", async () => {
    await expect(readJsonl(join(tmpdir(), "missing-asmgr-session", "session.jsonl.zstd"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not open compressed files when no rows are requested", async () => {
    await expect(readJsonl("missing.jsonl.zstd", 0)).resolves.toEqual([]);
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it("propagates read failures and closes the source", async () => {
    const error = Object.assign(new Error("read failed"), { code: "EIO" });
    const input = new Readable({ read() { this.destroy(error); } });
    useStream(input);
    await expect(readJsonl("unused.jsonl.zstd")).rejects.toBe(error);
    expect(input.closed).toBe(true);
  });

  it("propagates EOF close failures while keeping cancellation-time errors handled", async () => {
    const error = new Error("close failed");
    const input = new Readable({
      read() { this.push(frame('{}\n')); this.push(null); },
      destroy(_error, callback) { callback(error); },
    });
    useStream(input);
    await expect(readJsonl("unused.jsonl.zstd")).rejects.toBe(error);
    const sampled = new Readable({
      read() { this.push(frame('{}\n')); },
      destroy(_error, callback) { setImmediate(() => callback(error)); },
    });
    useStream(sampled);
    await expect(readJsonl("unused.jsonl.zstd", 1)).resolves.toEqual([{}]);
    expect(sampled.closed).toBe(true);
  });
});

describe("Zstandard frame boundaries", () => {
  it("accepts all window, dictionary-ID and content-size field widths", async () => {
    const frames: Buffer[] = [];
    const payloads: Buffer[] = [];
    for (const single of [false, true]) for (let sizeFlag = 0; sizeFlag < 4; sizeFlag++) for (let dictFlag = 0; dictFlag < 4; dictFlag++) {
      const payload = Buffer.alloc(sizeFlag === 1 ? 300 : 17, 0x61);
      frames.push(rawFrame(payload, single, sizeFlag, dictFlag));
      payloads.push(payload);
    }
    const result = await scan(chunks(Buffer.concat(frames), 1));
    expect(result).toEqual(frames);
    expect(result.map((bytes) => zstdDecompressSync(bytes))).toEqual(payloads);
  });

  it("recognizes raw, RLE and compressed blocks and multiple blocks without looking inside payloads", async () => {
    const raw = Buffer.concat([magic, skippable(Buffer.from("not a frame boundary")), magic]);
    const multiBlock = Buffer.concat([
      magic, Buffer.from([0, 0]), block(0, raw.length, false), raw,
      block(0, 0, false), block(1, 37), Buffer.from("a"),
    ]);
    const compressed = frame("abc".repeat(10_000));
    const result = await scan(chunks(Buffer.concat([multiBlock, compressed, rawFrame(Buffer.alloc(0))]), 2));
    expect(result).toEqual([multiBlock, compressed, rawFrame(Buffer.alloc(0))]);
    expect(zstdDecompressSync(result[0])).toEqual(Buffer.concat([raw, Buffer.alloc(37, 0x61)]));
    expect(zstdDecompressSync(result[1]).toString()).toBe("abc".repeat(10_000));
    expect(zstdDecompressSync(result[2])).toHaveLength(0);
  });

  it("handles every possible two-chunk cut and zero-length chunks", async () => {
    const frames = [frame("one"), frame("two")];
    const bytes = Buffer.concat([frames[0], skippable(magic), frames[1]]);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const input = (async function* () {
        yield bytes.subarray(0, cut);
        yield Buffer.alloc(0);
        yield bytes.subarray(cut);
      })();
      expect(await scan(input)).toEqual(frames);
    }
  });

  it("rejects every nonempty truncated prefix of standard and skippable frames", async () => {
    for (const bytes of [frame("abc".repeat(100)), rawFrame(Buffer.from("raw")), skippable(magic)]) {
      for (let end = 1; end < bytes.length; end++) {
        await expect(scan(chunks(bytes.subarray(0, end), 1))).rejects.toThrow(/Truncated/);
      }
    }
  });

  it("rejects invalid magic, reserved header bits and reserved block types", async () => {
    const reservedHeader = rawFrame(Buffer.from("raw"));
    reservedHeader[4] |= 8;
    const reservedBlock = rawFrame(Buffer.from("raw"));
    reservedBlock[6] |= 6;
    await expect(scan(chunks(Buffer.from("bad!"), 1))).rejects.toThrow(/magic/);
    await expect(scan(chunks(reservedHeader, 1))).rejects.toThrow(/Reserved.*header/);
    await expect(scan(chunks(reservedBlock, 1))).rejects.toThrow(/Reserved.*block/);
  });

  it("enforces both the window-dependent and 128 KiB block limits, including RLE sizes", async () => {
    const largeRaw = rawFrame(Buffer.alloc(131_073));
    const smallWindow = rawFrame(Buffer.alloc(1025), false, 0);
    const smallContent = Buffer.concat([magic, Buffer.from([0x20, 5]), block(1, 6), Buffer.from("a")]);
    for (const bytes of [largeRaw, smallWindow, smallContent]) {
      await expect(scan(chunks(bytes, 3))).rejects.toThrow(/block size/);
    }
  });

  it("interprets window exponents and mantissas rather than assuming the 128 KiB limit", async () => {
    const mantissa = rawFrame(Buffer.alloc(1152, 0x61), false, 0);
    mantissa[5] = 1; // 1 KiB + 1/8 KiB
    const exponent = rawFrame(Buffer.alloc(2048, 0x62), false, 0);
    exponent[5] = 8; // 2 KiB
    const frames = await scan(chunks(Buffer.concat([mantissa, exponent]), 3));
    expect(frames).toEqual([mantissa, exponent]);
    expect(frames.map((bytes) => zstdDecompressSync(bytes).length)).toEqual([1152, 2048]);
    mantissa[5] = 0;
    await expect(scan(chunks(mantissa, 3))).rejects.toThrow(/block size/);
  });

  it("ignores the unused descriptor bit and clamps 64-bit size fields without precision loss", async () => {
    const unused = rawFrame(Buffer.from("raw"));
    unused[4] |= 0x10;
    const largeSize = rawFrame(Buffer.from("raw"), true, 3);
    largeSize.writeBigUInt64LE(0xffffffffffffffffn, 5);
    expect(await scan(chunks(Buffer.concat([unused, largeSize]), 1))).toEqual([unused, largeSize]);
    expect(zstdDecompressSync(unused).toString()).toBe("raw");
  });

  it("returns a view for contiguous frames and copies spanning frames only once", async () => {
    const first = frame("one");
    const second = frame("two");
    const bytes = Buffer.concat([first, second]);
    const contiguous = await scan(chunks(bytes, bytes.length));
    expect(contiguous[0].buffer).toBe(bytes.buffer);
    expect(contiguous[0].byteOffset).toBe(bytes.byteOffset);
    const concat = vi.spyOn(Buffer, "concat");
    expect(await scan(chunks(first, 1))).toEqual([first]);
    expect(concat).toHaveBeenCalledTimes(1);
    expect(concat.mock.calls[0][1]).toBe(first.length);
    concat.mockRestore();
  });

  it("accepts Uint8Array chunks with nonzero byte offsets without copying their backing buffer", async () => {
    const bytes = frame("one");
    const backing = new Uint8Array(bytes.length + 10);
    backing.set(bytes, 5);
    const input = backing.subarray(5, backing.length - 5);
    const result = await scan((async function* () { yield input; })());
    expect(result).toEqual([bytes]);
    expect(result[0].buffer).toBe(backing.buffer);
    expect(result[0].byteOffset).toBe(5);
  });

  it("does not buffer even a huge skippable frame or scan beyond a yielded standard frame", async () => {
    const prefix = skippable(Buffer.alloc(0));
    prefix.writeUInt32LE(0xffffffff, 4);
    const concat = vi.spyOn(Buffer, "concat");
    const result = scan((async function* () { yield prefix; for (let i = 0; i < 128; i++) yield Buffer.alloc(1024); })());
    await expect(result).rejects.toThrow(/Truncated.*skip/);
    expect(concat).not.toHaveBeenCalled();
    concat.mockRestore();
    let pulledTail = false;
    const frames = splitZstdFrames((async function* () {
      yield frame("one");
      pulledTail = true;
      throw new Error("should not pull the tail");
    })());
    expect((await frames.next()).done).toBe(false);
    await frames.return(undefined);
    expect(pulledTail).toBe(false);
  });
});
