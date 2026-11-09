# Live SERV revision recordings

Place `verdict-revision.latest.json` here after running:

```bash
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:record-serv-revision
```

Required schema: `lemonless.serv_revision_recording.v1` (see `src/server/serv-revision-recording.ts`).
Without this file, `/report/sample` does not invent a revision trail.
