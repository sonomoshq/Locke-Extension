// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Minimal, dependency-free, deterministic ZIP writer.
//
// Why this exists instead of shelling out: PowerShell 5.1's Compress-Archive
// (the Windows path the packager used to take) writes entry names with
// BACKSLASH separators. Section 4.4.17.1 of the .ZIP spec requires forward
// slashes, and the Chrome Web Store / Edge / AMO uploaders reject or mangle
// such archives ("manifest file not found", flattened directories). Building
// the archive here means the artifact is byte-identical no matter which OS
// produced it — which also gives AMO source review a reproducible zip.
//
// Deterministic by construction: entries are written in the order given, every
// entry carries the same DOS timestamp (fixed, or SOURCE_DATE_EPOCH when the
// release workflow pins it to a tag), and deflate runs at a fixed level. No
// zip64 — extension payloads are far below the 4 GiB / 65535-entry ceilings,
// and the writer throws rather than emit a silently-truncated archive.

import { deflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

// 2020-01-01 00:00:00 in DOS date/time. Any fixed value works; a
// pre-1980 one trips some unzip implementations, so pick a real date.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * SOURCE_DATE_EPOCH, the cross-ecosystem reproducible-builds convention.
 *
 * The fixed 2020 stamp above already makes two builds of the same tree
 * identical, which is what a store cares about. This exists for the other
 * direction: docs/security/RELEASE-POLICY.md promises an outside auditor can
 * check out a tag, rebuild, and get the published bytes — and release.yml
 * pins the variable to the tag commit's committer time so they can.
 *
 * Unset or unparseable falls back to the fixed stamp, so a local
 * `npm run package` is deterministic without anyone exporting anything.
 * Always read in UTC: a local-timezone read would make the same commit build
 * differently in two offices.
 */
function dosStamp(env = process.env) {
  const raw = Number(env.SOURCE_DATE_EPOCH);
  if (!Number.isFinite(raw) || raw <= 0) return { time: DOS_TIME, date: DOS_DATE };

  // 315532800 = 1980-01-01Z, the floor the DOS date field can represent.
  const d = new Date(Math.max(Math.floor(raw), 315532800) * 1000);
  return {
    time: ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (Math.floor(d.getUTCSeconds() / 2) & 0x1f)) & 0xffff,
    date: (((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xffff
  };
}

// Bit 11 = names/comments are UTF-8.
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Write a ZIP archive.
 *
 * @param {string} zipPath - destination file.
 * @param {Array<{name: string, data: Buffer}>} entries - `name` is the path
 *   inside the archive, always with `/` separators and no leading slash.
 */
export function writeZip(zipPath, entries) {
  if (entries.length > 0xffff) {
    throw new Error(`zip: ${entries.length} entries exceeds the non-zip64 limit of 65535`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  const { time: dosTime, date: dosDate } = dosStamp();

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (name.includes('..')) throw new Error(`zip: refusing traversal entry name '${name}'`);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = entry.data;

    // Store when deflate doesn't pay — keeps tiny files from growing.
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    if (raw.length > 0xffffffff || body.length > 0xffffffff) {
      throw new Error(`zip: '${name}' exceeds the non-zip64 4 GiB size limit`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract (2.0)
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed to extract
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // file comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal file attributes
    central.writeUInt32LE(0, 38);         // external file attributes
    central.writeUInt32LE(offset, 42);    // relative offset of local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with start of central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // .zip file comment length

  writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, end]));
  return zipPath;
}
