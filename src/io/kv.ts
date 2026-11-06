import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store";

export type KvBackend = "upstash" | "file" | "memory";

export type SetNxOptions = {
  /**
   * Credit-lock style TTL. When omitted, SET NX is durable (monthly counters / data).
   * Never use TTL for quota scalars — PX expiry resets the monthly cap.
   */
  ttlMs?: number;
};

export interface Kv {
  /** Actual backend identity — do not infer solely from env when deciding spend safety. */
  readonly backend: KvBackend;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Set only when absent. Pass ttlMs for short locks; omit for durable data. */
  setNx(key: string, value: string, opts?: SetNxOptions): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Atomically increment an integer key and return the new value.
   * Upstash: Redis INCR (cross-instance). Memory/File: in-process only —
   * not a multi-instance guarantee. Rejects corrupt/non-integer values.
   */
  incr(key: string): Promise<number>;
  /** Atomically decrement; only for confirmed pre-dispatch reservation rollback / cache-hit refund. */
  decr(key: string): Promise<number>;
}

function parseIntegerOrThrow(raw: string | undefined, key: string): number {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Corrupt integer counter for ${key}`);
  }
  return n;
}

export class MemoryKv implements Kv {
  readonly backend = "memory" as const;
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
  setNx(key: string, value: string, _opts?: SetNxOptions): Promise<boolean> {
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
      const next = parseIntegerOrThrow(this.map.get(key), key) + 1;
      this.map.set(key, String(next));
      return next;
    });
  }
  decr(key: string): Promise<number> {
    return this.enqueue(() => {
      const next = parseIntegerOrThrow(this.map.get(key), key) - 1;
      this.map.set(key, String(next));
      return next;
    });
  }
}

export class FileKv implements Kv {
  readonly backend = "file" as const;
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

  async setNx(key: string, value: string, _opts?: SetNxOptions): Promise<boolean> {
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
      const next = parseIntegerOrThrow(data[key], key) + 1;
      data[key] = String(next);
      this.write(data);
      return next;
    });
  }

  async decr(key: string): Promise<number> {
    return this.enqueue(() => {
      const data = this.read();
      const next = parseIntegerOrThrow(data[key], key) - 1;
      data[key] = String(next);
      this.write(data);
      return next;
    });
  }
}

/** Records Redis commands for offline Upstash semantics tests (not a hosted proof). */
export type UpstashCommandLog = string[][];

export class UpstashKv implements Kv {
  readonly backend = "upstash" as const;
  readonly commands: UpstashCommandLog = [];

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async command(args: string[]): Promise<unknown> {
    this.commands.push([...args]);
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

  async setNx(key: string, value: string, opts?: SetNxOptions): Promise<boolean> {
    // Durable data must NOT use PX — credit locks pass ttlMs explicitly.
    const args =
      opts?.ttlMs != null && opts.ttlMs > 0
        ? ["SET", key, value, "NX", "PX", String(Math.floor(opts.ttlMs))]
        : ["SET", key, value, "NX"];
    const result = await this.command(args);
    return result === "OK";
  }

  async delete(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  async incr(key: string): Promise<number> {
    const result = await this.command(["INCR", key]);
    if (typeof result === "number" && Number.isInteger(result)) return result;
    if (typeof result === "string" && Number.isInteger(Number(result))) return Number(result);
    throw new Error("Upstash INCR returned a non-integer");
  }

  async decr(key: string): Promise<number> {
    const result = await this.command(["DECR", key]);
    if (typeof result === "number" && Number.isInteger(result)) return result;
    if (typeof result === "string" && Number.isInteger(Number(result))) return Number(result);
    throw new Error("Upstash DECR returned a non-integer");
  }
}

export type StorageMode = "upstash" | "file" | "unconfigured";

export function storageMode(env: Record<string, string | undefined> = process.env): StorageMode {
  if (env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim()) return "upstash";
  if (env.VERCEL) return "unconfigured";
  return "file";
}

/**
 * Identity of the Kv instance actually in hand.
 * Vercel without Upstash yields Memory — that is NOT a shared monthly store.
 */
export function kvBackendOf(kv: Kv): KvBackend {
  return kv.backend;
}

export function isDistributedQuotaBackend(kv: Kv): boolean {
  return kv.backend === "upstash";
}

const globalKv = globalThis as unknown as { __autoflipKv?: Kv; __autoflipKvMode?: string };

export function getKv(): Kv {
  const mode = storageMode();
  const stamp = `${mode}:${process.env.UPSTASH_REDIS_REST_URL ?? ""}:${process.env.AUTOFLIP_DATA_DIR ?? ""}`;
  if (!globalKv.__autoflipKv || globalKv.__autoflipKvMode !== stamp) {
    if (mode === "upstash") {
      globalKv.__autoflipKv = new UpstashKv(
        process.env.UPSTASH_REDIS_REST_URL!.trim(),
        process.env.UPSTASH_REDIS_REST_TOKEN!.trim(),
      );
    } else if (mode === "file") {
      globalKv.__autoflipKv = new FileKv(path.join(dataDir(), "kv.json"));
    } else {
      // Vercel unconfigured → per-instance Memory. Not shared. Spend paths must fail closed.
      globalKv.__autoflipKv = new MemoryKv();
    }
    globalKv.__autoflipKvMode = stamp;
  }
  return globalKv.__autoflipKv;
}
