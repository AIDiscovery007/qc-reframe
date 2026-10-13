// Real built React surfaces. Only public transport and image decoding are delayed.
const find = selector => document.querySelector(selector);
const assert = (value, message) => { if (!value) throw new Error(message); };
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
};
const flow = new URLSearchParams(location.search).get("inputOperationRegression");
const quick = location.pathname === "/popup.html";
const mode = () => find('[aria-label="逆向模式"]');
const version = () => find('[aria-label="提示词版本"]')?.value;
const subject = () => find('[aria-label="查看主体图"] img')?.getAttribute("src");
const selected = () => find('[aria-label="图片图条"] [aria-pressed="true"]')?.getAttribute("aria-label");
const error = () => find(quick ? ".quick-workspace [role=alert]" : ".canvas-error")?.textContent || "";
const reverse = () => quick ? [...document.querySelectorAll(".quick-submit button")].find(button => /仅逆向|更新提示词/.test(button.textContent)) : find(".canvas-generate");
const send = chrome.runtime.sendMessage.bind(chrome.runtime);
const bitmap = globalThis.createImageBitmap.bind(globalThis);
const writes = [], reads = [], starts = [];
let holdWrites = false, holdReads = false;
chrome.runtime.sendMessage = async message => {
  if (message.type === "alchemy:start") starts.push(message);
  if (message.type !== "alchemy:update-project-input") return send(message);
  const write = { message: structuredClone(message) };
  writes.push(write);
  if (!holdWrites) return send(message);
  return new Promise(resolve => { write.finish = async failure => resolve(failure ? { error: failure } : await send(message)); });
};
globalThis.createImageBitmap = async (...args) => {
  if (!holdReads || !(args[0] instanceof File) || !args[0].name.startsWith("input-operation")) return bitmap(...args);
  return new Promise((resolve, reject) => reads.push({ finish: async failure => failure ? reject(new Error(failure)) : resolve(await bitmap(...args)) }));
};
const input = async () => (await send({ type: "alchemy:project-reference", id: "a".repeat(64) })).value;
const showInput = async () => {
  if (!quick) {
    [...document.querySelectorAll(".workspace-canvas-tabs button")].find(button => button.textContent === "输入画布")?.click();
    find('[aria-label="收起提示词面板"]')?.click();
  }
  await waitFor(() => mode() && !mode().disabled && reverse() && !reverse().disabled && (quick || !find(".workspace-editor")?.inert), "输入应恢复可用");
};
const navigate = async destination => {
  const id = destination === "A" ? "a".repeat(64) : "b".repeat(64);
  if (quick) {
    await send({ type: "alchemy:open-project", id });
    await waitFor(() => find(".quick-heading h1")?.textContent === (destination === "A" ? "暖纸底几何模板" : "另一个空白项目"), "快捷端应接收项目切换");
  } else {
    const task = destination === "A" ? "11111111-1111-4111-8111-111111111111" : "44444444-4444-4444-8444-444444444444";
    location.hash = "workspace=" + new URLSearchParams({ task, request: crypto.randomUUID() });
    await waitFor(() => version() === task && !location.hash && find("#workspace-prompt-sheet") && !find("#workspace-prompt-sheet").inert, "提醒导航应完成并展开目标版本");
  }
  if (!quick) {
    [...document.querySelectorAll(".workspace-canvas-tabs button")].find(button => button.textContent === "输入画布")?.click();
    find('[aria-label="收起提示词面板"]')?.click();
  }
  await frame();
};
const upload = files => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  if (quick) {
    const element = find('[aria-label="上传主体图"]');
    element.files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else find(".canvas-filmstrip").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
};
const remove = async () => {
  find('[aria-label="查看主体图"]').click();
  await waitFor(() => !find('[aria-label="移除主体"]').disabled, "主体应可移除");
  find('[aria-label="移除主体"]').click();
};
try {
  await waitFor(() => mode() && subject() || flow.startsWith("multi") && mode(), "真实组件应加载输入");
  if (flow.startsWith("multi")) {
    if (mode().value !== "multi-reenact") setValue(mode(), "multi-reenact");
    await waitFor(() => mode().value === "multi-reenact" && find('[aria-label="查看主体 1"]'), "多图模式应恢复已有主体");
  }
  await showInput();
  if (!quick && !flow.startsWith("multi")) {
    // Establish the same historical context that the public A→B→A reminder returns to.
    await navigate("B"); await navigate("A"); await showInput();
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  canvas.getContext("2d").fillStyle = "#27a573";
  canvas.getContext("2d").fillRect(0, 0, 32, 32);
  const file = new File([await new Promise(resolve => canvas.toBlob(resolve, "image/png"))], "input-operation.png", { type: "image/png" });
  if (flow === "rotation-failure") {
    // The gallery fallback is an SVG illustration; persist a supported raster input first.
    upload([file]);
    await waitFor(() => writes.length === 1 && subject()?.startsWith("data:image/png") && !mode().disabled, "旋转场景应先保存真实 PNG 主体");
    writes.length = 0;
  }
  const original = subject(), originalVersion = version(), originalSelection = selected();
  const revision = (await input()).inputRevision;
  if (flow === "retry" || flow === "remove-recovery") {
    for (const invalid of [new File(["invalid"], "invalid.txt", { type: "text/plain" }), new File(["broken PNG"], "input-operation-broken.png", { type: "image/png" })]) {
      upload([invalid]);
      await frame();
      await waitFor(() => error() && !mode().disabled, "校验或真实解码失败应提示并释放编辑锁");
      assert(subject() === original && selected() === originalSelection && !writes.length && reverse().disabled, "失败须保留原图和选择，阻止提交且不持久化");
      reverse().click(); assert(!starts.length, "失败不可降级为无主体逆向");
    }
    if (flow === "retry") upload([file]); else await remove();
    await waitFor(() => writes.length === 1 && !error() && !reverse().disabled, "重试或明确移除应恢复可用");
    assert(flow === "retry" ? subject() && subject() !== original : !subject(), "恢复应显示已保存输入");
  } else if (flow === "duplicate" || flow === "save-failure") {
    holdWrites = true;
    upload([file]); upload([file]);
    await waitFor(() => writes.length === 1, "上传应进入一次保存");
    await frame();
    assert(writes.length === 1 && subject() === original && selected() === originalSelection && mode().disabled && reverse().disabled, "同轮重复事件只保存一次，提交前保留图和选择并显示忙碌");
    await writes[0].finish(flow === "save-failure" ? "input save failed" : "");
    await waitFor(() => !mode().disabled, "保存结束应释放输入锁");
    if (flow === "save-failure") {
      assert(error().includes("input save failed") && subject() === original && selected() === originalSelection && reverse().disabled, "保存失败应保留输入、选择和提交保护");
      assert((await input()).inputRevision === revision, "保存失败不能改变持久 revision");
    } else {
      await waitFor(() => subject() !== original && selected() === "查看主体图" && !reverse().disabled, "成功保存后才显示并选择新主体");
      assert((await input()).inputRevision === revision + 1, "防重入应只增加一次 revision");
    }
  } else if (flow.includes("late")) {
    const reading = flow.startsWith("read");
    holdReads = reading; holdWrites = !reading;
    upload([file]);
    await waitFor(() => reading ? reads.length === 1 : writes.length === 1, "旧操作应在外部边界挂起");
    await navigate("B"); await navigate("A");
    await waitFor(() => version() === originalVersion && mode().value === "style", "往返必须恢复同项目、模式、版本");
    const currentSubject = subject(), currentSelection = selected();
    const focus = find('[aria-label="查看参考图"]'); focus.focus();
    if (reading) {
      upload([file]);
      await waitFor(() => reads.length === 2, "新上下文应可开始新的读取");
      await reads[0].finish(flow.includes("failure") ? "late decode failure" : "");
      await frame();
      assert(!writes.length && !error() && mode().disabled && reverse().disabled, "旧读取不能保存、显示错误或释放新读取的忙碌状态");
      assert(subject() === currentSubject && selected() === currentSelection && document.activeElement === focus, "旧读取不能改变当前图片、选择或焦点");
      holdReads = false;
      await reads[1].finish();
      await waitFor(() => writes.length === 1 && !mode().disabled, "新读取应能完成保存");
    } else {
      await writes[0].finish(flow.includes("failure") ? "late save failure" : "");
      await waitFor(() => !mode().disabled, "旧保存结束后页面应恢复");
      await frame();
      assert(!error() && subject() === currentSubject && selected() === currentSelection && document.activeElement === focus && version() === originalVersion, "旧保存不得污染往返后的同名上下文或夺取焦点");
      assert((await input()).inputRevision === revision + (flow.includes("failure") ? 0 : 1), "导航只丢弃界面响应，不撤销成功持久写入");
    }
  } else if (flow === "rotation-failure" || flow === "remove-failure") {
    holdWrites = true;
    find('[aria-label="查看主体图"]').click(); await frame();
    if (flow === "rotation-failure") {
      find('[aria-label="放大主体图"]').click();
      const turn = () => [...document.querySelectorAll("dialog[open] button")].find(button => button.textContent === "右转 90°");
      await waitFor(() => turn() && !turn().disabled, "图片预览应打开");
      turn().click();
      await waitFor(() => [...document.querySelectorAll("dialog button")].find(button => button.textContent === "应用旋转" && !button.disabled), "真实旋转应完成");
      [...document.querySelectorAll("dialog button")].find(button => button.textContent === "应用旋转").click();
    } else await remove();
    await waitFor(() => writes.length === 1, "编辑应进入持久保存");
    await writes[0].finish("input edit failed");
    await waitFor(() => error().includes("input edit failed"), "编辑失败应可见");
    assert(subject() === original && selected() === "查看主体图", "失败不得移除原主体或改变选择");
    if (flow === "rotation-failure") assert(find("dialog[open]")?.textContent.includes("input edit failed"), "旋转失败必须传回预览，保持弹窗和错误");
  } else if (flow === "multi-upload") {
    holdReads = true; holdWrites = true;
    const before = [...document.querySelectorAll("[data-image-id]")].map(element => element.dataset.imageId);
    upload([file, new File([file], "input-operation-second.png", { type: "image/png" })]);
    await waitFor(() => reads.length === 2, "两张主体应并发解码");
    await reads[0].finish(); await frame();
    assert(!writes.length, "部分解码完成不能保存空图片占位");
    await reads[1].finish();
    await waitFor(() => writes.length === 1, "全部解码后应一次保存");
    const subjects = writes[0].message.subjects;
    assert(subjects.length === 4 && subjects[0].id === "person" && subjects[0].role === "人物" && subjects[0].detail === "保留五官、短发与身份特征" && subjects[1].id === "cup", "新增主体须保留已有身份、角色、细节及顺序");
    assert(subjects.slice(2).every(item => item.subjectImage.startsWith("data:image/") && item.role === "自动"), "提交主体必须均有完整图片");
    await writes[0].finish();
    await waitFor(() => !mode().disabled && selected() === "查看主体 3", "批次保存成功应选择首张新增主体");
    const after = [...document.querySelectorAll("[data-image-id]")].map(element => element.dataset.imageId);
    assert(before.every((id, index) => after[index] === id), "新增主体不能改变已有图序");
  } else if (flow === "multi-failure") {
    holdWrites = true;
    find('[aria-label="查看主体 1"]').click(); await frame();
    find('[aria-label="主体设置"]').click();
    await waitFor(() => find('[aria-label="主体用途"]'), "主体设置应打开");
    setValue(find('[aria-label="主体用途"]'), "服饰");
    await waitFor(() => writes.length === 1, "角色修改应进入保存");
    await writes[0].finish("role save failed");
    await waitFor(() => error().includes("role save failed") && !mode().disabled, "角色错误应局部显示并释放编辑锁");
    assert(find('[aria-label="主体用途"]').value === "人物", "角色失败保留原角色");
    find('[aria-label="关闭主体设置"]').click();
    const order = [...document.querySelectorAll("[data-image-id]")].map(element => element.dataset.imageId).join();
    find('[aria-label="图片后移"]').click();
    await waitFor(() => writes.length === 2, "排序应进入保存");
    await writes[1].finish("order save failed");
    await waitFor(() => error().includes("order save failed"), "排序错误应局部显示");
    assert(selected() === "查看主体 1" && [...document.querySelectorAll("[data-image-id]")].map(element => element.dataset.imageId).join() === order, "排序失败保留选择和图序");
  } else throw new Error("未知输入操作场景");
  document.documentElement.dataset.inputOperationRegression = "passed";
  find("#preview-notice").textContent = `输入操作回归：PASS · ${quick ? "快捷端" : "工作台"} · ${flow}`;
} catch (reason) {
  document.documentElement.dataset.inputOperationRegression = "failed";
  find("#preview-notice").textContent = `输入操作回归：FAIL · ${flow} · ${reason.message}`;
  console.error(reason);
} finally {
  chrome.runtime.sendMessage = send;
  globalThis.createImageBitmap = bitmap;
}
