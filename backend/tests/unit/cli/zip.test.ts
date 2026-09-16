import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZip } from '../../../src/cli/zip.js';

/**
 * The diagnostics bundle's container.
 *
 * A dependency was rejected for this: one archive, of a handful of small text
 * files, in a product whose point is that it keeps working on a computer nobody
 * maintains. What that trade requires is that the eighty lines are actually
 * correct, which is what these assert — including against a reader that is not
 * ours.
 */

const readable = (entry: string): Buffer => Buffer.from(entry.repeat(200), 'utf8');

describe('createZip', () => {
  it('produces something every zip reader recognizes', () => {
    const archive = createZip([{ name: 'report.json', data: Buffer.from('{}') }]);
    // Local file header, then the end-of-central-directory record at the tail.
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(archive.subarray(archive.length - 22, archive.length - 18)).toEqual(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
  });

  it('records how many files it holds', () => {
    const archive = createZip([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b.txt', data: Buffer.from('b') },
      { name: 'logs/c.log', data: Buffer.from('c') },
    ]);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(3);
  });

  it('is empty-but-valid for no entries', () => {
    const archive = createZip([]);
    expect(archive).toHaveLength(22);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(0);
  });

  it('round-trips through the system unzip, byte for byte', () => {
    // The check that matters: a bundle is opened by whoever receives it, with
    // their own tools, not with this code.
    const directory = mkdtempSync(path.join(tmpdir(), 'ekon-zip-'));
    try {
      const entries = [
        { name: 'report.json', data: Buffer.from('{"appVersion":"1.4.0"}\n', 'utf8') },
        // Big enough to be worth deflating, so the compressed path is exercised.
        { name: 'logs/ekon.log', data: readable('a line of log output\n') },
        // And one that deflate cannot shrink, so the stored path is too.
        {
          name: 'random.bin',
          data: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) % 251)),
        },
      ];
      const archivePath = path.join(directory, 'bundle.zip');
      writeFileSync(archivePath, createZip(entries));

      let unzip: string;
      try {
        unzip = execFileSync('unzip', ['-o', '-q', archivePath, '-d', directory]).toString();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return; // no `unzip` here; the header checks above still ran
        throw error;
      }
      expect(unzip).toBe('');

      for (const entry of entries) {
        const extracted = execFileSync('cat', [path.join(directory, entry.name)]);
        expect(extracted.equals(entry.data), entry.name).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
