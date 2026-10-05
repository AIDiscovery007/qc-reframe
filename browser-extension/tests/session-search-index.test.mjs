import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionSearchIndex } from "../bridge/session-search-index.mjs";

function fixture(t, limits) {
  const root = mkdtempSync(join(tmpdir(), "reframe-search-test-")), directory = join(root, "private");
  let index = createSessionSearchIndex({ directory, limits });
  t.after(() => { index.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, get index() { return index; }, reopen() { index.close(); index = createSessionSearchIndex({ directory, limits }); return index; } };
}
const meta = (id, title = "创作记录", updatedAt = 1, archived = false) => ({ id, title, updatedAt, archived });
const ids = result => result.data.map(row => row.id);
const status = expected => error => error.status === expected;

test("indexes Chinese single characters, two-character names, English case and NFKC while returning original snippets", t => {
  const { index } = fixture(t);
  index.put(meta("story"), ["林夏走过海边，拿着 Ｃｏｆｆｅｅ。", { text: "Next chapter: naïve café" }]);
  for (const query of ["林", "林夏", "海边", "coffee", "COFFEE", "ＣＯＦＦＥＥ", "café", "naïve"])
    assert.deepEqual(ids(index.search({ query })), ["story"], query);
  const result = index.search({ query: "coffee" });
  assert.equal(result.data[0].snippet, "林夏走过海边，拿着 Ｃｏｆｆｅｅ。");
  assert.equal(result.data[0].match, "content");
  assert.deepEqual(Object.keys(result.data[0]).sort(), ["id", "match", "snippet", "title", "updatedAt"]);
});

test("AND keywords aggregate across whole session, but each keyword requires the exact substring", t => {
  const { index } = fixture(t);
  index.put(meta("complete", "海边故事"), ["林夏拿着相机", "后来出现一只猫"]);
  index.put(meta("partial"), ["林夏独自走着"]);
  index.put(meta("grams"), ["ab ac ba"]);
  assert.deepEqual(ids(index.search({ query: "林夏 猫 海边" })), ["complete"]);
  assert.deepEqual(ids(index.search({ query: "林夏拿着相机" })), ["complete"]);
  assert.deepEqual(ids(index.search({ query: "abacba" })), []);
  assert.deepEqual(ids(index.search({ query: "林夏猫" })), []);
});

test("literal punctuation cannot become search operators or SQL syntax", t => {
  const { index } = fixture(t);
  index.put(meta("literal"), ["literal \") OR * -- token", "甲'乙", "near(猫)"]);
  index.put(meta("unrelated"), ["别的正文"]);
  for (const query of ["\")", "*", "甲'乙", "near(猫)"])
    assert.deepEqual(ids(index.search({ query })), ["literal"]);
  assert.deepEqual(ids(index.search({ query: "' UNION SELECT" })), []);
});

test("ranks title matches before content relevance, then updatedAt; excludes archived unless requested", t => {
  const { index } = fixture(t);
  index.put(meta("title", "海边", 1), []);
  index.put(meta("frequent", "A", 2), ["海边一", "海边二"]);
  index.put(meta("recent", "B", 9), ["海边三"]);
  index.put(meta("older", "C", 3), ["海边四"]);
  index.put(meta("archive", "海边", 100, true), ["海边五"]);
  assert.deepEqual(ids(index.search({ query: "海边" })), ["title", "frequent", "recent", "older"]);
  assert.equal(index.search({ query: "海边" }).data[0].match, "title");
  assert.deepEqual(ids(index.search({ query: "海边", archived: true })), ["archive"]);
  assert.deepEqual(ids(index.search({ query: "  " })), ["recent", "older", "frequent", "title"]);
});

test("long paragraphs match phrases spanning chunk boundaries and snippets retain original text within 180 characters", t => {
  const { index } = fixture(t);
  const phrase = "林夏在海边寻找遗失的相机".repeat(10);
  index.put(meta("boundary"), ["甲".repeat(2035) + phrase + "乙".repeat(3000)]);
  const result = index.search({ query: phrase });
  assert.deepEqual(ids(result), ["boundary"]);
  assert.ok(Array.from(result.data[0].snippet).length <= 180);
  assert.ok(result.data[0].snippet.includes("林夏在海边寻找遗失的相机"));
  index.put(meta("expanded"), ["ﷺ".repeat(1000) + "ＷＯＲＬＤ" + "🙂".repeat(300)]);
  const expanded = index.search({ query: "world" }).data[0].snippet;
  assert.ok(expanded.includes("ＷＯＲＬＤ"));
  assert.ok(Array.from(expanded).length <= 180);
});

test("pagination is deterministic, tied to query/archive and invalidated on mutation including clear/restart", t => {
  const f = fixture(t);
  for (const id of ["c", "b", "a"]) f.index.put(meta(id, "猫", 1), ["猫"]);
  const first = f.index.search({ query: "猫", limit: 1 });
  assert.deepEqual(ids(first), ["a"]);
  const second = f.reopen().search({ query: "猫", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(ids(second), ["b"]);
  f.index.remove([]); f.index.remove(["not-present"]);
  assert.deepEqual(ids(f.index.search({ query: "猫", cursor: second.nextCursor })), ["c"]);
  assert.throws(() => f.index.search({ query: "狗", cursor: first.nextCursor }), status(400));
  assert.throws(() => f.index.search({ query: "猫", archived: true, cursor: first.nextCursor }), status(400));
  f.index.put(meta("a", "猫", 2), ["猫"]);
  assert.throws(() => f.index.search({ query: "猫", cursor: first.nextCursor }), error => error.status === 409 && error.message.includes("重新搜索"));
  const beforeClear = f.index.search({ limit: 1 }).nextCursor;
  f.index.clear();
  assert.throws(() => f.index.search({ cursor: beforeClear }), status(409));
});

test("atomic replacement removes old text, bulk deletion persists after restart, metadata never contains transcript", t => {
  const f = fixture(t);
  f.index.put(meta("a", "原题"), ["旧正文"]);
  f.index.put(meta("a", "新题", 5, true), ["新正文"]);
  assert.deepEqual(ids(f.index.search({ query: "旧正文", archived: true })), []);
  assert.deepEqual(ids(f.index.search({ query: "新正文", archived: true })), ["a"]);
  assert.deepEqual(f.index.get("a"), meta("a", "新题", 5, true));
  f.index.put(meta("b"), ["保留正文"]);
  f.index.put(meta("c"), ["删除正文"]);
  f.index.remove(["a", "c", "a"]);
  assert.deepEqual(f.reopen().list(), [meta("b")]);
  assert.equal(f.index.get("a"), undefined);
  assert.deepEqual(ids(f.index.search({ query: "删除正文" })), []);
});

test("resource limits reject whole updates without truncating or destroying prior searchable content", t => {
  const { index } = fixture(t, { maxSessions: 2, maxCharacters: 30, maxSessionCharacters: 20 });
  index.put(meta("a", "A"), ["原文"]);
  assert.throws(() => index.put(meta("a", "A"), ["x".repeat(20)]), status(413));
  assert.deepEqual(ids(index.search({ query: "原文" })), ["a"]);
  index.put(meta("b", "B"), ["x".repeat(19)]);
  assert.throws(() => index.put(meta("c", "C"), []), status(413));
  assert.throws(() => index.put(meta("a", "A"), ["y".repeat(19)]), status(413));
  assert.deepEqual(ids(index.search({ query: "原文" })), ["a"]);
  assert.throws(() => index.put(meta("a", "A"), ["ﷺ".repeat(2)]), status(413));
  index.remove(["b"]);
  index.put(meta("a", "A"), ["y".repeat(19)]);
  assert.deepEqual(ids(index.search({ query: "原文" })), []);
});

test("failed insertion rolls the replacement back atomically and sanitizes database errors", t => {
  const { index, directory } = fixture(t);
  index.put(meta("a"), ["原正文"]);
  const db = new DatabaseSync(join(directory, "sessions.sqlite"));
  db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON chunks WHEN new.normalized='reject-me' BEGIN SELECT RAISE(ABORT,'PRIVATE_FAILURE_TEXT'); END");
  db.close();
  assert.throws(() => index.put(meta("a"), ["reject-me"]), error => error.status === 503 && !error.message.includes("PRIVATE_FAILURE_TEXT"));
  assert.deepEqual(ids(index.search({ query: "原正文" })), ["a"]);
  assert.deepEqual(ids(index.search({ query: "reject-me" })), []);
});

test("private filesystem permissions and clear remove all stored transcript and postings", t => {
  const f = fixture(t), secret = "UNIQUE_PRIVATE_TRANSCRIPT_82df9347";
  f.index.put(meta("a"), [secret]);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.directory, "sessions.sqlite")).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(f.directory, "sessions.sqlite")).includes(secret));
  f.index.clear();
  assert.deepEqual(f.index.list(), []);
  assert.deepEqual(ids(f.index.search({ query: secret })), []);
  for (const file of readdirSync(f.directory)) assert.ok(!readFileSync(join(f.directory, file)).includes(secret));
  assert.deepEqual(f.reopen().list(), []);
  const db = new DatabaseSync(join(f.directory, "sessions.sqlite"));
  for (const table of ["sources", "paragraphs", "chunks", "terms"]) assert.equal(db.prepare(`SELECT count(*) count FROM ${table}`).get().count, 0);
  db.close();
});

test("rejects symbolic directories, symbolic/nonregular/hardlinked database files", t => {
  const root = mkdtempSync(join(tmpdir(), "reframe-search-path-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = join(root, "actual"); mkdirSync(actual);
  symlinkSync(actual, join(root, "linked"));
  assert.throws(() => createSessionSearchIndex({ directory: join(root, "linked") }));
  for (const kind of ["symbolic", "directory", "hardlink", "wal"]) {
    const directory = join(root, kind); mkdirSync(directory);
    const path = join(directory, kind === "wal" ? "sessions.sqlite-wal" : "sessions.sqlite");
    if (kind === "directory") mkdirSync(path);
    else { const target = join(root, `${kind}-target`); writeFileSync(target, ""); if (kind === "hardlink") linkSync(target, path); else symlinkSync(target, path); }
    assert.throws(() => createSessionSearchIndex({ directory }));
  }
});

test("validates parameters without leaking raw content or accepting malformed cursors", t => {
  const { index } = fixture(t);
  for (const options of [null, { query: 1 }, { query: "a".repeat(201) }, { query: "ﷺ".repeat(20) }, { archived: "true" }, { limit: 0 }, { limit: 101 }, { limit: 1.2 }, { cursor: "garbage" }, { cursor: "" }, { unexpected: true }])
    assert.throws(() => index.search(options), status(400));
  for (const message of [[{}], [null], [123]]) assert.throws(() => index.put(meta("a"), message), status(400));
  for (const bad of [{ ...meta("a"), updatedAt: NaN }, { ...meta("a"), archived: 1 }, meta("../../private"), { ...meta("a"), title: 1 }])
    assert.throws(() => index.put(bad, []), status(400));
  assert.throws(() => index.remove(["../../private"]), status(400));
  assert.throws(() => index.get("../../private"), status(400));
  index.close();
  assert.throws(() => index.search({ query: "SECRET_CONTENT" }), error => error.status === 503 && !error.message.includes("SECRET_CONTENT"));
});
