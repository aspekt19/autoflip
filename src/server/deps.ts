import { TtlCache } from "@/io/cache";
import { counterStore } from "@/io/store";
import { getKv } from "@/io/kv";
import { reserveTotalCall } from "@/io/persistent-quota";

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
    /** Override BASE_MODEL. Empty/unset → profile default via runServ. */
    servModel: process.env.SERV_MODEL?.trim() || undefined,
    servBaseUrl: process.env.SERV_BASE_URL,
    autodev: autodevKey
      ? { cache: listingCache(), counter: counterStore(), reserve: () => reserveTotalCall(getKv()) }
      : undefined,
  };
}
