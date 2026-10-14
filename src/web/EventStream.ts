/**
 * EventSource-shaped live updates over WebSocket. Upgraded connections do not
 * occupy HTTP/1's small per-host pool, so more tabs cannot starve API requests.
 */
export class EventStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = EventStream.CONNECTING;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private path: string,
    private retry = false,
  ) {
    this.connect();
  }

  private connect() {
    const url = new URL(this.path, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.readyState = EventStream.CONNECTING;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (!this.closed) this.readyState = EventStream.OPEN;
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      if (!this.closed) this.onmessage?.(event);
    };
    // Failed handshakes also emit close. Notify once, after the state changes.
    socket.onclose = () => {
      if (this.closed) return;
      this.readyState = this.retry
        ? EventStream.CONNECTING
        : EventStream.CLOSED;
      if (this.retry) this.timer = setTimeout(() => this.connect(), 1_000);
      this.onerror?.();
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.readyState = EventStream.CLOSED;
    this.socket?.close();
  }
}
