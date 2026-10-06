const MAGIC = "\0webc003";
const INDEX_TAG = 2;
const ATOMS_TAG = 3;
const DIRECTORY_TAG = 30;
const FILE_TAG = 31;
const DIRECTORY_METADATA_BYTES = 3 * 8 + 32;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Return the bytes of one named atom from a WEBC v3 container.
 *
 * Callers verify the returned module against a pinned digest; this reader only
 * enforces the container layout and bounds.
 */
export function readWebcAtom(webc: Uint8Array, name: string): Uint8Array {
  if (webc.byteLength < MAGIC.length || decoder.decode(webc.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error("The package is not a WEBC v3 container.");
  }
  const view = new DataView(webc.buffer, webc.byteOffset, webc.byteLength);
  let offset = MAGIC.length;
  while (offset < webc.byteLength) {
    const tag = webc[offset]!;
    const headerBytes = tag === INDEX_TAG ? 1 + 8 : 1 + 32 + 8;
    const length = readLength(view, offset + headerBytes - 8);
    const start = offset + headerBytes;
    const end = checkedEnd(webc, start, length);
    if (tag === ATOMS_TAG) return findAtom(webc.subarray(start, end), name);
    offset = end;
  }
  throw new Error("The WEBC container has no atoms section.");
}

function findAtom(section: Uint8Array, name: string): Uint8Array {
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const headerLength = readLength(view, 0);
  const header = section.subarray(8, checkedEnd(section, 8, headerLength));
  const dataStart = 8 + headerLength;
  const data = section.subarray(dataStart + 8, checkedEnd(section, dataStart + 8, readLength(view, dataStart)));
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header[0] !== DIRECTORY_TAG) throw new Error("The WEBC atoms header has no root directory.");
  const entriesEnd = checkedEnd(header, 9, readLength(headerView, 1));
  let cursor = 9 + DIRECTORY_METADATA_BYTES;
  while (cursor < entriesEnd) {
    const entryOffset = readLength(headerView, cursor);
    const nameLength = readLength(headerView, cursor + 8 + 32);
    const nameStart = cursor + 8 + 32 + 8;
    const entryName = decoder.decode(header.subarray(nameStart, checkedEnd(header, nameStart, nameLength)));
    cursor = nameStart + nameLength;
    if (entryName !== name) continue;
    if (header[entryOffset] !== FILE_TAG) throw new Error(`WEBC atom '${name}' is not a file.`);
    const fileStart = readLength(headerView, entryOffset + 1);
    const fileEnd = readLength(headerView, entryOffset + 9);
    if (fileStart > fileEnd || fileEnd > data.byteLength) {
      throw new Error(`WEBC atom '${name}' lies outside its data section.`);
    }
    return data.subarray(fileStart, fileEnd);
  }
  throw new Error(`The WEBC container has no '${name}' atom.`);
}

function readLength(view: DataView, offset: number): number {
  if (offset < 0 || offset + 8 > view.byteLength) throw new Error("The WEBC container is truncated.");
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The WEBC container has an invalid length.");
  return Number(value);
}

function checkedEnd(bytes: Uint8Array, start: number, length: number): number {
  const end = start + length;
  if (end > bytes.byteLength) throw new Error("The WEBC container is truncated.");
  return end;
}
