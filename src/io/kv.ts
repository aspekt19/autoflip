import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store";

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryKv implements Kv {
  private readonly map = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

export class FileKv implements Kv {
  constructor(private readonly file: string) {}

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
    const data = this.read();
    data[key] = value;
    this.write(data);
  }

  async delete(key: string): Promise<void> {
    const data = this.read();
    delete data[key];
    this.write(data);
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
      signal: AbortSignal.timeout(10_000),
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

  async delete(key: string): Promise<void> {
    await this.command(["DEL", key]);
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
