/**
 * A minimal ZIP reader, for unpacking the two artifacts the Windows layout
 * bundles.
 *
 * Node has no built-in zip extraction, and the alternatives are worse than
 * eighty lines of parsing:
 *
 * - **A dependency** would put a package in the build path of the thing that
 *   produces the software a shop runs, for one function, on a repository that
 *   has kept its dependency tree deliberately small.
 * - **Shelling out** means `unzip` on Linux and `tar`/`Expand-Archive` on
 *   Windows — two code paths, two failure modes, and a build that behaves
 *   differently depending on where it ran. `Expand-Archive` on a 350 MB archive
 *   is also famously slow.
 *
 * This reads the **central directory** rather than scanning local headers,
 * which is the correct way round: the central directory is the authoritative
 * index, and it carries real sizes even for entries written with a streaming
 * data descriptor (where the local header's sizes are zero).
 *
 * Deliberately narrow: store and deflate, no ZIP64, no encryption, no symlinks.
 * Anything outside that is a clear error rather than a silent partial extract —
 * these are two specific, pinned, checksum-verified archives, and if one of
 * them ever stops looking like this, the build should say so and stop.
 */
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** The largest trailing comment a zip may carry, and so how far back to look. */
const MAX_COMMENT_BYTES = 0xffff;

/**
 * One file in the archive, as the central directory describes it.
 *
 * @typedef {object} ZipEntry
 * @property {string} name          Forward-slashed path inside the archive.
 * @property {boolean} isDirectory  True for the explicit directory entries.
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} method
 * @property {number} crc32
 * @property {number} localHeaderOffset
 */

/**
 * Reads the central directory and returns every entry, in the order the
 * archive lists them.
 *
 * @param {Buffer} archive
 * @returns {ZipEntry[]}
 */
export function readZipEntries(archive) {
  const eocd = findEndOfCentralDirectory(archive);

  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralDirectorySize = archive.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocd + 16);

  // ZIP64 announces itself by saturating these fields. This reader does not
  // implement it, and quietly extracting the first 65 535 files of a larger
  // archive would be the worst possible response.
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error(
      'This archive uses ZIP64, which this reader does not implement. ' +
        'Unpack it with another tool, or extend scripts/windows/zip.mjs deliberately.',
    );
  }

  const entries = [];
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Central directory entry ${index} has a bad signature; the zip is corrupt.`);
    }

    const method = archive.readUInt16LE(cursor + 10);
    const crc32 = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);

    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({
      name,
      // A zip records a directory as a zero-length entry whose name ends in a
      // slash. Some writers omit them entirely, which is why extraction creates
      // parent directories from the file paths rather than relying on these.
      isDirectory: name.endsWith('/'),
      compressedSize,
      uncompressedSize,
      method,
      crc32,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * The bytes of one entry, decompressed and checked against its recorded CRC.
 *
 * The CRC check is redundant with the sha256 the caller already verified over
 * the whole archive — and it is here anyway, because it checks a different
 * thing: that *this parser* computed the right offsets. Offset arithmetic is
 * exactly the bug a hand-written reader has, and it fails silently, producing
 * plausible-looking rubbish.
 *
 * @param {Buffer} archive
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
export function readZipEntryData(archive, entry) {
  const header = entry.localHeaderOffset;
  if (archive.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new Error(`"${entry.name}" does not begin with a local file header; the zip is corrupt.`);
  }

  // Read the *local* name and extra lengths: a zip is permitted to carry a
  // different extra field locally than in the central directory, and using the
  // central one here would land the read a few bytes into the data.
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);

  let data;
  if (entry.method === METHOD_STORE) {
    data = Buffer.from(compressed);
  } else if (entry.method === METHOD_DEFLATE) {
    data = inflateRawSync(compressed);
  } else {
    throw new Error(
      `"${entry.name}" uses compression method ${entry.method}, which this reader does not ` +
        'implement (only store and deflate).',
    );
  }

  if (data.byteLength !== entry.uncompressedSize) {
    throw new Error(
      `"${entry.name}" unpacked to ${data.byteLength} bytes, not the ${entry.uncompressedSize} ` +
        'the archive records.',
    );
  }

  if (crc32(data) !== entry.crc32) {
    throw new Error(`"${entry.name}" failed its CRC check; the zip is corrupt or misread.`);
  }

  return data;
}

/**
 * Extracts the entries a caller asks for, and only those.
 *
 * `select` receives each entry's archive path and returns the path to write it
 * to, relative to `destination` — or `null` to skip it. That is what keeps this
 * from unpacking three hundred megabytes of documentation and debug symbols to
 * get at `bin/`, and it is also the only place an archive path is turned into a
 * filesystem path, which is where a malicious or malformed entry would have to
 * get through.
 *
 * @param {Buffer} archive
 * @param {string} destination
 * @param {(name: string) => string | null} select
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function extractZip(archive, destination, select) {
  const entries = readZipEntries(archive);
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    assertSafeEntryName(entry.name);

    const relative = select(entry.name);
    if (relative === null) continue;

    const target = path.resolve(destination, relative);
    // Belt and braces: `select` is ours, but it is the function that decides
    // where bytes land, and "the caller would never" is how directory traversal
    // gets shipped.
    if (
      target !== path.resolve(destination) &&
      !target.startsWith(path.resolve(destination) + path.sep)
    ) {
      throw new Error(
        `Refusing to write "${entry.name}" to ${target}, which is outside ${destination}.`,
      );
    }

    const data = readZipEntryData(archive, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);

    files += 1;
    bytes += data.byteLength;
  }

  return { files, bytes };
}

/**
 * Refuses an archive path that could escape the directory it is unpacked into.
 *
 * Absolute paths, drive letters, backslashes, and `..` segments are all refused
 * rather than sanitized. Neither of the two archives this build unpacks
 * contains anything of the kind, so a match means the archive is not what we
 * think it is — and the right response to that is to stop.
 *
 * @param {string} name
 */
export function assertSafeEntryName(name) {
  const refuse = (why) => {
    throw new Error(`Refusing zip entry "${name}": ${why}.`);
  };

  if (name.startsWith('/') || name.startsWith('\\')) refuse('it is an absolute path');
  if (/^[A-Za-z]:/.test(name)) refuse('it names a drive letter');
  if (name.includes('\\')) refuse('it contains a backslash');
  if (name.split('/').includes('..')) refuse('it contains a ".." segment');
  if (name.includes('\0')) refuse('it contains a null byte');
}

/** @param {Buffer} archive */
function findEndOfCentralDirectory(archive) {
  const earliest = Math.max(0, archive.byteLength - MAX_COMMENT_BYTES - 22);
  for (let offset = archive.byteLength - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('No end-of-central-directory record found; this is not a zip archive.');
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
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

/** @param {Buffer} data */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
