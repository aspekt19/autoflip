// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ServChat } from "./ServChat";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["/api/find/chat", "/api/resale/chat"])("%s pending composer", (endpoint) => {
  it("hides the message box through agent continuation and restores it when SERV asks the shopper", async () => {
    const pendingResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pendingResponses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ServChat endpoint={endpoint} onDone={vi.fn()} />);

    await user.type(screen.getByLabelText("Message"), "Find me a reliable AWD SUV under $20k.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("SERV is working");
    expect(screen.getByText(/message box will return when SERV needs your input/i)).toBeInTheDocument();

    await act(async () => {
      pendingResponses[0](
        Response.json({
          ok: true,
          status: "continue",
          sessionId: "session-1",
          messages: [{ role: "user", content: "Find me a reliable AWD SUV under $20k." }],
        }),
      );
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      pendingResponses[1](
        Response.json({
          ok: true,
          status: "ask",
          sessionId: "session-1",
          question: "Which ZIP code should I search near?",
          messages: [
            { role: "user", content: "Find me a reliable AWD SUV under $20k." },
            { role: "assistant", content: "Which ZIP code should I search near?" },
          ],
        }),
      );
    });

    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
    expect(screen.getByText("Which ZIP code should I search near?")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
