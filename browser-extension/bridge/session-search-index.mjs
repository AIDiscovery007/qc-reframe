import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const normalize = text => text.normalize("NFKC").toLowerCase();
const validId = id => typeof id === "string" && /^[\w-]{1,100}$/.test(id);
const summary = row => row && ({ id: row.id, title: row.title, updatedAt: row.updatedAt, archived: !!row.archived });
const grams = text => {
  const chars = Array.from(text, char => char.codePointAt(0).toString(16)), tokens = new Set();
  for (let i = 0; i < chars.length; i++) {
    tokens.add(`u${chars[i]}`);
    if (i) tokens.add(`b${chars[i - 1]}x${chars[i]}`);
  }
  return [...tokens];
};
const protect = action => {
  try { return action(); }
  catch (error) { if (error.status) throw error; throw fail("本机会话检索索引不可用，请重建索引后重试", 503); }
};
function snippet(text, offset) {
  let normalized = 0, position = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (normalized >= offset) break;
    position = part.index + part.segment.length;
    normalized += normalize(part.segment).length;
  }
  const chars = Array.from(text), start = Math.max(0, Array.from(text.slice(0, position)).length - 35);
  return (start ? "…" : "") + chars.slice(start, start + 178).join("") + (start + 178 < chars.length ? "…" : "");
}

// Own private index only; this module never opens Codex's databases or session files.
export function createSessionSearchIndex({ directory, limits = {} }) {
  return protect(() => {
    const bounds = { maxSessions: 5000, maxCharacters: 20_000_000, maxSessionCharacters: 1_000_000, ...limits };
    if (typeof directory !== "string" || !directory || Object.keys(limits).some(key => !["maxSessions", "maxCharacters", "maxSessionCharacters"].includes(key))
      || Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 1)) throw fail("无效的检索索引配置");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw fail("检索索引目录必须是本机独立目录");
    chmodSync(directory, 0o700);
    const path = join(directory, "sessions.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        const stat = lstatSync(path + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail("检索索引文件必须是独立普通文件");
        chmodSync(path + suffix, 0o600);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(file);
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS state (key INTEGER PRIMARY KEY CHECK(key=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, title TEXT NOT NULL, updatedAt REAL NOT NULL, archived INTEGER NOT NULL, characters INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS paragraphs (id INTEGER PRIMARY KEY, sourceId TEXT REFERENCES sources(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS paragraphs_source ON paragraphs(sourceId);
        CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, paragraphId INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE, position INTEGER NOT NULL, normalized TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS chunks_paragraph ON chunks(paragraphId);
        CREATE TABLE IF NOT EXISTS terms (token TEXT NOT NULL, chunkId INTEGER REFERENCES chunks(id) ON DELETE CASCADE, PRIMARY KEY(token,chunkId)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS terms_chunk ON terms(chunkId);`);
      db.prepare("INSERT OR IGNORE INTO state VALUES (1, ?, 0)").run(randomUUID());
    } catch (error) { db.close(); throw error; }
    const atomic = action => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = action(); if (result !== false) db.exec("UPDATE state SET revision=revision+1 WHERE key=1"); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    };
    const insertParagraph = db.prepare("INSERT INTO paragraphs(sourceId,kind,text) VALUES (?,?,?)");
    const insertChunk = db.prepare("INSERT INTO chunks(paragraphId,position,normalized) VALUES (?,?,?)");
    const insertTerms = db.prepare("INSERT INTO terms(token,chunkId) VALUES (?,?)");
    const remove = ids => {
      if (!Array.isArray(ids) || ids.length > bounds.maxSessions || ids.some(id => !validId(id))) throw fail("无效的会话索引编号");
      atomic(() => { const statement = db.prepare("DELETE FROM sources WHERE id=?"); let changes = 0; for (const id of new Set(ids)) changes += statement.run(id).changes; return changes > 0; });
    };
    return {
      get: id => protect(() => { if (!validId(id)) throw fail("无效的会话索引编号"); return summary(db.prepare("SELECT * FROM sources WHERE id=?").get(id)); }),
      list: () => protect(() => db.prepare("SELECT * FROM sources ORDER BY updatedAt DESC,id").all().map(summary)),
      put: (meta, messages) => protect(() => {
        if (!meta || !validId(meta.id) || typeof meta.title !== "string" || meta.title.length > 1000 || !Number.isFinite(meta.updatedAt) || meta.updatedAt < 0
          || typeof meta.archived !== "boolean" || !Array.isArray(messages) || messages.length > 100_000) throw fail("无效的会话索引内容");
        const paragraphs = [{ kind: "title", text: meta.title }];
        let characters = Math.max(meta.title.length, normalize(meta.title).length);
        for (const message of messages) {
          const text = typeof message === "string" ? message : message?.text;
          if (typeof text !== "string") throw fail("会话索引只接受已筛选的文字正文");
          characters += Math.max(text.length, normalize(text).length);
          if (characters > bounds.maxSessionCharacters) throw fail("单个会话超过本机检索索引容量，未截断正文", 413);
          for (const part of text.split(/\r?\n/)) if (part.trim()) paragraphs.push({ kind: "content", text: part });
        }
        if (characters > bounds.maxSessionCharacters || paragraphs.length > 100_000) throw fail("单个会话超过本机检索索引容量，未截断正文", 413);
        atomic(() => {
          const previous = db.prepare("SELECT characters FROM sources WHERE id=?").get(meta.id);
          const total = db.prepare("SELECT count(*) count,coalesce(sum(characters),0) characters FROM sources").get();
          if (total.count + (previous ? 0 : 1) > bounds.maxSessions || total.characters - (previous?.characters || 0) + characters > bounds.maxCharacters)
            throw fail("本机会话检索索引容量已满，未截断正文；请清理索引后重试", 413);
          db.prepare("DELETE FROM sources WHERE id=?").run(meta.id);
          db.prepare("INSERT INTO sources VALUES (?,?,?,?,?)").run(meta.id, meta.title, meta.updatedAt, Number(meta.archived), characters);
          for (const paragraph of paragraphs) {
            const id = insertParagraph.run(meta.id, paragraph.kind, paragraph.text).lastInsertRowid;
            const normalized = normalize(paragraph.text);
            // Normalize before chunking. 200 UTF-16 overlap covers every accepted query term, including compatibility expansions.
            for (let position = 0; position < normalized.length; position += 1848) {
              const chunk = normalized.slice(position, position + 2048);
              const rowid = insertChunk.run(id, position, chunk).lastInsertRowid;
              for (const token of grams(chunk)) insertTerms.run(token, rowid);
            }
          }
        });
        return summary(meta);
      }),
      remove: ids => protect(() => remove(ids)),
      search: (options = {}) => protect(() => {
        if (!options || Object.keys(options).some(key => !["query", "archived", "cursor", "limit"].includes(key))) throw fail("无效的会话搜索参数");
        const { query = "", archived = false, cursor, limit = 30 } = options;
        if (typeof query !== "string" || query.length > 200 || normalize(query).length > 200 || typeof archived !== "boolean"
          || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 1024))) throw fail("搜索内容最多 200 字符，请检查分页参数");
        const normalized = normalize(query).trim(), keywords = [...new Set(normalized.split(/\s+/).filter(Boolean))];
        const state = db.prepare("SELECT epoch,revision FROM state WHERE key=1").get();
        const fingerprint = createHash("sha256").update(JSON.stringify([normalized, archived])).digest("hex");
        let offset = 0;
        if (cursor) {
          let page;
          try { page = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw fail("无效的会话搜索游标"); }
          if (!page || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > bounds.maxSessions || page.fingerprint !== fingerprint) throw fail("无效的会话搜索游标");
          if (page.epoch !== state.epoch || page.revision !== state.revision) throw fail("会话索引已更新，请重新搜索", 409);
          offset = page.offset;
        }
        const matches = new Map();
        if (keywords.length) {
          // Node 22.15 has no FTS5. A gram posting lookup plus exact verification avoids both LIKE scans and costly common-gram intersections.
          const parameters = keywords.map(word => { const tokens = grams(word); return tokens.find(token => token.startsWith("b")) || tokens[0]; });
          const candidates = parameters.map(() => "SELECT chunkId FROM terms WHERE token=?").join(" UNION ");
          const rows = db.prepare(`WITH candidates AS (${candidates}) SELECT c.paragraphId,c.position,c.normalized,p.sourceId,p.kind,s.title,s.updatedAt
            FROM candidates JOIN chunks c ON c.id=candidates.chunkId JOIN paragraphs p ON p.id=c.paragraphId JOIN sources s ON s.id=p.sourceId
            WHERE s.archived=?`);
          for (const row of rows.iterate(...parameters, Number(archived))) {
            const hits = keywords.flatMap((word, index) => row.normalized.includes(word) ? [index] : []);
            if (!hits.length) continue;
            let item = matches.get(row.sourceId);
            if (!item) matches.set(row.sourceId, item = { id: row.sourceId, title: row.title, updatedAt: row.updatedAt, terms: new Set(), titles: new Set(), paragraphs: new Map(), best: null });
            for (const hit of hits) { item.terms.add(hit); if (row.kind === "title") item.titles.add(hit); }
            if (row.kind === "content") {
              const previous = item.paragraphs.get(row.paragraphId) || new Set();
              for (const hit of hits) previous.add(hit);
              item.paragraphs.set(row.paragraphId, previous);
              if (!item.best || hits.length > item.best.hits) item.best = { id: row.paragraphId, hits: hits.length, offset: row.position + row.normalized.indexOf(keywords[hits[0]]) };
            }
          }
        }
        const sorted = keywords.length ? [...matches.values()].filter(item => item.terms.size === keywords.length).sort((a, b) =>
          Number(b.titles.size > 0) - Number(a.titles.size > 0) || b.titles.size - a.titles.size ||
          [...b.paragraphs.values()].reduce((sum, hits) => sum + hits.size, 0) - [...a.paragraphs.values()].reduce((sum, hits) => sum + hits.size, 0) ||
          b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          : db.prepare("SELECT id,title,updatedAt FROM sources WHERE archived=? ORDER BY updatedAt DESC,id").all(Number(archived));
        const data = sorted.slice(offset, offset + limit).map(item => ({ id: item.id, title: item.title, updatedAt: item.updatedAt,
          match: item.titles?.size || !keywords.length ? "title" : "content",
          ...(item.best ? { snippet: snippet(db.prepare("SELECT text FROM paragraphs WHERE id=?").get(item.best.id).text, item.best.offset) } : {}),
        }));
        return { data, nextCursor: offset + limit < sorted.length ? Buffer.from(JSON.stringify({ ...state, fingerprint, offset: offset + limit })).toString("base64url") : null };
      }),
      clear: () => protect(() => { atomic(() => db.exec("DELETE FROM sources")); db.exec("VACUUM"); }),
      close: () => protect(() => { if (db.isOpen) db.close(); }),
    };
  });
}
