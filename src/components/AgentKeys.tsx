"use client";

import { useEffect, useState } from "react";

type KeyRow = { id: string; label: string; prefix: string; createdAt: string; revokedAt: string | null };

type BindingCard = {
  userId: string;
  apiKeyHash: string;
  keyId: string;
  keyPrefix: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
};

export function AgentKeys({ scoutEnabled = false }: { scoutEnabled?: boolean }) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [bindings, setBindings] = useState<BindingCard[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [label, setLabel] = useState("My agent");
  const [fresh, setFresh] = useState<string | null>(null);
  const [freshBinding, setFreshBinding] = useState<BindingCard | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/agents/keys");
    const body = (await response.json()) as {
      userId?: string;
      keys?: KeyRow[];
      bindings?: BindingCard[];
    };
    setUserId(body.userId ?? null);
    setKeys(body.keys ?? []);
    setBindings((body.bindings ?? []).filter((b) => !b.revokedAt));
  }

  useEffect(() => {
    void load().catch(() => setError("The key list did not load."));
  }, []);

  async function createKey() {
    setBusy(true);
    setError(null);
    setFresh(null);
    setFreshBinding(null);
    setCopied(null);
    const response = await fetch("/api/agents/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const body = (await response.json()) as {
      token?: string;
      binding?: BindingCard;
      message?: string;
    };
    setBusy(false);
    if (!response.ok || !body.token) {
      setError(body.message ?? "The key was not created.");
      return;
    }
    setFresh(body.token);
    setFreshBinding(body.binding ?? null);
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
    if (freshBinding?.keyId === id) {
      setFresh(null);
      setFreshBinding(null);
    }
    await load();
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("Could not copy — select the text manually.");
    }
  }

  function grantCardJson(binding: BindingCard): string {
    return JSON.stringify(
      {
        ownerUserId: binding.userId,
        apiKeyHash: binding.apiKeyHash,
        keyPrefix: binding.keyPrefix,
        keyId: binding.keyId,
        label: binding.label,
      },
      null,
      2,
    );
  }

  const liveBindings = freshBinding
    ? [freshBinding, ...bindings.filter((b) => b.keyId !== freshBinding.keyId)]
    : bindings;

  return (
    <section>
      <h2>Keys for this browser</h2>
      <p>
        The <code>af_</code> token is shown once and stays in this browser. Lemonless stores only a
        hash. A revoked key stops working immediately. Five live keys is the limit.
      </p>
      {userId ? (
        <p className="muted">
          Browser account id: <code>{userId}</code>
        </p>
      ) : null}
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
          Copy this key now for yourself. It will not be shown again. Do not paste it into chat.
          <br />
          <code>{fresh}</code>
          <br />
          <button
            className="quiet"
            type="button"
            disabled={busy}
            onClick={() => void copyText(fresh, "token")}
          >
            {copied === "token" ? "Copied token" : "Copy af_ token"}
          </button>
        </p>
      ) : null}

      {freshBinding || liveBindings.length ? (
        <div className="binding-section">
          <h3>Scout grant binding card</h3>
          <p>
            An operator grant needs <code>ownerUserId</code> and <code>apiKeyHash</code> — not the{" "}
            <code>af_</code> token. Copy the card below and send it only through a channel your
            operator trusts to identify you.
            {scoutEnabled ? (
              <>
                {" "}
                After the grant lands, open a signed Scout session on <a href="/scout">/scout</a> with the{" "}
                <code>af_</code> key in this browser.
              </>
            ) : (
              <> Scout is not available in this preview.</>
            )}
          </p>
          {(freshBinding ? [freshBinding] : liveBindings.slice(0, 1)).map((binding) => (
            <div key={binding.keyId} className="warn-box binding-card">
              <pre className="doc">{grantCardJson(binding)}</pre>
              <button
                className="quiet"
                type="button"
                disabled={busy}
                onClick={() => void copyText(grantCardJson(binding), `binding:${binding.keyId}`)}
              >
                {copied === `binding:${binding.keyId}` ? "Copied binding card" : "Copy binding card"}
              </button>
            </div>
          ))}
          {liveBindings.length > 1 ? (
            <ul className="key-list">
              {liveBindings.slice(1).map((binding) => (
                <li key={binding.keyId}>
                  <span>
                    {binding.label} · {binding.keyPrefix}… · hash {binding.apiKeyHash.slice(0, 12)}…
                  </span>
                  <button
                    className="quiet"
                    type="button"
                    disabled={busy}
                    onClick={() => void copyText(grantCardJson(binding), `binding:${binding.keyId}`)}
                  >
                    {copied === `binding:${binding.keyId}` ? "Copied" : "Copy card"}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
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
