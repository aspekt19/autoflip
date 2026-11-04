import { TtlCache } from "@/io/cache";
import { counterStore } from "@/io/store";

const globalCache = globalThis as unknown as { __autoflipCache?: TtlCache<unknown> };

export function listingCache(): TtlCache<unknown> {
  if (!globalCache.__autoflipCache) globalCache.__autoflipCache = new TtlCache();
  return globalCache.__autoflipCache;
}

export function runtimeDeps() {
  const autodevKey = process.env.AUTODEV_API_KEY?.trim() || undefined;
  const servKey = process.env.SERV_API_KEY?.trim() || undefined;
  return {
    autodevKey,
    servKey,
    servModel: process.env.SERV_MODEL,
    servBaseUrl: process.env.SERV_BASE_URL,
    autodev: autodevKey ? { cache: listingCache(), counter: counterStore() } : undefined,
  };
}
