#!/usr/bin/env bash
# QC-Reframe one-command installer for macOS and Linux:
#   curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
# Downloads the release runtime package, verifies its SHA-256, installs it into QC_REFRAME_DIR
# (default ~/QC-Reframe), runs setup and starts the local service. Upgrades keep .local
# (projects, pairing and settings) and any file the package does not own.
# Options: QC_REFRAME_DIR, QC_REFRAME_VERSION (e.g. 0.8.0; default latest release; the package must be that version),
# QC_REFRAME_BASE_URL (a mirror serving qc-reframe-runtime.tar.gz, SHA256SUMS and SHA256SUMS.sig),
# QC_REFRAME_REQUIRE_SIGNATURE=1 (refuse a release without a signature; the extension's upgrade always sets it).
# Releases from v0.8.0 sign SHA256SUMS with the key below; a signature that does not verify always stops the install.
# An upgrade keeps the previous version aside until the new one has started, and puts it back if anything fails.
# Everything runs inside main, so a truncated download through a pipe never runs half a script.
set -euo pipefail

main() {
  local repo="https://github.com/AIDiscovery007/qc-reframe" archive="qc-reframe-runtime.tar.gz"
  # Marks the folder as ours while its files are being replaced, so an interrupted copy can be retried.
  local pending=".qc-reframe-install-pending"
  # Holds the previous version's files during an upgrade, until the new version has started.
  local previous=".qc-reframe-previous"
  # Ed25519 public key (SPKI, base64) whose private half signs SHA256SUMS in the release workflow.
  local signing_key="MCowBQYDK2VwAyEAJwJD2t90DjeLsBzTGC4wydAWmW4/RltK0c3WlSaeewg="
  # stage names the step a failure belongs to; result and from are set when an existing installation is upgraded.
  local stage="download" result="" from="" target="${QC_REFRAME_VERSION:-}" backup=""
  target="${target#v}"
  say() { printf '%s\n' "$*"; }
  # Records how an upgrade of an existing installation ended, for the extension's settings page.
  record() {
    [ -n "$result" ] || return 0
    node -e '
      const fs = require("fs"), path = require("path");
      const [file, version, from, outcome, stage] = process.argv.slice(1);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const value = { version: version || null, from: from || null, outcome, stage: stage || null, at: new Date().toISOString() };
      fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    ' "$result" "$target" "$from" "$1" "${2:-}" </dev/null >/dev/null 2>&1 || true
  }
  fail() { printf 'QC-Reframe 安装失败：%s\n' "$*" >&2; record failed "$stage"; exit 1; }
  # Every name the new package owns, plus node_modules; .local is never among them.
  owned() {
    local path name
    for path in "$new"/* "$new"/.[!.]* "$dir/node_modules"; do
      name="${path##*/}"
      if [ "$name" != ".local" ] && [ "$name" != "$previous" ] && { [ -e "$path" ] || [ -L "$path" ]; }; then printf '%s\n' "$name"; fi
    done
  }
  # Puts the previous version back after a failed upgrade and starts it again. Runs inside `||`, so it checks each step itself.
  restore() {
    printf 'QC-Reframe 升级失败：%s。正在恢复 %s…\n' "$1" "${from:-原版本}" >&2
    : > "$dir/$pending"
    (cd "$dir" && node scripts/manage.mjs stop </dev/null >/dev/null 2>&1) || true
    local name path
    while IFS= read -r name; do rm -rf "${dir:?}/$name"; done < <(owned)
    for path in "$dir/$previous"/* "$dir/$previous"/.[!.]*; do
      { [ -e "$path" ] || [ -L "$path" ]; } || continue
      if ! mv "$path" "$dir/"; then
        printf 'QC-Reframe 安装失败：无法恢复 %s，旧版本文件仍在 %s；重新运行安装命令即可完成安装，数据目录 .local 未改动。\n' "${from:-原版本}" "$dir/$previous" >&2
        record failed "$stage"
        exit 1
      fi
    done
    rmdir "$dir/$previous" 2>/dev/null || true
    rm -f "$dir/$pending"
    record rolled_back "$stage"
    if (cd "$dir" && node scripts/manage.mjs start </dev/null); then
      printf 'QC-Reframe 升级失败：%s；已恢复 %s 并重新启动服务，数据目录 .local 未改动。\n' "$1" "${from:-原版本}" >&2
    else
      printf 'QC-Reframe 升级失败：%s；已恢复 %s，但服务未能启动，请在 %s 运行 npm start。\n' "$1" "${from:-原版本}" "$dir" >&2
    fi
    exit 1
  }
  sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

  case "$(uname -s)" in Darwin|Linux) ;; *) fail "一键安装只支持 macOS 和 Linux；Windows 请按 README 从源码安装。" ;; esac
  for tool in curl tar node npm; do
    command -v "$tool" >/dev/null 2>&1 || fail "找不到 ${tool}。请先安装 Node.js 22.15+ LTS（含 npm）：https://nodejs.org/"
  done
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 15) ? 0 : 1)' \
    || fail "需要 Node.js 22.15+，当前为 $(node --version)。"

  local dir="${QC_REFRAME_DIR:-$HOME/QC-Reframe}"
  case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
  while [ "$dir" != "/" ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  if [ "$dir" = "/" ] || [ "$dir" = "${HOME%/}" ]; then fail "安装目录不能是根目录或主目录，请用 QC_REFRAME_DIR 指定专用目录。"; fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then fail "$dir 已存在且不是目录，未改动任何文件。"; fi
  # Only an empty folder, an earlier runtime-package installation or one this installer was replacing may be written to.
  if [ -d "$dir" ] && [ ! -f "$dir/runtime-package.json" ] && [ ! -f "$dir/$pending" ] && [ -n "$(ls -A "$dir")" ]; then
    fail "$dir 已存在且不是 QC-Reframe 运行包安装目录，未改动任何文件。请用 QC_REFRAME_DIR 指定空目录。"
  fi
  if [ -f "$dir/runtime-package.json" ]; then
    result="${ALCHEMY_DATA_DIR:-$dir/.local}/runtime/upgrade-result.json"
    from="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$dir/runtime-package.json" 2>/dev/null || true)"
  fi

  local base="${QC_REFRAME_BASE_URL:-}"
  if [ -z "$base" ] && [ -n "$target" ]; then base="$repo/releases/download/v$target"; fi
  base="${base:-$repo/releases/latest/download}"

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/qc-reframe-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  say "下载 QC-Reframe 运行包：$base/$archive"
  curl -fsSL --retry 2 -o "$tmp/$archive" "$base/$archive" || fail "无法下载 $base/${archive}，未改动任何文件。"
  curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "无法下载 $base/SHA256SUMS，未改动任何文件。"
  stage=verify
  if curl -fsL --retry 2 -o "$tmp/SHA256SUMS.sig" "$base/SHA256SUMS.sig" 2>/dev/null; then
    node -e '
      const fs = require("fs"), crypto = require("crypto");
      const [key, sums, sig] = process.argv.slice(1);
      try {
        const signature = Buffer.from(fs.readFileSync(sig, "utf8").trim(), "base64");
        const publicKey = crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
        process.exit(signature.length === 64 && crypto.verify(null, fs.readFileSync(sums), publicKey, signature) ? 0 : 1);
      } catch { process.exit(1); }
    ' "$signing_key" "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.sig" </dev/null \
      || fail "SHA256SUMS 签名校验失败，未改动任何文件。这不是 QC-Reframe 发布的文件，请到 $repo/releases 核对。"
  elif [ "${QC_REFRAME_REQUIRE_SIGNATURE:-}" = 1 ]; then
    fail "无法获取 SHA256SUMS.sig 发布签名，未改动任何文件。请稍后重试。"
  else
    say "注意：此版本没有发布签名，只校验了 SHA-256。"
  fi
  local expected
  expected="$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS 中没有 ${archive}，未改动任何文件。"
  [ "$(sha256 "$tmp/$archive")" = "$expected" ] || fail "运行包 SHA-256 校验失败，未改动任何文件。请重试，或到 $repo/releases 手动下载。"
  mkdir "$tmp/package"
  tar -xzf "$tmp/$archive" -C "$tmp/package" </dev/null || fail "运行包解压失败，未改动任何文件。"
  local new="$tmp/package/qc-reframe"
  [ -f "$new/runtime-package.json" ] || fail "下载的文件不是 QC-Reframe 运行包，未改动任何文件。"
  local version
  version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$new/runtime-package.json")"
  [ -z "$target" ] || [ "$version" = "$target" ] || fail "下载的运行包是 ${version}，不是请求的 ${target}，未改动任何文件。"
  target="$version"

  # A complete installation is stopped and kept aside for rollback. A pending marker means an earlier run was
  # interrupted after stopping the service: its folder is finished by a plain replacement, without rollback.
  if [ -f "$dir/runtime-package.json" ] && [ ! -f "$dir/$pending" ] && [ -f "$dir/scripts/manage.mjs" ]; then
    stage=stop
    say "停止 $dir 的现有服务…"
    (cd "$dir" && node scripts/manage.mjs stop </dev/null) || fail "无法停止现有服务，未改动安装文件。"
    backup=1
  fi
  stage=replace
  mkdir -p "$dir"
  rm -rf "${dir:?}/$previous"
  if [ -n "$backup" ]; then mkdir "$dir/$previous" || restore "无法写入 $dir"; fi
  : > "$dir/$pending" || { [ -z "$backup" ] || restore "无法写入 $dir"; fail "无法写入 ${dir}，未改动安装文件。"; }
  # Replace only what the package owns; .local stays, and dependencies are reinstalled for the new lockfile.
  local name
  while IFS= read -r name; do
    if [ -z "$backup" ]; then rm -rf "${dir:?}/$name"
    elif [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then mv "$dir/$name" "$dir/$previous/$name" || restore "无法移开旧版本文件"; fi
  done < <(owned)
  cp -R "$new/." "$dir/" || { [ -z "$backup" ] || restore "复制新版本文件失败"; fail "复制文件到 $dir 失败；重新运行安装命令即可，数据目录 .local 未改动。"; }
  rm -f "$dir/$pending"

  cd "$dir"
  stage=setup
  say "初始化：安装运行依赖、检查 Codex、注册浏览器启动器…"
  npm run setup </dev/null || { [ -z "$backup" ] || restore "新版本初始化失败"; fail "初始化失败；按上面的提示修复后重新运行安装命令，数据目录 .local 已保留。"; }
  stage=start
  npm start </dev/null || { [ -z "$backup" ] || restore "新版本服务启动失败"; fail "服务启动失败；修复后在 $dir 运行 npm start。"; }
  rm -rf "${dir:?}/$previous"
  record upgraded

  local extension="$dir/.output/chrome-mv3"
  say ""
  say "QC-Reframe $version 已安装到 ${dir}，本机服务已在后台运行。"
  say "最后一步，在浏览器加载扩展（只需一次）："
  say "  1. 打开 chrome://extensions，开启右上角「开发者模式」"
  say "  2. 点「加载已解压的扩展程序」，选择：$extension"
  say "     .output 是隐藏目录：macOS 在选择窗口按 ⌘⇧G 粘贴上面的路径。"
  say "已加载过：在 chrome://extensions 点 QC-Reframe 的重新加载按钮，并刷新已打开的网页。"
  if [ "$(uname -s)" = Darwin ] && [ -t 1 ]; then
    if printf '%s' "$extension" | pbcopy 2>/dev/null; then say "扩展路径已复制到剪贴板。"; fi
    open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || true
  fi
}

main "$@"
