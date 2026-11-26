#!/usr/bin/env bash
# QC-Reframe one-command installer for macOS and Linux:
#   curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
# Downloads the release runtime package, verifies its SHA-256, installs it into QC_REFRAME_DIR
# (default ~/QC-Reframe), runs setup and starts the local service. Upgrades keep .local
# (projects, pairing and settings) and any file the package does not own.
# Options: QC_REFRAME_DIR, QC_REFRAME_VERSION (e.g. 0.7.0; default latest release),
# QC_REFRAME_BASE_URL (a mirror serving qc-reframe-runtime.tar.gz and SHA256SUMS).
# Everything runs inside main, so a truncated download through a pipe never runs half a script.
set -euo pipefail

main() {
  local repo="https://github.com/AIDiscovery007/qc-reframe" archive="qc-reframe-runtime.tar.gz"
  say() { printf '%s\n' "$*"; }
  fail() { printf 'QC-Reframe 安装失败：%s\n' "$*" >&2; exit 1; }
  sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

  case "$(uname -s)" in Darwin|Linux) ;; *) fail "一键安装只支持 macOS 和 Linux；Windows 请按 README 从源码安装。" ;; esac
  for tool in curl tar node npm; do
    command -v "$tool" >/dev/null 2>&1 || fail "找不到 $tool。请先安装 Node.js 22.15+ LTS（含 npm）：https://nodejs.org/"
  done
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 15) ? 0 : 1)' \
    || fail "需要 Node.js 22.15+，当前为 $(node --version)。"

  local dir="${QC_REFRAME_DIR:-$HOME/QC-Reframe}"
  case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
  while [ "$dir" != "/" ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  if [ "$dir" = "/" ] || [ "$dir" = "${HOME%/}" ]; then fail "安装目录不能是根目录或主目录，请用 QC_REFRAME_DIR 指定专用目录。"; fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then fail "$dir 已存在且不是目录，未改动任何文件。"; fi
  # Only an empty folder or an earlier runtime-package installation may be written to.
  if [ -d "$dir" ] && [ ! -f "$dir/runtime-package.json" ] && [ -n "$(ls -A "$dir")" ]; then
    fail "$dir 已存在且不是 QC-Reframe 运行包安装目录，未改动任何文件。请用 QC_REFRAME_DIR 指定空目录。"
  fi

  local base="${QC_REFRAME_BASE_URL:-}"
  if [ -z "$base" ] && [ -n "${QC_REFRAME_VERSION:-}" ]; then base="$repo/releases/download/v${QC_REFRAME_VERSION#v}"; fi
  base="${base:-$repo/releases/latest/download}"

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/qc-reframe-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  say "下载 QC-Reframe 运行包：$base/$archive"
  curl -fsSL --retry 2 -o "$tmp/$archive" "$base/$archive" || fail "无法下载 $base/$archive，未改动任何文件。"
  curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "无法下载 $base/SHA256SUMS，未改动任何文件。"
  local expected
  expected="$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS 中没有 $archive，未改动任何文件。"
  [ "$(sha256 "$tmp/$archive")" = "$expected" ] || fail "运行包 SHA-256 校验失败，未改动任何文件。请重试，或到 $repo/releases 手动下载。"
  mkdir "$tmp/package"
  tar -xzf "$tmp/$archive" -C "$tmp/package" </dev/null || fail "运行包解压失败，未改动任何文件。"
  local new="$tmp/package/qc-reframe"
  [ -f "$new/runtime-package.json" ] || fail "下载的文件不是 QC-Reframe 运行包，未改动任何文件。"
  local version
  version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$new/runtime-package.json")"

  # An interrupted earlier copy may lack the manager; its service was already stopped then.
  if [ -f "$dir/runtime-package.json" ] && [ -f "$dir/scripts/manage.mjs" ]; then
    say "停止 $dir 的现有服务…"
    (cd "$dir" && node scripts/manage.mjs stop </dev/null) || fail "无法停止现有服务，未改动安装文件。"
  fi
  mkdir -p "$dir"
  # Replace only what the package owns; .local stays, and dependencies are reinstalled for the new lockfile.
  local path name
  for path in "$new"/* "$new"/.[!.]* "$dir/node_modules"; do
    name="${path##*/}"
    if [ "$name" != ".local" ] && { [ -e "$path" ] || [ -L "$path" ]; }; then rm -rf "${dir:?}/$name"; fi
  done
  cp -R "$new/." "$dir/" || fail "复制文件到 $dir 失败；重新运行安装命令即可，数据目录 .local 未改动。"

  cd "$dir"
  say "初始化：安装运行依赖、检查 Codex、注册浏览器启动器…"
  npm run setup </dev/null || fail "初始化失败；按上面的提示修复后重新运行安装命令，数据目录 .local 已保留。"
  npm start </dev/null || fail "服务启动失败；修复后在 $dir 运行 npm start。"

  local extension="$dir/.output/chrome-mv3"
  say ""
  say "QC-Reframe $version 已安装到 $dir，本机服务已在后台运行。"
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
