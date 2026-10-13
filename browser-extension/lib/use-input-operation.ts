import { useEffect, useRef, useState } from "react";

export function useInputOperation(contextKey: string, disabled: boolean, onAvailability: (available: boolean) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const pendingInput = useRef(false);
  const revision = useRef(0);
  const scope = useRef(contextKey);
  scope.current = contextKey;

  useEffect(() => {
    setPending(false); setError("");
    // Capture this context's availability callback; a later render may belong to another project.
    return () => { revision.current++; pendingInput.current = false; onAvailability(true); };
  }, [contextKey]);

  const run = async (save: (current: () => boolean) => void | Promise<void>, {
    onSaved, rethrow = false, availability = "operation",
  }: { onSaved?: () => void; rethrow?: boolean; availability?: "operation" | "app" } = {}) => {
    if (disabled || pendingInput.current) return false;
    const attempt = ++revision.current, context = contextKey;
    const current = () => attempt === revision.current && context === scope.current;
    pendingInput.current = true;
    setPending(true); setError("");
    if (availability === "operation") onAvailability(false);
    let saved = false;
    try {
      await save(current);
      if (!current()) return false;
      saved = true;
      onSaved?.();
      return true;
    } catch (reason) {
      if (current()) setError((reason as Error).message);
      if (rethrow) throw reason;
      return false;
    } finally {
      if (current()) {
        pendingInput.current = false; setPending(false);
        if (availability === "operation") onAvailability(saved);
      }
    }
  };

  return { pending, error, setError, run };
}
