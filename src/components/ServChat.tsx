"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ServChatMessage } from "@/domain/serv-chat";

export type ServChatDonePayload = {
  sessionId: string;
  messages: ServChatMessage[];
  result: Record<string, unknown>;
  charged: boolean;
  balance?: number | null;
};

type Props = {
  endpoint: string;
  initialMessage?: string | null;
  placeholder?: string;
  disabled?: boolean;
  onDone: (payload: ServChatDonePayload) => void;
  onError?: (message: string) => void;
};

/** One simple chat window with SERV. Code does not ask, parse, or gate on fields. */
export function ServChat({
  endpoint,
  initialMessage = null,
  placeholder = "Describe the car you need…",
  disabled = false,
  onDone,
  onError,
}: Props) {
  const [messages, setMessages] = useState<ServChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const bootstrapped = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  async function postTurn(opts: { message?: string; cont?: boolean; sid?: string | null }) {
    setPending(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 300_000);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: opts.sid ?? sessionId,
            message: opts.message ?? null,
            continue: opts.cont === true,
          }),
        });
      } finally {
        window.clearTimeout(timer);
      }
      const body = (await response.json()) as {
        ok?: boolean;
        status?: string;
        sessionId?: string;
        messages?: ServChatMessage[];
        message?: string;
        result?: Record<string, unknown>;
        charged?: boolean;
        balance?: number | null;
      };
      if (typeof body.sessionId === "string") setSessionId(body.sessionId);
      if (Array.isArray(body.messages)) setMessages(body.messages);

      if (!response.ok || body.ok === false) {
        const msg = body.message || "SERV could not continue this chat.";
        setError(msg);
        onError?.(msg);
        return;
      }

      if (body.status === "continue") {
        await postTurn({ cont: true, sid: body.sessionId ?? opts.sid ?? sessionId });
        return;
      }

      if (body.status === "done" && body.result) {
        onDone({
          sessionId: body.sessionId || sessionId || "",
          messages: Array.isArray(body.messages) ? body.messages : messages,
          result: body.result,
          charged: body.charged === true,
          balance: body.balance ?? null,
        });
      }
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "AbortError"
          ? "That chat turn timed out — try sending again."
          : "The chat request did not finish.";
      setError(msg);
      onError?.(msg);
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (bootstrapped.current) return;
    const seed = typeof initialMessage === "string" ? initialMessage.trim() : "";
    if (seed.length < 2) return;
    bootstrapped.current = true;
    setMessages([{ role: "user", content: seed }]);
    void postTurn({ message: seed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || disabled) return;
    const text = draft.trim();
    if (text.length < 1) return;
    setDraft("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    void postTurn({ message: text });
  }

  return (
    <div className="serv-chat panel" aria-label="Chat with SERV">
      <div className="serv-chat-log" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="hint">
            Tell SERV what you need in plain English. It will ask anything missing, then search.
          </p>
        ) : null}
        {messages.map((row, index) => (
          <div
            key={`${row.role}-${index}-${row.content.slice(0, 24)}`}
            className={
              row.role === "user"
                ? "serv-chat-bubble serv-chat-user"
                : row.role === "progress"
                  ? "serv-chat-bubble serv-chat-progress"
                  : "serv-chat-bubble serv-chat-assistant"
            }
          >
            <span className="serv-chat-who">
              {row.role === "user" ? "You" : row.role === "progress" ? "Progress" : "SERV"}
            </span>
            <p>{row.content}</p>
          </div>
        ))}
        {pending ? <p className="hint">SERV is working…</p> : null}
        <div ref={bottomRef} />
      </div>
      <form className="serv-chat-compose hero-chat" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="serv-chat-input">
          Message
        </label>
        <textarea
          id="serv-chat-input"
          rows={3}
          value={draft}
          disabled={pending || disabled}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
        />
        <div className="btn-row">
          <button className="action" type="submit" disabled={pending || disabled || draft.trim().length < 1}>
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
