const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;
const MAX_BLOCK_SIZE = 128 * 1024;

type Phase = "magic" | "descriptor" | "header" | "block" | "payload" | "checksum" | "skipSize" | "skip";

/**
 * Split standard Zstandard frames without searching for magic inside payloads.
 * https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
 *
 * Retain only the current standard frame; skip metadata without buffering it.
 * A frame contained in one chunk is a view, and a spanning frame is copied
 * exactly once. Never concatenate an accumulating prefix or remaining suffix.
 * Yield before inspecting the next frame, so early sampling can ignore its tail.
 * Compressed contents, dictionary support and checksums belong to the decoder.
 */
export async function* splitZstdFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  // Only structural fields need a scratch buffer (the header rest is <= 13B).
  const field = Buffer.allocUnsafe(13);
  let phase: Phase = "magic";
  let needed = 4;
  let filled = 0;
  let descriptor = 0;
  let blockMaximum = MAX_BLOCK_SIZE;
  let lastBlock = false;
  let retain = true;
  let parts: Buffer[] = [];
  let frameSize = 0;

  for await (const input of chunks) {
    const chunk = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    let partStart = 0;
    while (offset < chunk.length) {
      const count = Math.min(needed - filled, chunk.length - offset);
      if (phase !== "payload" && phase !== "checksum" && phase !== "skip") {
        chunk.copy(field, filled, offset, offset + count);
      }
      filled += count;
      offset += count;
      if (filled < needed) continue;

      let complete = false;
      switch (phase) {
        case "magic": {
          const magic = field.readUInt32LE(0);
          if (magic === ZSTD_MAGIC) {
            phase = "descriptor";
            needed = 1;
          } else if ((magic & 0xfffffff0) === SKIPPABLE_MAGIC) {
            // Even a multi-GB skippable frame only needs its 8B header.
            parts = [];
            frameSize = 0;
            retain = false;
            phase = "skipSize";
            needed = 4;
          } else {
            throw new Error("Invalid Zstandard frame magic");
          }
          break;
        }
        case "descriptor": {
          descriptor = field[0];
          if (descriptor & 0x08) throw new Error("Reserved Zstandard frame header bit");
          // Bit 4 is unused, not reserved: compliant decoders must ignore it.
          const singleSegment = !!(descriptor & 0x20);
          const sizeFlag = descriptor >>> 6;
          const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
          const dictFlag = descriptor & 3;
          const dictBytes = dictFlag === 0 ? 0 : 1 << (dictFlag - 1);
          phase = "header";
          needed = (singleSegment ? 0 : 1) + dictBytes + sizeBytes;
          break;
        }
        case "header": {
          if (descriptor & 0x20) {
            const sizeFlag = descriptor >>> 6;
            const dictFlag = descriptor & 3;
            const sizeOffset = dictFlag === 0 ? 0 : 1 << (dictFlag - 1);
            // Clamp before converting an 8B content size to Number.
            const contentSize = sizeFlag === 3
              ? field.readBigUInt64LE(sizeOffset)
              : BigInt(sizeFlag === 0 ? field[sizeOffset]
                : sizeFlag === 1 ? field.readUInt16LE(sizeOffset) + 256
                  : field.readUInt32LE(sizeOffset));
            blockMaximum = contentSize < BigInt(MAX_BLOCK_SIZE) ? Number(contentSize) : MAX_BLOCK_SIZE;
          } else {
            const window = field[0];
            const base = 2 ** (10 + (window >>> 3));
            blockMaximum = Math.min(MAX_BLOCK_SIZE, base + (base / 8) * (window & 7));
          }
          phase = "block";
          needed = 3;
          break;
        }
        case "block": {
          const header = field.readUIntLE(0, 3);
          lastBlock = !!(header & 1);
          const type = (header >>> 1) & 3;
          const size = header >>> 3;
          if (type === 3) throw new Error("Reserved Zstandard block type");
          if (size > blockMaximum) throw new Error("Invalid Zstandard block size");
          phase = "payload";
          needed = type === 1 ? 1 : size; // RLE stores one byte, not size bytes.
          if (needed !== 0) break;
          // Empty raw blocks still complete immediately at a chunk boundary.
        }
        // Fall through for an empty block.
        case "payload": {
          if (!lastBlock) {
            phase = "block";
            needed = 3;
          } else if (descriptor & 4) {
            phase = "checksum";
            needed = 4;
          } else {
            complete = true;
          }
          break;
        }
        case "checksum":
          complete = true;
          break;
        case "skipSize":
          phase = "skip";
          needed = field.readUInt32LE(0);
          if (needed !== 0) break;
          // An empty skippable frame is complete at its header's boundary.
        case "skip":
          complete = true;
          break;
      }
      filled = 0;
      if (complete) {
        if (retain) {
          if (partStart < offset) {
            const part = chunk.subarray(partStart, offset);
            parts.push(part);
            frameSize += part.length;
          }
          const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts, frameSize);
          parts = [];
          frameSize = 0;
          yield frame;
        }
        retain = true;
        partStart = offset;
        phase = "magic";
        needed = 4;
      }
    }
    if (retain && partStart < offset) {
      const part = chunk.subarray(partStart, offset);
      parts.push(part);
      frameSize += part.length;
    }
  }
  if (phase !== "magic" || filled !== 0) {
    throw new Error(`Truncated Zstandard frame (${phase})`);
  }
}
