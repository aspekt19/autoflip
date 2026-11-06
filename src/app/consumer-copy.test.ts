import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BANNED = /\b(hackathon|bounty|judges?|openserv|gpt-[\w.-]*|serv_[a-z0-9_]+|kronos|multipath|shadow[\s_-]?agent|x402|gokite|kite|usdc|crypto|blockchain|web3|wallet)\b/i;

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (/\.(tsx|css)$/.test(entry)) found.push(full);
  }
  return found;
}

describe("consumer copy", () => {
  it("keeps payment-rail and contest words off the consumer UI", () => {
    const root = path.join(process.cwd(), "src/app");
    const offenders: string[] = [];
    for (const file of filesUnder(root)) {
      if (file.includes(`${path.sep}developers${path.sep}`)) continue;
      if (file.includes(`${path.sep}activity${path.sep}`)) continue;
      if (file.includes(`${path.sep}api${path.sep}`)) continue;
      const text = readFileSync(file, "utf8");
      if (BANNED.test(text)) offenders.push(path.relative(process.cwd(), file));
    }
    const components = filesUnder(path.join(process.cwd(), "src/components"));
    for (const file of components) {
      const text = readFileSync(file, "utf8");
      if (BANNED.test(text)) offenders.push(path.relative(process.cwd(), file));
    }
    expect(offenders).toEqual([]);
  });
});
