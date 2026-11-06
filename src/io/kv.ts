import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store";

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Set only when the key is absent. Used so a credit spend cannot run twice at once. */
  setNx(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Atomically increment an integer key and return the new value.
   * Upstash: Redis INCR (cross-instance). Memory/File: in-process serialization only —
   * not a multi-instance guarantee.
   */
  incr(key: string): Promise<number>;
  /** Atomically decrement; used only to roll back a reservation before provider dispatch. */
  decr(key: string): Promise<number>;
}

export class MemoryKv implements Kv {
  private readonly map = new Map<string, string>();
  /** Serialize incr/setNx mutations so parallel awaits cannot lose updates in-process. */
  private tail: Promise<unknown> = Promise.resolve();

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  setNx(key: string, value: string): Promise<boolean> {
    return this.enqueue(() => {
      if (this.map.has(key)) return false;
      this.map.set(key, value);
      return true;
    });
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  incr(key: string): Promise<number> {
    return this.enqueue(() => {
      const next = Number(this.map.get(key) ?? "0") + 1;
      this.map.set(key, String(next));
      return next;
    });
  }
  decr(key: string): Promise<number> {
    return this.enqueue(() => {
      const next = Number(this.map.get(key) ?? "0") - 1;
      this.map.set(key, String(next));
      return next;
    });
  }
}

export class FileKv implements Kv {
  constructor(private readonly file: string) {}

  /** Per-file chain — single process only; not cross-host. */
  private static chains = new Map<string, Promise<unknown>>();

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = FileKv.chains.get(this.file) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    FileKv.chains.set(
      this.file,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  async get(key: string): Promise<string | null> {
    return this.read()[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.enqueue(() => {
      const data = this.read();
      data[key] = value;
      this.write(data);
    });
  }

  async setNx(key: string, value: string): Promise<boolean> {
    return this.enqueue(() => {
      const data = this.read();
      if (key in data) return false;
      data[key] = value;
      this.write(data);
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(() => {
      const data = this.read();
      delete data[key];
      this.write(data);
    });
  }

  async incr(key: string): Promise<number> {
    return this.enqueue(() => {
      const data = this.read();
      const next = Number(data[key] ?? "0") + 1;
      data[key] = String(next);
      this.write(data);
      return next;
    });
  }

  async decr(key: string): Promise<number> {
    return this.enqueue(() => {
      const data = this.read();
      const next = Number(data[key] ?? "0") - 1;
      data[key] = String(next);
      this.write(data);
      return next;
    });
  }
}

export class UpstashKv implements Kv {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async command(args: string[]): Promise<unknown> {
    const response = await this.fetchImpl(this.baseUrl.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Persistent store returned ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(body.error);
    return body.result ?? null;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.command(["SET", key, value]);
  }

  async setNx(key: string, value: string): Promise<boolean> {
    const result = await this.command(["SET", key, value, "NX", "PX", "4000"]);
    return result === "OK";
  }

  async delete(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  /** Cross-instance atomic increment via Redis INCR. */
  async incr(key: string): Promise<number> {
    const result = await this.command(["INCR", key]);
    if (typeof result === "number" && Number.isFinite(result)) return result;
    if (typeof result === "string" && Number.isFinite(Number(result))) return Number(result);
    throw new Error("Upstash INCR returned a non-integer");
  }

  async decr(key: string): Promise<number> {
    const result = await this.command(["DECR", key]);
    if (typeof result === "number" && Number.isFinite(result)) return result;
    if (typeof result === "string" && Number.isFinite(Number(result))) return Number(result);
    throw new Error("Upstash DECR returned a non-integer");
  }
}

export type StorageMode = "upstash" | "file" | "unconfigured";

export function storageMode(env: Record<string, string | undefined> = process.env): StorageMode {
  if (env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim()) return "upstash";
  if (env.VERCEL) return "unconfigured";
  return "file";
}

const globalKv = globalThis as unknown as { __autoflipKv?: Kv; __autoflipKvMode?: string };

export function getKv(): Kv {
  const mode = storageMode();
  const stamp = `${mode}:${process.env.UPSTASH_REDIS_REST_URL ?? ""}:${process.env.AUTOFLIP_DATA_DIR ?? ""}`;
  if (!globalKv.__autoflipKv || globalKv.__autoflipKvMode !== stamp) {
    if (mode === "upstash") {
      globalKv.__autoflipKv = new UpstashKv(process.env.UPSTASH_REDIS_REST_URL!.trim(), process.env.UPSTASH_REDIS_REST_TOKEN!.trim());
    } else if (mode === "file") {
      globalKv.__autoflipKv = new FileKv(path.join(dataDir(), "kv.json"));
    } else {
      globalKv.__autoflipKv = new MemoryKv();
    }
    globalKv.__autoflipKvMode = stamp;
  }
  return globalKv.__autoflipKv;
}
