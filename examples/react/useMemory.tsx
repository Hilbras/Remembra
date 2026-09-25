/**
 * React example: a hook that reads and writes memories through your own API.
 *
 * The browser never talks to Remembra directly and never holds an API key; it
 * calls the server route from the Next.js example, which holds the key.
 */
import { useCallback, useEffect, useState } from "react";

/** The endpoint this component expects, served by the Next.js example. */
export const MEMORY_ENDPOINT = "/api/memory";

export function useMemory(text: string) {
  const [stored, setStored] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const remember = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(MEMORY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await response.json()) as { id?: string; code?: string };
      if (!response.ok || !body.id) throw new Error(body.code ?? "REQUEST_FAILED");
      setStored(body.id);
    } catch (cause) {
      // Show a stable code, not a raw server or provider message.
      setError(cause instanceof Error ? cause.message : "REQUEST_FAILED");
    } finally {
      setPending(false);
    }
  }, [text]);

  useEffect(() => {
    setStored(null);
  }, [text]);

  return { remember, stored, error, pending };
}

export function RememberButton({ text }: { text: string }) {
  const { remember, stored, error, pending } = useMemory(text);
  return (
    <div>
      <button onClick={remember} disabled={pending || text.length === 0}>
        {pending ? "Remembering…" : "Remember this"}
      </button>
      {stored ? <p>Remembered as {stored}</p> : null}
      {error ? <p role="alert">Could not remember: {error}</p> : null}
    </div>
  );
}
