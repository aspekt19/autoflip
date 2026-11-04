import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FullReport } from "@/domain/types";
import { MemoryCounter, type MonthlyCounter } from "./quota";

export function dataDir(): string {
  if (process.env.AUTOFLIP_DATA_DIR) return process.env.AUTOFLIP_DATA_DIR;
  if (process.env.VERCEL) return path.join(os.tmpdir(), "autoflip");
  return path.join(process.cwd(), ".data");
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export class FileCounter implements MonthlyCounter {
  constructor(private readonly file: string) {}

  private read(): Record<string, number> {
    return readJson(this.file, {});
  }

  get(month: string): number {
    return this.read()[month] ?? 0;
  }

  increment(month: string): number {
    const data = this.read();
    const next = (data[month] ?? 0) + 1;
    data[month] = next;
    writeJson(this.file, data);
    return next;
  }
}

type Ledger = {
  balances: Record<string, number>;
  events: Record<string, true>;
  initialized: Record<string, true>;
};

export class CreditLedger {
  constructor(private readonly file: string) {}

  private read(): Ledger {
    return readJson(this.file, { balances: {}, events: {}, initialized: {} });
  }

  balance(userId: string): number {
    return this.read().balances[userId] ?? 0;
  }

  seen(userId: string): boolean {
    return Boolean(this.read().initialized[userId]);
  }

  grant(userId: string, credits: number, idempotencyKey: string): number {
    const ledger = this.read();
    ledger.initialized[userId] = true;
    if (ledger.events[idempotencyKey]) {
      writeJson(this.file, ledger);
      return ledger.balances[userId] ?? 0;
    }
    ledger.events[idempotencyKey] = true;
    ledger.balances[userId] = (ledger.balances[userId] ?? 0) + credits;
    writeJson(this.file, ledger);
    return ledger.balances[userId] ?? 0;
  }

  spend(userId: string, idempotencyKey: string): { ok: boolean; balance: number } {
    const ledger = this.read();
    ledger.initialized[userId] = true;
    if (ledger.events[idempotencyKey]) {
      return { ok: true, balance: ledger.balances[userId] ?? 0 };
    }
    const balance = ledger.balances[userId] ?? 0;
    if (balance < 1) return { ok: false, balance };
    ledger.events[idempotencyKey] = true;
    ledger.balances[userId] = balance - 1;
    writeJson(this.file, ledger);
    return { ok: true, balance: balance - 1 };
  }
}

export function saveReport(report: FullReport, dir = dataDir()): void {
  const folder = path.join(dir, "reports");
  ensureDir(folder);
  writeJson(path.join(folder, `${report.id}.json`), report);
}

export function loadReport(id: string, dir = dataDir()): FullReport | null {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return null;
  const file = path.join(dir, "reports", `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson<FullReport | null>(file, null);
}

const globalStore = globalThis as unknown as {
  __autoflipCounter?: MonthlyCounter;
  __autoflipLedger?: CreditLedger;
  __autoflipDir?: string;
};

export function counterStore(): MonthlyCounter {
  if (process.env.AUTOFLIP_COUNTER === "memory") {
    if (!globalStore.__autoflipCounter) globalStore.__autoflipCounter = new MemoryCounter();
    return globalStore.__autoflipCounter;
  }
  const dir = dataDir();
  if (!globalStore.__autoflipCounter || globalStore.__autoflipDir !== dir) {
    ensureDir(dir);
    globalStore.__autoflipCounter = new FileCounter(path.join(dir, "quota.json"));
    globalStore.__autoflipDir = dir;
  }
  return globalStore.__autoflipCounter;
}

export function creditStore(): CreditLedger {
  const dir = dataDir();
  if (!globalStore.__autoflipLedger || globalStore.__autoflipDir !== dir) {
    ensureDir(dir);
    globalStore.__autoflipLedger = new CreditLedger(path.join(dir, "credits.json"));
  }
  return globalStore.__autoflipLedger;
}
