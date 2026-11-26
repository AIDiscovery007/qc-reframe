import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bad, readBody } from "../http.mjs";
import { LEGACY_AGENT } from "../agents.mjs";

/** Service status, sessions, Agent/model/CLI management, image settings and service lifecycle routes. Returns true when the request was handled. */
export async function serviceRoutes(request, app) {
  const { req, res, path, query, json, validateQuery, includeHidden, submission, readSessions, assertSessionRequestActive } = request;
  const { root, version, dataDir, startDataDir, skillPath, generationSkillPath, instanceId, restartId, allowShutdown, restart, server, state, agents, codexHost, compatibility, requireFeature, cliBusy, codexBusy, imageSettings, magpieInspector, sessions, projects, batches, runtime, taskFeed } = app;
  if (req.method === "GET" && path === "/health") {
    validateQuery(["includeHidden"]);
    // The service manager polls readiness passively; only client health checks refresh CLI state.
    // A header keeps older services, which reject unknown query keys, compatible with newer managers.
    const passive = req.headers["x-reframe-probe"] === "passive";
    const showHidden = includeHidden();
    let skill;
    try {
      skill = (await readFile(skillPath, "utf8"))
        .match(/^name:\s*(.+)$/m)?.[1]
        ?.trim();
    } catch {}
    if (!passive) {
      void codexHost.cli.status?.().catch(() => {});
      if (!cliBusy()) void compatibility.getCompatibility().catch(() => {});
    }
    const cliState = codexHost.cli.peek?.();
    const cliSummary = cliState ? Object.fromEntries(["installed", "version", "source", "updateAvailable", "latestVersion", "checkError", "reason", "comparisonReference"].map(key => [key, cliState[key]])) : null;
    json(200, {
      service: "qc-alchemy",
      version,
      // Lets the extension offer `cd <installDir> && npm start` while the service is offline. dataDir appears only when
      // this service uses a folder other than the installation's own .local, so that command reopens the same data.
      installDir: root,
      dataDir: startDataDir,
      projectsRevision: projects.revision,
      managed: allowShutdown,
      instanceId, restartId, canRestart: allowShutdown && !!restart,
      skill: skill || null,
      ready: Boolean(skill),
      serviceReady: true, skillReady: Boolean(skill), cli: cliSummary,
      compatibility: compatibility.snapshot(),
      active: runtime.count + batches.active.filter(item => item.status === "queued").length + Number(agents.busy) + Number(cliBusy()),
      visibleActive: runtime.visibleCount(id => showHidden || !projects.isHidden(id)) + batches.active.filter(item => item.status === "queued" && (showHidden || !projects.isHidden(item.projectId))).length + Number(agents.busy) + Number(cliBusy()),
      hiddenProjectIds: projects.hiddenProjectIds,
      cliBusy: cliBusy(),
      modelBusy: agents.busy,
      agent: agents.selected,
      model: agents.get().models.selectedModel,
      generationReady: imageSettings.ready(),
      generationModel: imageSettings.view().provider === "codex" ? null : (imageSettings.ready() ? imageSettings.view().configs[imageSettings.view().provider].model : null),
      generationProvider: imageSettings.view().provider,
    });
    return true;
  }
  if (req.method === "POST" && path === "/sessions/list") {
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    const body = await readBody(req);
    try { json(200, await readSessions(signal => sessions.list(body, signal))); }
    catch (error) { throw error.status ? error : bad("无法读取本机 Codex 会话，请检查 CLI 后重试", 503); }
    return true;
  }
  if (req.method === "POST" && path === "/sessions/index") {
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "action") || !["refresh", "clear", "status"].includes(body.action)) throw bad("无效的索引操作");
    try { json(200, await readSessions(() => sessions.index(body.action), body.action === "refresh")); }
    catch (error) { throw error.status ? error : bad("无法访问本地会话索引，请重试", 503); }
    return true;
  }
  if (req.method === "POST" && path === "/image-models") {
    validateQuery([]);
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "baseUrl") || typeof body.baseUrl !== "string") throw bad("无效 Magpie 连接参数");
    json(200, await magpieInspector({ baseUrl: body.baseUrl, signal: submission.signal }));
    return true;
  }
  if (path === "/image-settings" && (req.method === "GET" || req.method === "POST")) {
    validateQuery([]);
    json(200, req.method === "GET" ? imageSettings.view() : await imageSettings.save(await readBody(req)));
    return true;
  }
  if (req.method === "GET" && path === "/agents") { validateQuery([]); json(200, agents.view()); return true; }
  if (req.method === "POST" && path === "/agents/select") {
    const body = await readBody(req);
    if (!body || Object.keys(body).some(key => key !== "agent")) throw bad("无效 Agent 设置");
    if (codexBusy() || cliBusy()) throw bad("请等待当前任务完成，再切换 Agent。", 409);
    json(200, await agents.select(body.agent)); return true;
  }
  if (req.method === "GET" && path === "/models") {
    validateQuery(["agent"]);
    const { models: store, compatibility: gated } = agents.get(query.get("agent") ?? LEGACY_AGENT);
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (gated) await requireFeature("models");
    try { json(200, await store.list()); } catch (error) { throw Object.assign(error, { status: error.status || 503 }); }
    return true;
  }
  if (path.startsWith("/cli/") && (req.method === "GET" && path === "/cli/status" || req.method === "POST" && ["/cli/check", "/cli/update", "/cli/install"].includes(path))) {
    validateQuery(["agent"]);
    const target = query.get("agent") ?? LEGACY_AGENT;
    const adapter = agents.get(target), manager = adapter.cli;
    if (!manager) throw bad("此 Agent 不提供 CLI 管理。", 409);
    if (req.method === "GET") {
      const status = await manager.status();
      json(200, { ...status, agent: target, ...(adapter.compatibility ? { compatibility: cliBusy() ? compatibility.snapshot() : await compatibility.getCompatibility() } : {}) });
      return true;
    }
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw bad("Agent 管理操作不接受命令或路径参数。");
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (path !== "/cli/check") {
      if (codexBusy()) throw bad("已有任务或模型验证正在执行，请等待完成或取消。", 409);
      const action = path.endsWith("/install") ? "install" : "update";
      if (!manager[action]) throw bad("此 Agent 请按官方安装说明安装后重新检测。", 409);
      state.cliStarting = true;
      try { json(202, { ...await manager[action](), agent: target }); }
      finally { state.cliStarting = false; }
    } else {
      const status = await manager.check();
      if (!adapter.compatibility) json(200, { ...status, agent: target });
      else {
        const report = cliBusy() ? compatibility.snapshot() : await compatibility.getCompatibility({ force: true });
        if (!cliBusy() && !runtime.reading && !sessions.busy) sessions.resetReader?.();
        json(200, { ...status, agent: target, compatibility: report });
      }
    }
    return true;
  }
  if (req.method === "POST" && ["/models/refresh", "/models/verify"].includes(path)) {
    validateQuery(["agent"]);
    const store = agents.get(query.get("agent") ?? LEGACY_AGENT).models;
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (codexBusy()) throw bad("已有任务或模型验证正在执行，请等待完成或取消。", 409);
    const body = await readBody(req);
    if (path.endsWith("/verify") && (typeof body.model !== "string" || body.model.length > 200)) throw bad("请选择有效模型");
    try { json(path.endsWith("/verify") ? 202 : 200, path.endsWith("/verify") ? await store.start(body.model, body.reasoningEffort) : await store.refresh()); }
    catch (error) { throw Object.assign(error, { status: error.status || 503 }); }
    return true;
  }
  if (req.method === "POST" && path === "/restart") {
    if (!allowShutdown || !restart) throw bad("此服务不支持插件内重启。请在原终端停止，再在插件目录运行 npm start。", 409);
    if (codexBusy() || cliBusy()) throw bad("任务、模型验证或 Agent CLI 操作执行中，请等待完成后再重启。", 409);
    const nextRestartId = randomUUID();
    let commit;
    try { commit = await restart({ root, dataDir, port: server.address().port, instanceId, restartId: nextRestartId, skillPath, generationSkillPath }); }
    catch { throw bad("重启准备失败，原服务仍在运行。请查看本机服务日志后重试。", 503); }
    state.shuttingDown = true;
    let committed = false;
    const finishRestart = () => {
      if (committed) return;
      committed = true;
      taskFeed.close();
      server.close();
      server.closeIdleConnections();
      commit();
    };
    res.once("finish", finishRestart);
    res.once("close", finishRestart);
    json(202, { previousInstanceId: instanceId, restartId: nextRestartId });
    if (res.destroyed) finishRestart();
    return true;
  }
  if (req.method === "POST" && path === "/shutdown" && allowShutdown) {
    if (codexBusy() || cliBusy()) throw bad("任务或 Agent CLI 安装更新执行中，请等待完成后再停止服务。", 409);
    state.shuttingDown = true;
    json(200, { stopped: true });
    server.close();
    server.closeIdleConnections();
    return true;
  }
  return false;
}
