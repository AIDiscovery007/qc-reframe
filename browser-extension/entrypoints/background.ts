import { openWorkspace } from "../lib/workspace-navigation";
import { startReminderService } from "../lib/reminder-background";
import { browser } from "wxt/browser";
import { bridge } from "../lib/bridge";
import { operationFor, allowsOperation, messageSource, PORT_KEEP_ALIVE } from "../lib/operation-policy";
import { captureImage } from "../lib/capture";
import type {
  ImageTarget,
  AspectRatio,
  CollectionResult,
  Job,
  Mode,
  MultiSubject,
  Preferences,
  Project,
  SubjectInput,
  Selection,
} from "../lib/types";

const modes = ["style", "recreate", "reenact", "multi-reenact", "session"];
const subjectRoles = ["自动", "人物", "物品", "服饰", "场景", "细节"];
const validSubjectImage = (image: unknown) => {
  if (typeof image !== "string" || image.length > 3 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return false;
  const data = image.slice(image.indexOf(",") + 1);
  return data.length % 4 === 0 && data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) <= 2 * 1024 * 1024;
};
const validSubjects = (subjects: unknown, minimum = 2): subjects is MultiSubject[] => Array.isArray(subjects)
  && subjects.length >= minimum && subjects.length <= 6
  && subjects.every(subject => subject && typeof subject === "object" && !Array.isArray(subject)
    && typeof subject.id === "string" && /^[\w-]{1,100}$/.test(subject.id)
    && (validSubjectImage(subject.subjectImage) || minimum === 0 && subject.subjectImage === "") && subjectRoles.includes(subject.role)
    && typeof subject.detail === "string" && subject.detail.length <= 2000)
  && new Set(subjects.map(subject => subject.id)).size === subjects.length;

export default defineBackground(() => {
  const reminders = startReminderService();
  void browser.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const openResult = async (tabId: number, selection: Selection) => {
    try {
      await browser.tabs.sendMessage(tabId, { type: "alchemy:show" });
    } catch {
      const viewKey = selection.projectId ? `projectView:${selection.projectId}` : "preferences";
      const saved = (await browser.storage.local.get(viewKey))[viewKey] as { mode?: Mode } | undefined;
      await uiMessage({ type: "alchemy:open-workspace", context: { selection, mode: saved?.mode || "style" } }, `tab:${tabId}`, tabId);
    }
  };
  browser.runtime.onInstalled.addListener(async () => {
    try {
      await browser.contextMenus.removeAll();
      browser.contextMenus.create({
        id: "alchemy-image",
        title: "用 QC-Reframe 逆向图片风格",
        contexts: ["image"],
      });
      browser.contextMenus.create({ id: "alchemy-collect", title: "加入 Reframe", contexts: ["image"] });
    } catch (error) { console.error("无法创建 Reframe 图片菜单", error); }
  });
  const storedInput = ({ inputs: _inputs, ...selection }: Selection) => selection;
  let selecting = false;
  const showsHiddenProjects = async () => (await browser.storage.session.get("showHiddenProjects")).showHiddenProjects === true;
  const requireVisibleProject = async (project: Project) => {
    if (project.hidden && !await showsHiddenProjects()) throw new Error("该项目已隐藏，请先点击小眼睛显示隐藏项目");
  };
  const select = async (
    target: ImageTarget,
    tab: { id: number; windowId: number; url?: string },
  ) => {
    if (selecting) throw new Error("正在读取上一张图片，请稍候");
    selecting = true;
    let selection: Selection = {
      id: crypto.randomUUID(),
      sourceUrl: tab.url || "",
      stage: "正在读取所选图片…",
    };
    try {
      const { preferences } = await browser.storage.local.get("preferences") as { preferences?: Preferences };
      await browser.storage.local.set({ selection: storedInput(selection) });
      await browser.tabs
        .sendMessage(tab.id, { type: "alchemy:hide" })
        .catch(() => {});
      Object.assign(
        selection,
        await captureImage(target, tab.id, tab.windowId),
      );
      if (!preferences?.token) {
        selection.stage = "图片已就绪，请先连接本机 Codex";
      } else {
        const project = await bridge<Project>("/projects", preferences.token, {
          image: selection.image,
          sourceUrl: selection.sourceUrl,
          capture: selection.capture,
        });
        if (project.hidden && !await showsHiddenProjects()) {
          selection = { id: selection.id, sourceUrl: "" };
          throw new Error("该项目已隐藏，请先点击小眼睛显示隐藏项目");
        }
        selection = { ...await projectReference(project.id, preferences.token), id: selection.id };
        selection.stage = "参考模板已就绪，请选择路径生成提示词";
      }
    } catch (error) {
      selection.error = error instanceof Error ? error.message : String(error);
    } finally {
      try { await browser.storage.local.set({ selection: storedInput(selection) }); }
      finally { selecting = false; }
      // Open after capture so the floating UI cannot cover the selected image.
      await openResult(tab.id, selection);
    }
  };
  const collect = async (target: ImageTarget, tab: { id: number; windowId: number; url?: string }): Promise<CollectionResult> => {
    if (!target || typeof target.src !== "string") throw new Error("请选择有效图片");
    const { preferences } = await browser.storage.local.get("preferences") as { preferences?: Preferences };
    if (!preferences?.token) throw new Error("请先在设置中连接本机服务，再加入图片");
    const captured = await captureImage(target, tab.id, tab.windowId);
    const project = await bridge<Project & { created?: boolean }>("/projects", preferences.token, {
      ...captured, sourceUrl: tab.url || "",
    });
    return { projectId: project.id, created: project.created ?? true };
  };
  const reference = async (id: string, token: string) => {
    if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id)) throw new Error("无效任务");
    try {
      return await bridge<Selection>(`/jobs/${id}/reference`, token);
    } catch (error) {
      if ((error as Error).message === "Not found")
        throw new Error("请重启本机服务 npm run bridge，以支持历史图片重新逆向。");
      throw error;
    }
  };
  const projectReference = (id: string, token: string) => {
    if (typeof id !== "string" || !/^[\da-f]{64}$/.test(id)) throw new Error("无效项目");
    return bridge<Selection>(`/projects/${id}/reference`, token);
  };
  const start = async (id: string, mode: Mode, referenceJobId?: string, reenact?: SubjectInput, projectId?: string, instruction?: string, inputRevision?: number, sessionIds?: string[], signal?: AbortSignal, referenceIndex?: number, generation?: { language: "zh" | "en"; aspectRatio?: AspectRatio }) => {
    if (selecting) throw new Error("正在处理图片，请稍候");
    selecting = true;
    try {
      const stored = (await browser.storage.local.get([
        "preferences",
        "selection",
      ])) as { preferences?: Preferences; selection?: Selection };
      if (instruction !== undefined && (typeof instruction !== "string" || instruction.length > 20000)) throw new Error("任务指令最多 20000 字符");
      if (!modes.includes(mode)) throw new Error("无效模式");
      if (reenact && instruction !== undefined) reenact = { ...reenact, basePrompt: instruction };
      if ((mode === "reenact" || (mode === "style" && reenact !== undefined)) && (typeof reenact?.subjectImage !== "string" || !reenact.subjectImage || typeof reenact.basePrompt !== "string" || !reenact.basePrompt.trim()))
        throw new Error("请上传主体图并填写任务指令");
      if (mode === "multi-reenact" && (!validSubjects(reenact?.subjects) || typeof reenact?.basePrompt !== "string" || !reenact.basePrompt.trim() || reenact.basePrompt.length > 20000))
        throw new Error("请添加 2–6 张有效主体图并填写任务指令");
      if (mode === "multi-reenact") reenact = { subjects: reenact!.subjects!.map(({ id, subjectImage, role, detail }) => ({ id, subjectImage, role, detail })), basePrompt: reenact!.basePrompt };
      const current = projectId ? await projectReference(projectId, stored.preferences?.token || "") : undefined;
      if (inputRevision !== undefined && current && inputRevision !== (current.inputRevision || 0))
        throw new Error("项目输入已在其他窗口更新，请刷新后重试");
      const selection = referenceJobId ? { ...await reference(referenceJobId, stored.preferences?.token || ""), id: crypto.randomUUID() }
        : current || stored.selection;
      if (projectId && selection?.projectId !== projectId) throw new Error("历史输入不属于当前项目");
      if (!selection?.image || (!projectId && !referenceJobId && selection.id !== id))
        throw new Error("所选图片已变化，请重试");
      const job = await bridge<Job>("/jobs", stored.preferences?.token || "", {
        image: selection.image,
        mode, sessionIds, referenceIndex, generation,
        sourceUrl: selection.sourceUrl,
        capture: selection.capture,
        instruction,
        projectId: selection.projectId,
        inputRevision: inputRevision ?? current?.inputRevision, referenceJobId,
        reenact: mode !== "recreate" && mode !== "session" ? reenact : undefined,
      }, signal);
      const next = { ...selection, projectId: job.projectId || selection.projectId, jobId: job.id, stage: job.stage, error: undefined, instruction: job.instruction, referenceIndex: job.referenceIndex,
        reenact: mode !== "recreate" && mode !== "session" ? reenact : undefined, subjectError: undefined, generationSubjectImage: undefined, generationSubjects: undefined };
      const currentSelection = await projectReference(job.projectId || selection.projectId!, stored.preferences?.token || "").catch(() => current || selection);
      if (!projectId || stored.selection?.projectId === projectId)
        await browser.storage.local.set({ selection: storedInput(currentSelection) }).catch(() => {});
      void reminders.wake();
      return { selection: next, currentSelection, job };
    } finally {
      selecting = false;
    }
  };
  const validateDraft = (draft: any) => {
    if (draft !== undefined && (typeof draft !== "object" || draft === null || Array.isArray(draft) || new TextEncoder().encode(JSON.stringify(draft)).length > 8 * 1024 * 1024))
      throw new Error("草稿过大，请在工作台保存后重试");
    if (draft?.multiSubjectDrafts !== undefined && (!draft.multiSubjectDrafts || typeof draft.multiSubjectDrafts !== "object" || Array.isArray(draft.multiSubjectDrafts)
      || Object.values(draft.multiSubjectDrafts).some(subjects => !validSubjects(subjects, 0))))
      throw new Error("多图草稿无效，请重新选择主体图");
  };
  const handoffContext = (context: any) => {
    if (!context || !modes.includes(context.mode)) throw new Error("无效工作台模式");
    const value = context.selection;
    if (value !== null && (!value || typeof value.id !== "string" || value.id.length > 100 || (value.projectId !== undefined && !/^[\da-f]{64}$/.test(value.projectId))
      || (value.inputRevision !== undefined && (!Number.isSafeInteger(value.inputRevision) || value.inputRevision < 0))))
      throw new Error("无效工作台项目");
    return { mode: context.mode, selection: value ? { id: value.id, projectId: value.projectId, sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "", capture: value.capture, inputRevision: value.inputRevision } : null };
  };
  // Serialize session writes so rapid input and simultaneous panels cannot reorder drafts.
  let sessionWrite: Promise<unknown> = Promise.resolve();
  const sessionTask = <T,>(action: () => Promise<T>) => {
    const task = sessionWrite.catch(() => {}).then(action);
    sessionWrite = task;
    return task;
  };
  const storeDraft = (key: string, value: Record<string, any>, transferFrom?: string) => {
    return sessionTask(async () => {
      const all = await browser.storage.session.get(null);
      for (const [storedKey, item] of Object.entries(all)) {
        if (!storedKey.startsWith("quick:") && !storedKey.startsWith("workspace:")) continue;
        const createdAt = (item as { createdAt?: number })?.createdAt;
        if (!createdAt || Date.now() - createdAt > 24 * 60 * 60 * 1000) {
          await browser.storage.session.remove(storedKey); delete all[storedKey];
        }
      }
      const original = transferFrom ? all[transferFrom] as Record<string, any> | undefined : undefined;
      const shared = original?.handoff ? all[original.handoff] as Record<string, any> | undefined : original;
      if (shared?.draft && value.draft) {
        const draft = { ...shared.draft, ...value.draft };
        for (const name of ["multiSubjectDrafts", "subjectDrafts", "instructions", "versions", "promptDrafts"])
          draft[name] = { ...shared.draft[name], ...value.draft[name] };
        value.draft = draft;
      }
      const changes = { [key]: value, ...(transferFrom ? { [transferFrom]: { createdAt: value.createdAt, handoff: key } } : {}) };
      if (transferFrom) value.source = transferFrom;
      if (new TextEncoder().encode(JSON.stringify({ ...all, ...changes })).length > 9 * 1024 * 1024)
        throw new Error("临时草稿空间不足，请先在已打开的工作台保存草稿");
      await browser.storage.session.set(changes);
    });
  };
  const consumeHandoff = (key: string) => {
    return sessionTask(async () => {
      const value = (await browser.storage.session.get(key))[key] as Record<string, any> | undefined;
      if (value?.source) {
        const quick = (await browser.storage.session.get(value.source))[value.source] as { handoff?: string } | undefined;
        // Transfer ownership without ever storing two copies of the image payload.
        if (quick?.handoff === key) await browser.storage.session.set({ [key]: null, [value.source]: { ...value, source: undefined } });
      }
      await browser.storage.session.remove(key);
      return value && Date.now() - value.createdAt <= 24 * 60 * 60 * 1000 ? value : undefined;
    });
  };
  const uiMessage = async (message: Record<string, any>, source = "popup", sourceTab?: number, signal?: AbortSignal) => {
    // Expose only this public preference; content scripts cannot read local storage.
    if (message.type === "alchemy:get-motion-preference") {
      const { motionPreference } = await browser.storage.local.get("motionPreference");
      return motionPreference === "full" || motionPreference === "reduce" ? motionPreference : "system";
    }
    if (message.type === "alchemy:set-motion-preference") {
      if (!["system", "reduce", "full"].includes(message.preference)) throw new Error("无效动效设置");
      await browser.storage.local.set({ motionPreference: message.preference });
      const changed = { type: "alchemy:motion-changed" };
      // Re-read on notification so concurrent changes cannot deliver stale values.
      await Promise.allSettled([
        browser.runtime.sendMessage(changed),
        browser.tabs.query({ url: ["http://*/*", "https://*/*"] }).then(tabs => Promise.allSettled(
          tabs.filter(tab => tab.id != null).map(tab => browser.tabs.sendMessage(tab.id!, changed, { frameId: 0 })),
        )),
      ]);
      return;
    }
    const { preferences, selection } = (await browser.storage.local.get([
      "preferences", "selection",
    ])) as { preferences?: Preferences; selection?: Selection };
    const token = preferences?.token || "";
    const showHiddenProjects = await showsHiddenProjects();
    switch (message.type) {
      case "alchemy:open-workspace": {
        if (message.view !== undefined && !["tasks", "settings"].includes(message.view)) throw new Error("无效工作台页面");
        if (message.section !== undefined && (message.view !== "settings" || !["cli", "pi-cli", "models", "generation", "connection"].includes(message.section))) throw new Error("无效设置页面");
        const id = crypto.randomUUID();
        // Explicit UI context wins over another view's global selection and mode.
        const draft = message.draft;
        validateDraft(draft);
        const viewKey = selection?.projectId ? `projectView:${selection.projectId}` : undefined;
        const savedView = !message.context && viewKey ? (await browser.storage.local.get(viewKey) as Record<string, { mode?: Mode }>)[viewKey] : undefined;
        const context = handoffContext(message.context ?? { mode: viewKey ? savedView?.mode || "style" : preferences?.mode || "style", selection: selection || null });
        await storeDraft(`workspace:${id}`, { ...context, draft, createdAt: Date.now() }, message.draft ? `quick:${source}` : undefined);
        try { await openWorkspace(new URLSearchParams({ handoff: id, ...(message.view ? { view: message.view } : {}), ...(message.section ? { section: message.section } : {}) }), sourceTab); }
        catch (error) { await consumeHandoff(`workspace:${id}`); throw error; }
        return;
      }
      case "alchemy:workspace-handoff": {
        if (typeof message.id !== "string" || !/^[\da-f-]{36}$/.test(message.id)) throw new Error("无效工作台入口");
        return consumeHandoff(`workspace:${message.id}`);
      }
      case "alchemy:quick-draft": {
        const key = `quick:${source}`;
        if (message.context !== undefined) {
          validateDraft(message.draft);
          await storeDraft(key, { ...handoffContext(message.context), draft: message.draft, createdAt: Date.now() });
          return;
        }
        return sessionTask(async () => {
          let value = (await browser.storage.session.get(key))[key] as Record<string, any> | undefined;
          if (value?.handoff) value = (await browser.storage.session.get(value.handoff))[value.handoff] as Record<string, any> | undefined;
          if (value && Date.now() - value.createdAt <= 24 * 60 * 60 * 1000) return value;
          await browser.storage.session.remove(key);
          return;
        });
      }
      case "alchemy:upload-reference": {
        if (selecting) throw new Error("正在处理图片，请稍候");
        if (typeof message.image !== "string" || message.image.length > 6 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(message.image))
          throw new Error("请上传有效的参考图");
        selecting = true;
        try {
          const project = await bridge<Project>("/projects", token, { image: message.image, sourceUrl: "", capture: "original" });
          await requireVisibleProject(project);
          const next: Selection = { ...await projectReference(project.id, token), id: crypto.randomUUID() };
          await browser.storage.local.set({ selection: storedInput(next) });
          return next;
        } finally { selecting = false; }
      }
      case "alchemy:sessions-list":
        return bridge("/sessions/list", token, { searchTerm: message.searchTerm, cursor: message.cursor, archived: message.archived, scope: message.scope }, signal);
      case "alchemy:batches":
        return bridge(`/batches${showHiddenProjects ? "?includeHidden=true" : ""}`, token);
      case "alchemy:batch-preview":
      case "alchemy:batch-start": {
        if (!Array.isArray(message.projects) || !message.projects.length || message.projects.length > 24 ||
          message.projects.some((item: any) => !item || typeof item.projectId !== "string" || !/^[a-f0-9]{64}$/.test(item.projectId) || !Number.isSafeInteger(item.inputRevision) || item.inputRevision < 0) ||
          new Set(message.projects.map((item: any) => item.projectId)).size !== message.projects.length) throw new Error("无效批量项目");
        const projects = message.projects.map(({ projectId, inputRevision }: { projectId: string; inputRevision: number }) => ({ projectId, inputRevision }));
        if (message.type === "alchemy:batch-preview") return bridge("/batches/preview", token, { projects }, signal);
        const { requestId, language, aspectRatio } = message;
        if (typeof requestId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(requestId) || !["zh", "en"].includes(language) ||
          (aspectRatio !== undefined && (!aspectRatio || ![aspectRatio.width, aspectRatio.height].every(value => Number.isInteger(value) && value >= 1 && value <= 10000) || aspectRatio.width / aspectRatio.height < 1 / 20 || aspectRatio.width / aspectRatio.height > 20))) throw new Error("无效批量参数");
        const batch = await bridge("/batches", token, { requestId, projects, language, ...(aspectRatio ? { aspectRatio: { width: aspectRatio.width, height: aspectRatio.height } } : {}) }, signal);
        void reminders.wake();
        return batch;
      }
      case "alchemy:batch-cancel":
        if (typeof message.id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(message.id) ||
          (message.projectId !== undefined && (typeof message.projectId !== "string" || !/^[a-f0-9]{64}$/.test(message.projectId)))) throw new Error("无效批量任务");
        return bridge(`/batches/${message.id}/cancel`, token, message.projectId ? { projectId: message.projectId } : {}, signal);
      case "alchemy:sessions-index":
        return bridge("/sessions/index", token, { action: message.action }, signal);
      case "alchemy:update-project-input": {
        if (selecting) throw new Error("正在处理图片，请稍候");
        if (typeof message.projectId !== "string" || !/^[a-f0-9]{64}$/.test(message.projectId)
          || !Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0 || !modes.includes(message.mode))
          throw new Error("无效项目输入");
        selecting = true;
        try {
          const next = await bridge<Selection>(`/projects/${message.projectId}/input`, token, {
            expectedRevision: message.expectedRevision, referenceJobId: message.referenceJobId, image: message.image, mode: message.mode,
            referenceIndex: message.referenceIndex, instruction: message.instruction, subjectImage: message.subjectImage, subjects: message.subjects, sessionIds: message.sessionIds,
          }, signal);
          try {
            const latest = (await browser.storage.local.get("selection")).selection as Selection | undefined;
            if (latest?.projectId === message.projectId && (latest.inputRevision || 0) <= message.expectedRevision)
              await browser.storage.local.set({ selection: storedInput(next) });
          } catch { /* The bridge already saved the input; local selection is only a cache. */ }
          return next;
        } finally { selecting = false; }
      }
      case "alchemy:service-restart":
        try { return await bridge("/restart", token, {}); }
        catch (error) {
          if ((error as Error).message === "Not found") throw new Error("当前服务尚不支持插件内重启。请在插件目录运行 npm stop，再运行 npm start。");
          throw error;
        }
      case "alchemy:cli-check":
      case "alchemy:cli-update":
      case "alchemy:cli-install": {
        if (message.agent !== undefined && !["codex", "pi"].includes(message.agent)) throw new Error("无效 Agent");
        const action = message.type.slice("alchemy:cli-".length);
        return bridge(`/cli/${action}${message.agent === "pi" ? "?agent=pi" : ""}`, token, {});
      }
      case "alchemy:state": {
        let visibleSelection = selection;
        if (selection && !showHiddenProjects && (selection.projectId || /^[\da-f-]{36}$/.test(selection.jobId || ""))) {
          try {
            const projectId = selection.projectId || (await bridge<Job>(`/jobs/${selection.jobId}`, token)).projectId;
            const health = await bridge<{ hiddenProjectIds?: string[] }>("/health", token);
            if (projectId && health.hiddenProjectIds?.includes(projectId)) visibleSelection = undefined;
          } catch { visibleSelection = undefined; }
        }
        return {
          preferences: { paired: !!token, mode: preferences?.mode || "style", showHiddenProjects },
          // The panel already holds this image; avoid resending megabytes each poll.
          selection: visibleSelection && visibleSelection.id === message.selectionId && visibleSelection.jobId === message.selectionJobId
            ? { ...visibleSelection, image: undefined, reenact: undefined, generationSubjectImage: undefined, generationSubjects: undefined } : visibleSelection,
        };
      }
      case "alchemy:show-hidden-projects":
        if (typeof message.show !== "boolean") throw new Error("无效显示设置");
        await browser.storage.session.set({ showHiddenProjects: message.show });
        return message.show;
      case "alchemy:connect": {
        if (typeof message.token !== "string") throw new Error("无效配对码");
        const health = await bridge<{ ready: boolean; skill: string }>("/health", message.token);
        if (!health.ready) throw new Error("服务已启动，但未找到图片逆向技能。");
        await browser.storage.local.set({ preferences: { ...preferences, mode: preferences?.mode || "style", token: message.token } });
        return health;
      }
      case "alchemy:project-views": {
        const stored = await browser.storage.local.get(null);
        return Object.fromEntries(Object.entries(stored).filter(([key]) => /^projectView:[a-f0-9]{64}$/.test(key))
          .map(([key, value]) => [key.slice("projectView:".length), value]));
      }
      case "alchemy:save-project-view": {
        const view = message.view;
        if (typeof message.projectId !== "string" || !/^[a-f0-9]{64}$/.test(message.projectId)
          || !view || !modes.includes(view.mode) || !view.versions || typeof view.versions !== "object" || Array.isArray(view.versions)
          || Object.entries(view.versions).some(([mode, id]) => !modes.includes(mode)
            || typeof id !== "string" || (id !== "new" && !/^[\da-f-]{36}$/.test(id)))) throw new Error("无效项目选择");
        if (view.inputRevision !== undefined && (!Number.isSafeInteger(view.inputRevision) || view.inputRevision < 0)) throw new Error("无效输入版本");
        await browser.storage.local.set({ [`projectView:${message.projectId}`]: { mode: view.mode, versions: view.versions, inputRevision: view.inputRevision } });
        return;
      }
      case "alchemy:mode":
        if (!modes.includes(message.mode)) throw new Error("无效模式");
        await browser.storage.local.set({ preferences: { ...preferences, token, mode: message.mode } });
        return;
      case "alchemy:query":
        if (typeof message.path !== "string" || !/^\/(health|agents|models(?:\?agent=(?:pi|codex))?|cli\/status(?:\?agent=(?:pi|codex))?|jobs(?:\/[\w-]+)?|projects(?:\/[\da-f]{64})?)$/.test(message.path))
          throw new Error("无效请求");
        return bridge(`${message.path}${showHiddenProjects && ["/projects", "/jobs", "/health"].includes(message.path) ? "?includeHidden=true" : ""}`, token);
      case "alchemy:gallery": {
        const { offset = 0, limit = 100, search = "", projectId, ratio = "all", sort = "newest" } = message;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          typeof search !== "string" || search.length > 200 || (projectId !== undefined && (typeof projectId !== "string" || !/^[a-f0-9]{64}$/.test(projectId))) ||
          !["all", "portrait", "landscape", "square"].includes(ratio) || !["newest", "oldest"].includes(sort)) throw new Error("无效画廊查询");
        try {
          return await bridge(`/gallery?${new URLSearchParams({ offset: String(offset), limit: String(limit), search, ratio, sort,
            ...(projectId ? { projectId } : {}), ...(showHiddenProjects ? { includeHidden: "true" } : {}) })}`, token);
        } catch (error) {
          if ((error as Error).message === "Not found") throw new Error("本机服务尚未启用作品画廊，请重启本机服务后重试。已有作品仍保存在本机。");
          throw error;
        }
      }
      case "alchemy:projects": {
        const { page = 1, limit = 24, q = "", status } = message;
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof q !== "string" || q.length > 200 || (status !== undefined && status !== "unstarted"))
          throw new Error("无效项目查询");
        return bridge(`/projects?${new URLSearchParams({ page: String(page), limit: String(limit), q, ...(status ? { status } : {}), ...(showHiddenProjects ? { includeHidden: "true" } : {}) })}`, token);
      }
      case "alchemy:project": {
        if (typeof message.id !== "string" || !/^[\da-f]{64}$/.test(message.id) ||
          (message.revision !== undefined && (typeof message.revision !== "string" || message.revision.length > 100))) throw new Error("无效项目查询");
        return bridge(`/projects/${message.id}${message.revision ? `?revision=${encodeURIComponent(message.revision)}` : ""}`, token);
      }
      case "alchemy:project-thumbnail":
        if (typeof message.id !== "string" || !/^[\da-f]{64}$/.test(message.id) || (message.reference !== undefined && typeof message.reference !== "boolean")) throw new Error("无效项目");
        return bridge(`/projects/${message.id}/thumbnail${message.reference ? "?reference=1" : ""}`, token);
      case "alchemy:image-settings":
        return bridge("/image-settings", token);
      case "alchemy:image-settings-save":
        if (!message.settings || typeof message.settings !== "object" || Array.isArray(message.settings)) throw new Error("无效生图设置");
        return bridge("/image-settings", token, message.settings);
      case "alchemy:agent-select":
        if (!["codex", "pi"].includes(message.agent)) throw new Error("请选择支持的 Agent");
        return bridge("/agents/select", token, { agent: message.agent });
      case "alchemy:models-refresh":
        if (message.agent !== undefined && !["codex", "pi"].includes(message.agent)) throw new Error("请选择支持的 Agent");
        return bridge(`/models/refresh${message.agent === "pi" ? "?agent=pi" : ""}`, token, {});
      case "alchemy:model-verify":
        if (message.agent !== undefined && !["codex", "pi"].includes(message.agent)) throw new Error("请选择支持的 Agent");
        if (typeof message.model !== "string" || !message.model || message.model.length > 200) throw new Error("请选择有效模型");
        if (message.reasoningEffort !== undefined && (typeof message.reasoningEffort !== "string" || !message.reasoningEffort || message.reasoningEffort.length > 50)) throw new Error("请选择有效推理强度");
        return bridge(`/models/verify${message.agent === "pi" ? "?agent=pi" : ""}`, token, { model: message.model, reasoningEffort: message.reasoningEffort });
      case "alchemy:cancel":
        if (typeof message.id !== "string" || !/^[\w-]+$/.test(message.id)) throw new Error("无效任务");
        return bridge(`/jobs/${message.id}/cancel`, token, {});
      case "alchemy:reference":
        return reference(message.id, token);
      case "alchemy:project-reference":
        return projectReference(message.id, token);
      case "alchemy:set-project-hidden": {
        if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 1000 || message.ids.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || typeof message.hidden !== "boolean")
          throw new Error("请选择有效项目和隐藏状态");
        const result = await bridge("/projects/visibility", token, { ids: message.ids, hidden: message.hidden });
        await reminders.projectsChanged(message.ids, message.hidden);
        return result;
      }
      case "alchemy:delete-projects": {
        if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 1000 || message.ids.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
          throw new Error("请选择有效项目");
        if (selecting) throw new Error("正在处理图片，请稍后重试");
        selecting = true;
        try {
          const result = await bridge<{ deletedIds: string[] }>("/projects/delete", token, { ids: message.ids });
          const latest = await browser.storage.local.get("selection") as { selection?: Selection };
          if (latest.selection?.projectId && result.deletedIds.includes(latest.selection.projectId))
            await browser.storage.local.remove("selection");
          await browser.storage.local.remove(result.deletedIds.map(id => `projectView:${id}`));
          await reminders.projectsChanged(result.deletedIds);
          return result;
        } finally { selecting = false; }
      }
      case "alchemy:open-project": {
        if (typeof message.id !== "string" || !/^[\da-f]{64}$/.test(message.id)) throw new Error("无效项目");
        if (selecting) throw new Error("正在处理项目，请稍后重试");
        selecting = true;
        try {
          const project = await bridge<Project>(`/projects/${message.id}`, token);
          await requireVisibleProject(project);
          let next: Selection;
          try { next = await projectReference(message.id, token); }
          catch (error) { next = { id: project.id, projectId: project.id, sourceUrl: project.sourceUrl, capture: project.capture, inputRevision: project.inputRevision, inputVersions: project.inputVersions, error: (error as Error).message }; }
          await browser.storage.local.set({ selection: storedInput(next) });
          return next;
        } finally { selecting = false; }
      }
      case "alchemy:ensure-project": {
        if (!selection?.image || selection.id !== message.id) throw new Error("所选图片已变化，请重试");
        if (selecting) throw new Error("正在处理项目，请稍后重试");
        selecting = true;
        try {
          const project = await bridge<Project>("/projects", token, { image: selection.image, sourceUrl: selection.sourceUrl, capture: selection.capture });
          const latest = await browser.storage.local.get("selection") as { selection?: Selection };
          if (latest.selection?.id !== selection.id) throw new Error("所选图片已变化，请重试");
          try { await requireVisibleProject(project); }
          catch (error) { await browser.storage.local.remove("selection"); throw error; }
          const next = { ...await projectReference(project.id, token), id: selection.id };
          await browser.storage.local.set({ selection: storedInput(next) });
          return next;
        } finally { selecting = false; }
      }
      case "alchemy:save-prompt": {
        if (typeof message.id !== "string" || !/^[\da-f-]{36}$/.test(message.id)) throw new Error("无效任务");
        const edits: Record<string, string> = {};
        for (const key of ["promptZh", "promptEn", "negativePrompt"]) {
          if (typeof message[key] !== "string" || message[key].length > 20000 || (key !== "negativePrompt" && !message[key].trim()))
            throw new Error("中英文提示词不能为空，每项最多 20000 字符");
          edits[key] = message[key];
        }
        return bridge(`/jobs/${message.id}/prompt`, token, edits);
      }
      case "alchemy:generate":
      case "alchemy:generation-cancel":
      case "alchemy:generation-reference":
      case "alchemy:generation-thumbnail":
      case "alchemy:generation-file-action":
      case "alchemy:generation-image": {
        if (typeof message.id !== "string" || !/^[\da-f-]{36}$/.test(message.id)) throw new Error("无效任务");
        const path = `/jobs/${message.id}/generations`;
        if (message.type === "alchemy:generate") {
          if (!["zh", "en"].includes(message.language)) throw new Error("无效提示词语言");
          const { aspectRatio } = message;
          if (aspectRatio !== undefined && (!aspectRatio || typeof aspectRatio !== "object" || Array.isArray(aspectRatio)
            || Object.keys(aspectRatio).some(key => !["width", "height"].includes(key))
            || ![aspectRatio.width, aspectRatio.height].every(value => Number.isInteger(value) && value >= 1 && value <= 10000)
            || aspectRatio.width / aspectRatio.height < 1 / 20 || aspectRatio.width / aspectRatio.height > 20))
            throw new Error("宽高须为 1–10000 的整数，比例须在 1:20 至 20:1 之间");
          if (message.subjectImage !== undefined && (typeof message.subjectImage !== "string" || message.subjectImage.length > 3 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(message.subjectImage)))
            throw new Error("请上传有效的主体图");
          if (message.subjects !== undefined && (!validSubjects(message.subjects) || message.subjectImage !== undefined))
            throw new Error("请添加 2–6 张有效主体图");
          const subjects = message.subjects?.map(({ id, subjectImage, role, detail }: MultiSubject) => ({ id, subjectImage, role, detail }));
          const job = await bridge(path, token, { language: message.language, subjectImage: message.subjectImage, subjects, aspectRatio });
          void reminders.wake();
          return job;
        }
        if (typeof message.generationId !== "string" || !/^[\da-f-]{36}$/.test(message.generationId)) throw new Error("无效生图记录");
        if (message.type === "alchemy:generation-file-action") {
          if (!["open", "reveal"].includes(message.action)) throw new Error("无效图片操作");
          return bridge(`${path}/${message.generationId}/${message.action}`, token, {});
        }
        return message.type === "alchemy:generation-reference"
          ? bridge(`${path}/${message.generationId}/reference`, token)
          : message.type === "alchemy:generation-thumbnail"
          ? bridge(`${path}/${message.generationId}/thumbnail`, token)
          : message.type === "alchemy:generation-image"
          ? bridge(`${path}/${message.generationId}/image`, token)
          : bridge(`${path}/${message.generationId}/cancel`, token, {});
      }
      case "alchemy:start":
        return start(message.id, message.mode, message.referenceJobId, message.reenact, message.projectId, message.instruction, message.inputRevision, message.sessionIds, signal, message.referenceIndex, message.generation);
    }
  };
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== "alchemy:request") return;
    const sender = port.sender;
    const source = messageSource(sender, browser.runtime.id, browser.runtime.getURL("/"));
    if (!source) { port.disconnect(); return; }
    const controller = new AbortController();
    let started = false;
    let keepAlive: ReturnType<typeof setInterval>;
    port.onDisconnect.addListener(() => { controller.abort(); clearInterval(keepAlive); });
    port.onMessage.addListener(message => {
      if (started) return;
      started = true;
      if (!allowsOperation(operationFor(message?.type), source, "port")) {
        port.postMessage({ error: "无效请求" }); return;
      }
      const reply = (value: unknown) => { if (!controller.signal.aborted) port.postMessage(value); };
      // Port traffic keeps the MV3 worker alive only while this bounded read runs.
      keepAlive = setInterval(() => reply({ pending: true }), PORT_KEEP_ALIVE);
      void uiMessage(message, source === "content" ? `tab:${sender!.tab!.id}` : "popup", sender?.tab?.id, controller.signal)
        .then(value => reply({ ok: true, value }), error => reply({ error: error.message }))
        .finally(() => clearInterval(keepAlive));
    });
  });
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    const source = messageSource(sender, browser.runtime.id, browser.runtime.getURL("/"));
    const operation = operationFor(message?.type);
    if (!allowsOperation(operation, source)) return;
    if (message.type !== "alchemy:select" && message.type !== "alchemy:collect") {
      uiMessage(message, source === "content" ? `tab:${sender.tab!.id}` : "popup", sender.tab?.id).then(
        (value) => reply({ ok: true, value }),
        (error) => reply({ error: error.message }),
      );
      return true;
    }
    const tab = sender.tab;
    void (async () => {
      try {
        const value = await (message.type === "alchemy:collect" ? collect : select)(message.target, {
          id: tab!.id!, windowId: tab!.windowId, url: tab!.url,
        });
        reply({ ok: true, value });
      } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }); }
    })();
    return true;
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!["alchemy-image", "alchemy-collect"].includes(String(info.menuItemId)) || !info.srcUrl || !tab?.id) return;
    if (info.menuItemId === "alchemy-collect") {
      const feedback = (value: Record<string, unknown>) => browser.tabs.sendMessage(tab.id!, { type: "alchemy:collect-feedback", ...value }).catch(() => {});
      void (async () => {
        await feedback({ state: "saving" });
        try {
          const result = await collect({ src: info.srcUrl! }, { id: tab.id!, windowId: tab.windowId, url: tab.url });
          await feedback({ state: "saved", ...result });
        } catch (error) { await feedback({ state: "error", error: error instanceof Error ? error.message : String(error) }); }
      })();
      return;
    }
    void select(
      { src: info.srcUrl },
      { id: tab.id, windowId: tab.windowId, url: tab.url },
    ).catch(() => {});
  });
});
