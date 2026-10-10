import { requestedImageSize, validImageSizeRequest } from "./image-size.mjs";
import type { AspectRatio, Generation, ImageSize, Job, MultiSubject } from "./types";

export type GenerationInput = {
  job: Job; lang: "zh" | "en"; disabled: boolean; subjectImage?: string; subjects?: MultiSubject[];
  aspectRatio?: AspectRatio; imageSize?: ImageSize; pixelSize?: boolean; allowMulti?: boolean; requestPending?: boolean;
};
export type GenerationCallbacks = {
  // Data and originating drawer settlement survive navigation; view selection does not.
  onUpdate(job: Job, subjectImage?: string, subjects?: MultiSubject[]): void;
  onViewUpdate?(): void;
  onRequestState?(pending: boolean, error?: string): void;
};
type Asset = { key: string; image: string; path?: string; width?: number; height?: number };
type Reference = { key: string; image: string; subjects?: MultiSubject[]; referenceIndex?: number };
type Snapshot = {
  busy: boolean; submitting: boolean; error: string;
  asset?: Asset; imageError: string; original?: Reference; comparisonError: string;
};
type Request = <T>(message: Record<string, unknown>) => Promise<T>;

export const validGenerationRatio = (ratio?: AspectRatio) => ratio === undefined || !!ratio && typeof ratio === "object" && !Array.isArray(ratio) && Object.keys(ratio).every(key => key === "width" || key === "height") && [ratio.width, ratio.height].every(value => Number.isInteger(value) && value >= 1 && value <= 10000)
  && ratio.width / ratio.height >= 1 / 20 && ratio.width / ratio.height <= 20;

export function generationReadiness({ job, lang, disabled, subjectImage, subjects, aspectRatio, imageSize, pixelSize = false, allowMulti = true, requestPending }: GenerationInput) {
  const running = job.generations?.find(item => item.status === "running");
  const recovery = job.generations?.find(item => item.resultSavePending);
  const multi = job.mode === "multi-reenact";
  const inputsReady = job.mode === "recreate" || job.mode === "session" || (multi
    ? !!subjects && subjects.length >= 2 && subjects.length <= 6 && subjects.every(item => !!item.subjectImage)
    : !!subjectImage);
  const generic = job.mode === "style" && !job.reenact;
  const incomplete = /\[SUBJECT\]/i.test((lang === "zh" ? job.result?.promptZh : job.result?.promptEn) || "");
  const validRatio = validGenerationRatio(aspectRatio);
  const validSize = pixelSize ? aspectRatio === undefined && validImageSizeRequest(imageSize) : imageSize === undefined && validRatio;
  return { running, recovery, multi, inputsReady, generic, incomplete, validRatio, validSize,
    canGenerate: !!job.result && job.autoGeneration?.status !== "pending" && !disabled && !requestPending && !running && !recovery && inputsReady && !generic && !incomplete && validSize && (allowMulti || !multi) };
}

// One mounted prompt version owns its reads and view state. Submission callbacks
// remain bound to that version after navigation, so its pending drawer can settle.
export function createGenerationSession(jobId: string, request: Request) {
  let state: Snapshot = { busy: false, submitting: false, error: "", imageError: "", comparisonError: "" };
  let active = true, lifecycle = 0, imageRead = 0, referenceRead = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<Snapshot>) => {
    state = { ...state, ...patch };
    if (active) listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      active = true;
      return () => { active = false; lifecycle++; imageRead++; referenceRead++; };
    },
    async act(input: GenerationInput, cancel: boolean, callbacks: GenerationCallbacks) {
      const readiness = generationReadiness(input);
      if (!active || input.job.id !== jobId || state.busy || input.requestPending || (cancel ? !readiness.running : !readiness.canGenerate)) return false;
      const epoch = lifecycle;
      const subjectImage = !cancel && input.job.mode !== "recreate" && input.job.mode !== "session" ? input.subjectImage : undefined;
      const subjects = !cancel && readiness.multi ? input.subjects?.map(subject => ({ ...subject })) : undefined;
      const imageSize = input.pixelSize ? requestedImageSize(input.imageSize) : undefined;
      const message = cancel ? { type: "alchemy:generation-cancel", id: jobId, generationId: readiness.running!.id }
        : { type: "alchemy:generate", id: jobId, language: input.lang,
          ...(input.aspectRatio ? { aspectRatio: { ...input.aspectRatio } } : {}),
          ...(imageSize ? { imageSize } : {}),
          ...(readiness.multi ? { subjects } : subjectImage !== undefined ? { subjectImage } : {}) };
      update({ busy: true, submitting: !cancel, error: "" });
      let failure = "";
      try {
        if (!cancel) callbacks.onRequestState?.(true);
        const job = await request<Job>(message);
        callbacks.onUpdate(job, subjectImage, subjects);
        if (active && epoch === lifecycle) callbacks.onViewUpdate?.();
        return active && epoch === lifecycle;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        if (active && epoch === lifecycle) update({ error: failure });
        return false;
      } finally {
        update({ busy: false, submitting: false });
        if (!cancel) callbacks.onRequestState?.(false, failure);
      }
    },
    async save(generation: Generation, callbacks: GenerationCallbacks) {
      if (!active || state.busy || !generation.resultSavePending) return false;
      const epoch = lifecycle;
      update({ busy: true, error: "" });
      try {
        const job = await request<Job>({ type: "alchemy:save-generation", jobId, generationId: generation.id });
        callbacks.onUpdate(job);
        if (active && epoch === lifecycle) callbacks.onViewUpdate?.();
        return active && epoch === lifecycle;
      } catch (error) {
        if (active && epoch === lifecycle) update({ error: error instanceof Error ? error.message : String(error) });
        return false;
      } finally { update({ busy: false }); }
    },
    loadImage(generation?: Generation) {
      const revision = ++imageRead;
      update({ asset: undefined, imageError: "" });
      if (generation?.status === "completed") void request<Omit<Asset, "key">>({ type: "alchemy:generation-image", id: jobId, generationId: generation.id }).then(
        asset => { if (active && revision === imageRead) update({ asset: { ...asset, key: `${jobId}:${generation.id}` } }); },
        error => { if (active && revision === imageRead) update({ imageError: error.message }); },
      );
      return () => { if (revision === imageRead) imageRead++; };
    },
    loadReference(generation?: Generation) {
      const revision = ++referenceRead;
      update({ original: undefined, comparisonError: "" });
      if (generation) void request<Omit<Reference, "key">>({ type: "alchemy:generation-reference", id: jobId, generationId: generation.id }).then(
        original => { if (active && revision === referenceRead) update({ original: { ...original, key: `${jobId}:${generation.id}` } }); },
        error => { if (active && revision === referenceRead) update({ comparisonError: error.message }); },
      );
      return () => { if (revision === referenceRead) referenceRead++; };
    },
  };
}
