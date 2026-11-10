# Listing URL fetch probe

Offline (manual) check of which major US listing sites our server-side fetcher can read today.

Many aggregators return **403 / bot walls** to datacenter IPs. This fixture set + script records the truth — it is **not** part of CI.

## Run

```bash
npm run probe:listing-fetch
```

Writes measured rows into `probe-results.json` (status code, bytes, blocked flag, extracted fields summary). Until you run it, that file stays `status: "not_yet_run"`.

## Files

| File | Role |
| --- | --- |
| `sites.json` | Curated real public listing / VDP URLs |
| `probe-results.json` | Output of the last probe (empty until run) |
