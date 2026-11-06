"use client";

import { useEffect, useState } from "react";

type KeyRow = { id: string; label: string; prefix: string; createdAt: string; revokedAt: string | null };

export function AgentKeys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [label, setLabel] = useState("My agent");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/agents/keys");
    const body = (await response.json()) as { keys?: KeyRow[] };
    setKeys(body.keys ?? []);
  }

  useEffect(() => {
    void load().catch(() => setError("The key list did not load."));
  }, []);

  async function createKey() {
    setBusy(true);
    setError(null);
    setFresh(null);
    const response = await fetch("/api/agents/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const body = (await response.json()) as { token?: string; message?: string };
    setBusy(false);
    if (!response.ok || !body.token) {
      setError(body.message ?? "The key was not created.");
      return;
    }
    setFresh(body.token);
    await load();
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/agents/keys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json()) as { message?: string };
      setError(body.message ?? "The key was not revoked.");
      return;
    }
    await load();
  }

  return (
    <section>
      <h2>Keys for this browser</h2>
      <p>The key is shown once. Lemonless stores only a hash. A revoked key stops working immediately. Five live keys is the limit.</p>
      <div className="key-create">
        <label>
          Label
          <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} />
        </label>
        <button className="action" type="button" disabled={busy} onClick={() => void createKey()}>
          Create key
        </button>
      </div>
      {fresh ? (
        <p className="warn-box">
          Copy this key now. It will not be shown again.
          <br />
          <code>{fresh}</code>
        </p>
      ) : null}
      {error ? <p className="warn-box">{error}</p> : null}
      <ul className="key-list">
        {keys.map((key) => (
          <li key={key.id}>
            <span>
              {key.label} · {key.prefix}… · {key.revokedAt ? "Revoked" : "Live"}
            </span>
            {key.revokedAt ? null : (
              <button className="quiet" type="button" disabled={busy} onClick={() => void revoke(key.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
