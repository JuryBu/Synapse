/**
 * PdfViewer Component
 * Uses pdf.js to render PDF pages in canvas
 *
 * ★ FIX-7：render effect 保存 RenderTask 句柄，cleanup 调 task.cancel()；await task.promise
 *   包 try/catch 忽略 RenderingCancelledException、其余 setError；renderToken 守卫防过期帧回写。
 *   根治「连点 +/− 或首帧未完成时缩放 → 同 canvas 重入 pdf.js 抛错被吞、停在旧 scale」。
 * ★ FIX-8：容器 ref + 原生 wheel 监听（passive:false），ctrlKey 时 preventDefault + deltaY 缩放。
 * ★ FIX-9：paged / scroll 两种阅读模式切换；scroll 模式多页竖向堆叠 + IntersectionObserver 同步页码。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface PdfViewerProps {
  data: ArrayBuffer | string; // ArrayBuffer or data URL
  currentPage?: number;
  onPageChange?: (page: number) => void;
}

type PdfMode = 'paged' | 'scroll';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

export function PdfViewer({ data, currentPage = 1, onPageChange }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(currentPage);
  const [scale, setScale] = useState(1.5);
  const [mode, setMode] = useState<PdfMode>('paged');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pdfRef = useRef<any>(null);

  // ★ FIX-10：仅记录「最新在飞的 RenderTask」，供 finally 安全回收（=== myTask 才置空）；
  //   取消职责已下放到每个 run 的闭包 myTask（见 paged effect），不再由这个共享 ref 承担。
  const renderTaskRef = useRef<any>(null);
  // ★ 渲染令牌——每次新渲染自增，异步恢复点前比对，过期帧直接丢弃（防 setState 串帧）。
  const renderTokenRef = useRef(0);

  // 容器 ref：FIX-8 原生 wheel 监听 + FIX-9 scroll 模式滚动容器。
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ★ FIX-9：scroll 模式下「点翻页按钮要把目标页滚入视图」。用 {page,nonce} 触发，
  //   nonce 每次点击自增以区分「同页重复点」，避免与 IntersectionObserver 回写形成死循环
  //   （observer 只 setPage，不动 scrollRequest）。
  const [scrollRequest, setScrollRequest] = useState<{ page: number; nonce: number }>({ page: currentPage, nonce: 0 });

  const zoomIn = useCallback(() => setScale(s => Math.min(s + ZOOM_STEP, ZOOM_MAX)), []);
  const zoomOut = useCallback(() => setScale(s => Math.max(s - ZOOM_STEP, ZOOM_MIN)), []);

  // ── 加载 PDF 文档（data 变化时重载）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError('');
        setLoading(true);
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        if (typeof data === 'string' && data.startsWith('/workspace/')) {
          throw new Error('Web 模式下请先导入真实 PDF 文件');
        }
        const loadData = typeof data === 'string'
          ? { url: data }
          : { data: data.slice(0) };
        const pdf = await pdfjsLib.getDocument(loadData).promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        setLoading(false);
      } catch (err) {
        console.error('[PdfViewer] Load error:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'PDF 加载失败');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  // ── paged 模式：渲染当前页到单 canvas。
  //
  // ★ FIX-10（修 FIX-7 缩放回归）：真因——FIX-7 用「共享 renderTaskRef + token 过期守卫 +
  //   cleanup cancel(localTask)」三件套，但 cancel 与 token 的时序在「连点 +/− / 首帧未完成时缩放」
  //   下会互相绊倒：
  //     · cleanup 只 cancel 闭包里的 localTask，而 localTask 在 await getPage 之前恒为 null，
  //       于是「getPage 仍在飞」的那次缩放，cleanup 取消不到任何东西；
  //     · 被取消的 task 抛 RenderingCancelledException 后从 catch 直接 return，renderTaskRef.current
  //       仍指向那个「死 task」，永不置空；
  //     · 共享 renderTaskRef 跨多次 run 复用，叠加 StrictMode 的 mount→cleanup→mount 双调用，
  //       很容易出现「该生效的新一帧 render 被上一拍的 cleanup/cancel 误杀、或新帧被判过期挡回写」，
  //       表现即为：百分比变了（scale state 变了）但 canvas 不重画、停在旧 scale。
  //
  //   重写为「每次 run 自带独立 token + 独立 task 句柄」的可证明正确模型：
  //     1) 进 effect 立刻 ++token 作废所有在飞旧帧；本 run 的 task 存在闭包 myTask（非共享 ref），
  //        cleanup 只取消「本 run 自己创建的那个 task」，绝不误杀别人；
  //     2) 任何异步恢复点都先比对 token，过期即退出（不写 canvas、不报错）；
  //     3) 用 cancelled 标记替代「靠 token 顺便判过期」，cleanup 一旦触发即视为本帧作废，
  //        即便 render 之后才被取消也不会回写「失败」状态；
  //     4) renderToken 仅作「最新有效帧」判据，不再承担「task 句柄回收」职责，彻底解耦。
  //   防重入抛错的好处保留：旧帧 token 失配会主动 cancel，同一 canvas 任意时刻只有最新 task 在画。
  useEffect(() => {
    if (mode !== 'paged') return;
    if (!pdfRef.current || !canvasRef.current) return;

    const token = ++renderTokenRef.current;
    let myTask: any = null;
    let cancelled = false;

    (async () => {
      try {
        const pdfPage = await pdfRef.current.getPage(page);
        if (cancelled || token !== renderTokenRef.current) return; // 本帧已被取代/作废，丢弃。
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        // ★ 关键：按新 scale 重置 canvas 内在尺寸——这一步真正让画面跟随 scale 变化。
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        myTask = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = myTask;
        await myTask.promise;
      } catch (err: any) {
        // 被 cleanup 取消时 pdf.js 抛 RenderingCancelledException；本帧已作废，静默忽略。
        const name = err?.name || '';
        if (cancelled || name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) {
          return;
        }
        if (token === renderTokenRef.current) {
          console.error('[PdfViewer] Render error:', err);
          setError(err instanceof Error ? err.message : 'PDF 渲染失败');
        }
      } finally {
        // 仅当本 run 的 task 仍是「全局当前 task」时才清空，避免把后继帧的句柄误置空。
        if (renderTaskRef.current === myTask) renderTaskRef.current = null;
      }
    })();

    return () => {
      // effect 重跑/卸载：标记本帧作废 + 取消「本 run 自己创建的」task（绝不碰别的 run 的 task）。
      cancelled = true;
      if (myTask) {
        try { myTask.cancel(); } catch { /* ignore */ }
      }
    };
  }, [mode, page, totalPages, scale]);

  // ── FIX-8：Ctrl+滚轮缩放。React onWheel 默认 passive 无法 preventDefault，
  //   故用 ref + 原生 addEventListener('wheel', fn, { passive:false })。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
    // mode 进 deps：paged↔scroll 切换时 containerRef 指向的 DOM 元素更换，需重新绑定监听。
  }, [zoomIn, zoomOut, mode]);

  // 仅更新页码（IntersectionObserver 回写用，不触发滚动，避免死循环）。
  const setVisiblePage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    onPageChange?.(clamped);
  }, [totalPages, onPageChange]);

  // 翻页按钮用：更新页码 + 在 scroll 模式请求把目标页滚入视图。
  const goPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    onPageChange?.(clamped);
    setScrollRequest(prev => ({ page: clamped, nonce: prev.nonce + 1 }));
  }, [totalPages, onPageChange]);

  if (loading) {
    return <div className="pdf-viewer-loading">📄 加载 PDF 中...</div>;
  }

  if (error) {
    return <div className="pdf-viewer-loading">⚠️ {error}</div>;
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-toolbar">
        <button onClick={() => goPage(page - 1)} disabled={page <= 1}>◀</button>
        <span>{page} / {totalPages}</span>
        <button onClick={() => goPage(page + 1)} disabled={page >= totalPages}>▶</button>
        <span style={{ margin: '0 8px', opacity: 0.5 }}>|</span>
        <button onClick={zoomOut} disabled={scale <= ZOOM_MIN}>−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} disabled={scale >= ZOOM_MAX}>+</button>
        <span style={{ margin: '0 8px', opacity: 0.5 }}>|</span>
        {/* ★ FIX-9：阅读模式切换（单页翻页 / 竖向连续滚动）。 */}
        <button
          className={mode === 'paged' ? 'pdf-mode-active' : ''}
          onClick={() => setMode('paged')}
          title="单页"
        >
          单页
        </button>
        <button
          className={mode === 'scroll' ? 'pdf-mode-active' : ''}
          onClick={() => setMode('scroll')}
          title="连续滚动"
        >
          连续
        </button>
      </div>
      {mode === 'paged' ? (
        <div className="pdf-viewer-canvas-container" ref={containerRef}>
          <canvas ref={canvasRef} style={{ maxWidth: '100%', height: 'auto' }} />
        </div>
      ) : (
        <PdfScrollView
          pdf={pdfRef.current}
          totalPages={totalPages}
          scale={scale}
          activePage={page}
          scrollRequest={scrollRequest}
          containerRef={containerRef}
          onVisiblePage={setVisiblePage}
          onError={setError}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ★ FIX-9：scroll（连续滚动）模式——多页竖向堆叠，每页一 canvas、可见时按需渲染，
//   IntersectionObserver 把最显眼的可见页回写页码。复用 FIX-7 的 RenderTask 取消语义。
// ──────────────────────────────────────────────────────────────────────────
interface PdfScrollViewProps {
  pdf: any;
  totalPages: number;
  scale: number;
  activePage: number;
  scrollRequest: { page: number; nonce: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
  onVisiblePage: (page: number) => void;
  onError: (message: string) => void;
}

function PdfScrollView({ pdf, totalPages, scale, activePage, scrollRequest, containerRef, onVisiblePage, onError }: PdfScrollViewProps) {
  // 每页一个 canvas ref。
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // 每页进行中的 RenderTask（取消用）。
  const taskRefs = useRef<(any | null)[]>([]);
  // 每页渲染令牌（防过期帧）。
  const tokenRefs = useRef<number[]>([]);

  // 渲染单页（按需）。
  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdf) return;
    const idx = pageNum - 1;
    const canvas = canvasRefs.current[idx];
    if (!canvas) return;
    const token = (tokenRefs.current[idx] ?? 0) + 1;
    tokenRefs.current[idx] = token;
    let localTask: any = null;
    try {
      const pdfPage = await pdf.getPage(pageNum);
      if (token !== tokenRefs.current[idx]) return;
      const viewport = pdfPage.getViewport({ scale });
      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // 已标记完成的不重画（width/height 已设说明已渲染过；这里仍渲染以应对 scale 变化）。
      if (taskRefs.current[idx]) {
        try { taskRefs.current[idx].cancel(); } catch { /* ignore */ }
      }
      localTask = pdfPage.render({ canvasContext: ctx, viewport });
      taskRefs.current[idx] = localTask;
      await localTask.promise;
    } catch (err: any) {
      const name = err?.name || '';
      if (name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) return;
      if (token === tokenRefs.current[idx]) {
        console.error('[PdfViewer] Scroll render error:', err);
        onError(err instanceof Error ? err.message : 'PDF 渲染失败');
      }
    } finally {
      // ★ FIX-10：无论成功/被取消，只要本页句柄仍是自己创建的那个就置空，
      //   避免被取消的「死 task」残留在 taskRefs 里（FIX-7 旧逻辑从 catch 直接 return 会漏置空）。
      if (localTask && taskRefs.current[idx] === localTask) taskRefs.current[idx] = null;
    }
  }, [pdf, scale, onError]);

  // 可见性观察：按需渲染进入视口的页 + 把最居中的可见页回写页码。
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNum = Number((entry.target as HTMLElement).dataset.page);
        if (!pageNum) continue;
        if (entry.isIntersecting) {
          visible.add(pageNum);
          void renderPage(pageNum);
        } else {
          visible.delete(pageNum);
        }
      }
      // 回写「可见页里页码最小的」为当前页（最稳定，避免来回跳）。
      if (visible.size > 0) {
        const top = Math.min(...visible);
        onVisiblePage(top);
      }
    }, { root, threshold: 0.1 });

    const pageEls = root.querySelectorAll('.pdf-scroll-page');
    pageEls.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [containerRef, totalPages, renderPage, onVisiblePage]);

  // scale 变化时 renderPage 引用更新 → 下方 IntersectionObserver effect 重建并重画可见页，
  // 故缩放在 scroll 模式自动生效，无需额外副作用。

  // 挂载时把当前 activePage 滚入视图（切到此模式时定位到先前页）。
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector(`.pdf-scroll-page[data-page="${activePage}"]`) as HTMLElement | null;
    if (target) target.scrollIntoView({ block: 'start' });
    // 仅挂载时滚一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ FIX-9：翻页按钮点击（scrollRequest.nonce 变化）时把目标页滚入视图。
  useEffect(() => {
    if (scrollRequest.nonce === 0) return; // 初始值不触发。
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector(`.pdf-scroll-page[data-page="${scrollRequest.page}"]`) as HTMLElement | null;
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [scrollRequest, containerRef]);

  return (
    <div className="pdf-viewer-canvas-container pdf-scroll-container" ref={containerRef}>
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
        <div className="pdf-scroll-page" data-page={pageNum} key={pageNum}>
          <canvas
            ref={el => { canvasRefs.current[pageNum - 1] = el; }}
            style={{ maxWidth: '100%', height: 'auto' }}
          />
        </div>
      ))}
    </div>
  );
}
