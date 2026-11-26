import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";

/** Offline hint for extension pages only: the exact command that starts this installation. */
export default function StartCommand() {
  const [command, setCommand] = useState<string | null>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    let current = true;
    request<{ command: string | null }>({ type: "alchemy:start-command" })
      .then(value => { if (current) setCommand(value?.command ?? null); }, () => { if (current) setCommand(null); });
    return () => { current = false; clearTimeout(timer.current); };
  }, []);
  if (command === undefined) return null;
  // Before the first successful connection the folder is unknown; name the step instead.
  if (!command) return <div className="start-command"><span>在 QC-Reframe 安装目录的终端运行 <code>npm start</code> 启动本机服务。</span></div>;
  const copy = async () => {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { setCopyError("复制失败，请选中命令手动复制。"); }
  };
  return <div className="start-command">
    <span>在终端运行以下命令启动本机服务：</span>
    <button type="button" className="text-button" onClick={() => void copy()}>{copied ? "已复制" : "复制命令"}</button>
    <code>{command}</code>
    {copyError && <span role="alert">{copyError}</span>}
  </div>;
}
