"use client";

import { useState, type FormEvent } from "react";

export function RunClarificationForm({ runId }: { runId: string }) {
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clarification = text.trim();
    if (!clarification) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/run/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarification }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setMessage(body.message || "That detail was not saved.");
        return;
      }
      setText("");
      setMessage("Saved. Run the search again to use this detail.");
    } catch {
      setMessage("That detail was not saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="field" data-owner-action="add-detail" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`run-detail-${runId}`}>Add a detail only you can save</label>
      <input
        id={`run-detail-${runId}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={500}
      />
      <div className="btn-row">
        <button className="action" type="submit" disabled={pending || text.trim().length < 2}>
          {pending ? "Saving…" : "Add a detail"}
        </button>
      </div>
      {message ? <p className="hint">{message}</p> : null}
    </form>
  );
}
