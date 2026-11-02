/**
 * A Web Serial port with a receive buffer and frame-level reads with a
 * timeout. Shared by MSP (Betaflight) and the 4-way interface, because after
 * MSP_SET_PASSTHROUGH the same open port carries 4-way frames.
 */

export class SerialLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialLinkError';
  }
}

/** Result of a frame decoder: the frame value and how many buffer bytes it consumed, or null if incomplete. */
export type Decoded<T> = {value: T; consumed: number} | null;

/** Anything that can send bytes and wait for a decoded frame. Tests use a fake. */
export interface ByteLink {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  readFrame<T>(decode: (buf: Uint8Array) => Decoded<T>, timeoutMs: number, what: string): Promise<T>;
  /** Drop anything buffered (e.g. before switching protocol). */
  flush(): void;
}

const MAX_BUFFER = 8192;

export class SerialLink implements ByteLink {
  private buf = new Uint8Array(0);
  private readonly port: FlasherSerialPort;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  private constructor(
    port: FlasherSerialPort,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.port = port;
    this.reader = reader;
    this.writer = writer;
  }

  /** Ask the user to pick a serial port and open it. Must run inside a click handler. */
  static async request(baudRate: number): Promise<SerialLink> {
    const serial = navigator.serial;
    if (!serial) throw new SerialLinkError('This browser has no Web Serial.');
    const port = await serial.requestPort();
    await port.open({baudRate});
    if (!port.readable || !port.writable) throw new SerialLinkError('Serial port is not readable/writable.');
    return new SerialLink(port, port.readable.getReader(), port.writable.getWriter());
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.port.close().catch(() => {});
  }

  async write(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.writer.write(bytes);
  }

  flush(): void {
    this.buf = new Uint8Array(0);
  }

  async readFrame<T>(decode: (buf: Uint8Array) => Decoded<T>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = decode(this.buf);
      if (hit) {
        this.buf = this.buf.slice(hit.consumed);
        return hit.value;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SerialLinkError(`No reply (${what}).`);
      // Keep one read outstanding across timeouts so no bytes are lost.
      this.pending ??= this.reader.read();
      const chunk = await Promise.race([this.pending, new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (chunk === null) continue;
      this.pending = null;
      if (chunk.done) throw new SerialLinkError('Serial port closed.');
      const next = new Uint8Array(this.buf.length + chunk.value.length);
      next.set(this.buf);
      next.set(chunk.value, this.buf.length);
      this.buf = next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
    }
  }
}
