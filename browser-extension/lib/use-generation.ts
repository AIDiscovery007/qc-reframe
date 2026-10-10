import { useEffect, useMemo, useSyncExternalStore } from "react";
import { request } from "./client";
import { createGenerationSession, generationReadiness, type GenerationCallbacks, type GenerationInput } from "./generation-session";
import type { Generation } from "./types";

export function useGeneration(input: GenerationInput & GenerationCallbacks & { generation?: Generation; compare?: boolean }) {
  const session = useMemo(() => createGenerationSession(input.job.id, request), [input.job.id]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => session.activate(), [session]);
  useEffect(() => session.loadImage(input.generation), [session, input.generation?.id, input.generation?.status, input.generation?.imageAsset]);
  useEffect(() => session.loadReference(input.compare ? input.generation : undefined), [session, input.compare, input.generation?.id]);
  return { ...state, ...generationReadiness(input), act: (cancel = false) => session.act(input, cancel, input), save: (generation: Generation) => session.save(generation, input) };
}
