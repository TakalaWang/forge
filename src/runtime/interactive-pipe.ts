/** One direction of an interactive session: a single-producer, single-consumer byte ring in shared memory. */
export const INTERACTIVE_PIPE_CAPACITY_BYTES = 64 * 1024;

const READ = 0;
const WRITE = 1;
const WRITER_CLOSED = 2;
const READER_CLOSED = 3;
const SEQUENCE = 4;
const HEADER_BYTES = 32;

/**
 * The smallest ring that holds a writer's whole output budget. Only budgeted stdout bytes enter
 * the pipe, so a write never blocks before the budget is spent, as on the server's unbounded pipe.
 */
export function interactivePipeCapacity(outputLimitBytes: number): number {
  let capacity = INTERACTIVE_PIPE_CAPACITY_BYTES;
  while (capacity < outputLimitBytes && capacity < 2 ** 30) capacity *= 2;
  return capacity;
}

export function createInteractivePipe(capacity = INTERACTIVE_PIPE_CAPACITY_BYTES): SharedArrayBuffer {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || (capacity & (capacity - 1)) !== 0 || capacity > 2 ** 30) {
    throw new Error("Interactive pipe capacity must be a power of two up to 1 GiB.");
  }
  return new SharedArrayBuffer(HEADER_BYTES + capacity);
}

class InteractivePipeEnd {
  protected readonly header: Int32Array;
  protected readonly data: Uint8Array;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.data = new Uint8Array(buffer, HEADER_BYTES);
  }

  protected buffered(): number {
    return (Atomics.load(this.header, WRITE) - Atomics.load(this.header, READ)) >>> 0;
  }

  protected signal(index: number, value: number): void {
    Atomics.store(this.header, index, value);
    Atomics.add(this.header, SEQUENCE, 1);
    Atomics.notify(this.header, SEQUENCE);
  }

  protected sequence(): number {
    return Atomics.load(this.header, SEQUENCE);
  }

  protected sleep(sequence: number): void {
    Atomics.wait(this.header, SEQUENCE, sequence);
  }
}

export class InteractivePipeReader extends InteractivePipeEnd {
  /** Returns the buffered count, 0 at EOF, or -1 while the pipe is empty and the writer is open. */
  poll(): number {
    const buffered = this.buffered();
    if (buffered > 0) return buffered;
    if (Atomics.load(this.header, WRITER_CLOSED) === 0) return -1;
    return this.buffered();
  }

  /** Blocks until bytes are buffered or the writer closed; returns the buffered count, or 0 at EOF. */
  wait(): number {
    for (;;) {
      const sequence = this.sequence();
      const available = this.poll();
      if (available >= 0) return available;
      this.sleep(sequence);
    }
  }

  /** Blocks like `wait`, then consumes up to `maximum` bytes. An empty result means EOF. */
  read(maximum: number): Uint8Array {
    const buffered = this.wait();
    const count = Math.min(buffered, maximum);
    const output = new Uint8Array(count);
    if (count === 0) return output;
    const read = Atomics.load(this.header, READ);
    const start = (read >>> 0) % this.data.length;
    const first = Math.min(count, this.data.length - start);
    output.set(this.data.subarray(start, start + first));
    output.set(this.data.subarray(0, count - first), first);
    this.signal(READ, (read + count) | 0);
    return output;
  }

  close(): void {
    this.signal(READER_CLOSED, 1);
  }
}

export class InteractivePipeWriter extends InteractivePipeEnd {
  /** Blocks until every byte is buffered. Returns the count written, or -1 if the reader closed before it finished. */
  write(bytes: Uint8Array): number {
    let offset = 0;
    while (offset < bytes.length) {
      const sequence = this.sequence();
      if (Atomics.load(this.header, READER_CLOSED) !== 0) return -1;
      const free = this.data.length - this.buffered();
      if (free === 0) {
        this.sleep(sequence);
        continue;
      }
      const count = Math.min(free, bytes.length - offset);
      const write = Atomics.load(this.header, WRITE);
      const start = (write >>> 0) % this.data.length;
      const first = Math.min(count, this.data.length - start);
      this.data.set(bytes.subarray(offset, offset + first), start);
      this.data.set(bytes.subarray(offset + first, offset + count), 0);
      this.signal(WRITE, (write + count) | 0);
      offset += count;
    }
    return offset;
  }

  close(): void {
    this.signal(WRITER_CLOSED, 1);
  }
}
