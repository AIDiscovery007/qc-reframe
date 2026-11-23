// Request parsing and image validation shared by every HTTP route.
export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_BODY = 24 * 1024 * 1024;
export const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function sourceUrlFor(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) {
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch {}
  return "";
}

export async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw bad("Content-Type must be application/json", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bad("请求过大", 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad("无效 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("无效请求");
  return body;
}

export function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_BODY)
    throw bad("图片过大，最多 8 MB");
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw bad("仅支持 PNG、JPEG、WebP 图片");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE)
    throw bad("图片为空或超过 8 MB");
  const signatures = {
    png: bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    webp:
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP",
  };
  if (!signatures[match[1]]) throw bad("图片内容与格式不匹配");
  return { bytes, extension: match[1] };
}

export function decodeSubjects(subjects, referenceBytes, draft = false) {
  if (!Array.isArray(subjects) || subjects.length < (draft ? 0 : 2) || subjects.length > 6)
    throw bad("多图重演需要 2–6 张主体图");
  const ids = new Set();
  const decoded = subjects.map((subject) => {
    if (!subject || typeof subject.id !== "string" || !/^[\w-]{1,100}$/.test(subject.id) || ids.has(subject.id))
      throw bad("主体编号无效或重复");
    ids.add(subject.id);
    if (!["自动", "人物", "物品", "服饰", "场景", "细节"].includes(subject.role) || typeof subject.detail !== "string" || subject.detail.length > 2000)
      throw bad("主体职责无效，补充要求最多 2000 字符");
    const image = decodeImage(subject.subjectImage);
    if (image.bytes.length > 2 * 1024 * 1024) throw bad("每张主体图最多 2 MB，请压缩后重试");
    return { id: subject.id, role: subject.role, detail: subject.detail.trim(), ...image };
  });
  if (referenceBytes > 4 * 1024 * 1024 || decoded.reduce((total, item) => total + item.bytes.length, referenceBytes) > 16 * 1024 * 1024)
    throw bad("参考图最多 4 MB，全部图片合计最多 16 MB");
  return decoded;
}
