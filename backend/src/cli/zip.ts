import { deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer, for the diagnostics bundle.
 *
 * A dependency would have been the obvious answer, and was rejected: this
 * writes one archive, of a handful of small text files, on a machine in a shop,
 * and it is the only thing in the product that needs an archive at all. Adding
 * a package — and its transitive tree, and its supply chain, and its upgrade
 * path — to a product whose entire point is that it keeps working on a computer
 * nobody maintains, in exchange for eighty lines, is a bad trade.
 *
 * ZIP rather than tar.gz because the recipient is a Windows machine, where
 * double-clicking a `.zip` opens it and a `.tar.gz` needs software the shop does
 * not have.
 *
 * Deliberately narrow: one flat archive, no directories, no ZIP64, no
 * encryption, no streaming. Entries are deflated, or stored when deflating
 * makes them bigger. That is the whole format this needs, and anything more
 * would be a compression library nobody asked for.
 */

export interface ZipEntry {
  /** The name inside the archive. Forward slashes; no leading slash. */
  name: string;
  data: Buffer;
  /** Modification time recorded in the entry. Defaults to now. */
  modified?: Date;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** The archive, as one buffer. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? METHOD_STORE : METHOD_DEFLATE;
    const { time, date } = dosTimestamp(entry.modified ?? new Date());
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: names and comments are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    parts.push(local, name, payload);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    entryHeader.writeUInt16LE(20, 4); // version made by
    entryHeader.writeUInt16LE(20, 6); // version needed
    entryHeader.writeUInt16LE(0x0800, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(payload.length, 20);
    entryHeader.writeUInt32LE(entry.data.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt16LE(0, 30); // extra field length
    entryHeader.writeUInt16LE(0, 32); // comment length
    entryHeader.writeUInt16LE(0, 34); // disk number
    entryHeader.writeUInt16LE(0, 36); // internal attributes
    entryHeader.writeUInt32LE(0, 38); // external attributes
    entryHeader.writeUInt32LE(offset, 42);

    central.push(entryHeader, name);
    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...parts, centralBuffer, end]);
}

/**
 * MS-DOS date and time, which is what ZIP stores: two seconds of resolution, no
 * timezone, and an epoch of 1980. Anything before 1980 is clamped rather than
 * written as a negative year, which some readers refuse outright.
 */
function dosTimestamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  const time =
    (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
