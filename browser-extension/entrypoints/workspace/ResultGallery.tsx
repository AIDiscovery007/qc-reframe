import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GalleryWork } from "../../lib/types";
import { galleryAnchor, galleryLayout } from "../../lib/gallery-layout";
import { showMotionDialog } from "../../lib/motion-dialog";
import Icon from "../popup/Icon";
import SelectField from "../popup/SelectField";
import GalleryImage, { thumbnailLoader } from "./GalleryImage";
import useGallery from "./useGallery";

const modes = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };
const day = (value: string) => new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });

export default function ResultGallery({ connected, revision, showHidden, hiddenProjectIds, visibilityToggle, onOpen }: {
  connected: boolean; revision: string; showHidden: boolean; hiddenProjectIds: string[]; visibilityToggle: ReactNode;
  onOpen(work: GalleryWork): Promise<void>;
}) {
  const [search, setSearch] = useState(""), [projectId, setProject] = useState(""), [ratio, setRatio] = useState("all"), [sort, setSort] = useState("newest"), [dense, setDense] = useState(false);
  const gallery = useGallery({ search, projectId, ratio, sort }, connected, revision, showHidden);
  const { data, loading, error } = gallery;
  const items = useMemo(() => data.items.filter(work => showHidden || !hiddenProjectIds.includes(work.projectId)), [data.items, showHidden, hiddenProjectIds]);
  const [currentId, setCurrent] = useState(""), [focusedId, setFocused] = useState(""), [openError, setOpenError] = useState(""), [opening, setOpening] = useState(false);
  const previewRevision = useRef(0);
  function selectPreview(id: string) { previewRevision.current++; setCurrent(id); }
  useEffect(() => () => { previewRevision.current++; }, []);
  const current = items.find(work => work.id === currentId), currentIndex = items.findIndex(work => work.id === currentId);
  const scroller = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), pending = useRef(0);
  const opener = useRef<HTMLElement | null>(null), focusTarget = useRef("");
  const load = useMemo(thumbnailLoader, []);
  const [viewport, setViewport] = useState({ top: 0, height: 800, width: 1000 });
  const position = useMemo(() => galleryLayout(items, viewport.width, dense), [items, viewport.width, dense]);
  const previous = useRef<typeof position | null>(null), snapshot = useRef({ top: 0, max: 0 });
  const previousKey = useRef(gallery.key);
  function measure() {
    const el = scroller.current;
    if (el) setViewport(old => old.top === el.scrollTop && old.height === el.clientHeight && old.width === el.clientWidth ? old : { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
  }
  function remember() {
    const el = scroller.current;
    if (el) snapshot.current = { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  }
  useLayoutEffect(() => {
    const old = previous.current, el = scroller.current, { top, max } = snapshot.current;
    if (el && previousKey.current !== gallery.key) {
      el.scrollTop = 0; selectPreview(""); setFocused(""); previousKey.current = gallery.key;
    } else if (el && old && top > 0) {
      const reflow = old.width !== position.width || old.gap !== position.gap;
      // New pages extend the canvas without dragging the reader to the new bottom.
      const changed = old.items[0]?.id !== position.items[0]?.id || old.items.some((work, index) => work.id !== position.items[index]?.id);
      if (reflow && Math.abs(max - top) < 2) el.scrollTop = el.scrollHeight;
      else if (reflow || changed) el.scrollTop = galleryAnchor(old, position, top);
    }
    previous.current = position; measure(); remember();
  }, [position, gallery.key]);
  useLayoutEffect(() => {
    measure(); const observer = new ResizeObserver(measure);
    if (scroller.current) observer.observe(scroller.current);
    return () => { observer.disconnect(); cancelAnimationFrame(pending.current); };
  }, []);
  function onScroll() {
    remember();
    if (!pending.current) pending.current = requestAnimationFrame(() => { pending.current = 0; measure(); });
  }
  useEffect(() => {
    if (items.length && viewport.top + viewport.height > position.height - 650 && !error && !loading) void gallery.more();
  }, [viewport.top, viewport.height, position.height, items.length, data.total, loading, error]);
  useEffect(() => {
    if (!current) { previewRevision.current++; return; }
    setOpenError("");
    const close = showMotionDialog(dialog.current!);
    return () => { close(); if (!opener.current?.isConnected) scroller.current?.focus({ preventScroll: true }); };
  }, [!!current]);
  const visible = position.rects.filter(rect => rect.y + rect.height > viewport.top - 650 && rect.y < viewport.top + viewport.height + 650 || rect.work.id === focusedId);
  useLayoutEffect(() => {
    if (!focusTarget.current) return;
    const target = Array.from(scroller.current?.querySelectorAll<HTMLButtonElement>(".art-card") || []).find(button => button.dataset.work === focusTarget.current);
    if (target) { target.focus({ preventScroll: true }); focusTarget.current = ""; }
  }, [visible]);
  function focus(index: number) {
    const rect = position.rects[index], el = scroller.current;
    if (!rect || !el) return;
    setFocused(rect.work.id); focusTarget.current = rect.work.id;
    if (rect.y < el.scrollTop || rect.y + rect.height > el.scrollTop + el.clientHeight) el.scrollTop = rect.y;
    measure();
  }
  async function next() {
    if (currentIndex + 1 < items.length) selectPreview(items[currentIndex + 1]!.id);
    else {
      const ticket = previewRevision.current;
      const more = await gallery.more();
      if (ticket === previewRevision.current && more?.[currentIndex + 1]) selectPreview(more[currentIndex + 1]!.id);
    }
  }
  function clear() { setSearch(""); setRatio("all"); setProject(""); }
  async function openProject() {
    if (!current || opening) return;
    setOpening(true); setOpenError("");
    try { await onOpen(current); selectPreview(""); }
    catch (reason) { setOpenError((reason as Error).message); }
    finally { setOpening(false); }
  }
  return <section className="gallery-main" aria-label="作品画廊">
    <header className="workspace-head gallery-head"><div><h1>作品画廊</h1></div>
      <div className="head-actions gallery-head-actions"><label className="gallery-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg><input maxLength={200} aria-label="搜索项目或作品" placeholder="搜索项目或作品" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="清除搜索" onClick={() => setSearch("")}><Icon name="close"/></button>}</label>{visibilityToggle}</div>
    </header>
    <div className="gallery-content"><p className="gallery-count">{data.totalWorks.toLocaleString()} 件作品<span>·</span>{data.projectCount} 个项目</p>
    <div className="gallery-toolbar"><div className="ratio-tabs" aria-label="作品比例">{[["all", "全部作品"], ["portrait", "竖图"], ["landscape", "横图"], ["square", "方图"]].map(([key, label]) => <button key={key} aria-pressed={ratio === key} className={ratio === key ? "selected" : ""} onClick={() => setRatio(key!)}>{label}</button>)}</div>
      <div className="gallery-filters"><SelectField label="项目" aria-label="筛选项目" value={projectId} onChange={e => setProject(e.target.value)}><option value="">所有项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</SelectField><SelectField label="排序" aria-label="排序" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">最新生成</option><option value="oldest">最早生成</option></SelectField><button className="density-button" aria-label="切换图片密度" aria-pressed={dense} onClick={() => setDense(!dense)}><Icon name="grid"/></button></div>
    </div>
    <div className="gallery-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="浏览生成作品" aria-busy={loading}>
      {!connected ? <div className="gallery-empty"><Icon name="image"/><h2>本机服务未连接</h2><p>连接服务后即可浏览已保存的作品。</p><button onClick={gallery.refresh}>重试</button></div>
        : !items.length ? <div className="gallery-empty"><Icon name="image"/><h2>{error ? "暂时无法读取作品" : loading ? "正在读取作品…" : data.totalWorks ? "没有找到作品" : "还没有生成作品"}</h2><p>{error || (loading ? "" : data.totalWorks ? "试试其他项目、比例或关键词。" : "项目中生成的图片会汇集在这里。")}</p>{error ? <button onClick={gallery.refresh}>重新加载</button> : !loading && (search || ratio !== "all" || projectId) && <button onClick={clear}>清除筛选</button>}</div>
        : <><div className="masonry" style={{ height: position.height }} aria-label="作品瀑布流">{visible.map(({ work, x, y, width, height }) => <button key={work.id} className="art-card" data-work={work.id} style={{ transform: `translate(${x}px, ${y}px)`, width, height }} tabIndex={work.id === (focusedId || visible[0]?.work.id) ? 0 : -1}
          onFocus={() => setFocused(work.id)} onBlur={e => { if (!e.relatedTarget?.closest?.(".gallery-preview")) setFocused(""); }}
          onKeyDown={e => { const index = items.indexOf(work), delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: position.cols, ArrowUp: -position.cols }[e.key]; if (delta !== undefined) { e.preventDefault(); focus(Math.max(0, Math.min(items.length - 1, index + delta))); } }}
          onClick={e => { opener.current = e.currentTarget; selectPreview(work.id); }} aria-label={`${work.title}，${day(work.createdAt)}，版本 ${work.version}，查看图片`}>
          <div className="art-image"><GalleryImage work={work} load={load} priority={work.id === items[0]?.id}/><span className="art-hover"><span>{work.width} × {work.height}</span><Icon name="maximize"/></span></div><div className="art-caption"><strong>{work.title}</strong><small>{day(work.createdAt)} · V{work.version}{work.hidden ? " · 已隐藏" : ""}</small></div>
        </button>)}</div>{error && <p className="gallery-load-error" role="alert">{error}<button onClick={gallery.refresh}>重试</button></p>}{items.length < data.total && <button className="gallery-more" disabled={loading} onClick={() => void gallery.more()}>{loading ? "正在读取…" : "加载更多作品"}</button>}</>}
    </div>
    </div>
    <dialog ref={dialog} className="gallery-preview" onCancel={e => { e.preventDefault(); selectPreview(""); }} aria-label="生成作品预览" onKeyDown={e => { if (e.key === "ArrowLeft" && currentIndex > 0) { e.preventDefault(); selectPreview(items[currentIndex - 1]!.id); } if (e.key === "ArrowRight" && currentIndex < data.total - 1) { e.preventDefault(); void next(); } }}>
      <div className="preview-layout"><button className="preview-close" aria-label="关闭预览" onClick={() => selectPreview("")}><Icon name="close"/></button>{current && <><div className="preview-art"><GalleryImage key={current.id} work={current} load={load} full/></div><div className="preview-info"><span className="eyebrow">生成作品</span><h2>{current.title}</h2>{current.hidden && <p className="gallery-hidden-source">来自已隐藏项目</p>}<dl><dt>图片尺寸</dt><dd>{current.width} × {current.height}</dd><dt>生成模式</dt><dd>{modes[current.mode]}</dd><dt>提示词版本</dt><dd>版本 {current.version}</dd><dt>生成时间</dt><dd>{new Date(current.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd></dl><button className="view-project" disabled={opening || !connected} onClick={() => void openProject()}>{opening ? "正在打开…" : "查看所在项目"}<Icon name="arrow"/></button>{openError && <p role="alert" className="gallery-load-error">{openError}</p>}<div className="preview-pagination"><button aria-label="上一张" disabled={currentIndex <= 0} onClick={() => selectPreview(items[currentIndex - 1]!.id)}><Icon name="back"/></button><span>{currentIndex + 1} / {data.total}</span><button aria-label="下一张" disabled={currentIndex >= data.total - 1 || loading} onClick={() => void next()}><Icon name="arrow"/></button></div></div></>}</div>
    </dialog>
  </section>;
}
