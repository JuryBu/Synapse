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

  // ★ FIX-7：当前进行中的 RenderTask（paged 模式单任务），用于在 effect cleanup 中 cancel。
  const renderTaskRef = useRef<any>(null);
  // ★ FIX-7：渲染令牌——每次新渲染自增，异步回写前比对，过期帧直接丢弃（防 setState 串帧）。
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

  // ── paged 模式：渲染当前页到单 canvas（FIX-7 取消旧任务 + token 守卫）。
  useEffect(() => {
    if (mode !== 'paged') return;
    if (!pdfRef.current || !canvasRef.current) return;

    const token = ++renderTokenRef.current;
    let localTask: any = null;

    (async () => {
      try {
        const pdfPage = await pdfRef.current.getPage(page);
        if (token !== renderTokenRef.current) return; // 已被更新的渲染取代，丢弃。
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // ★ FIX-7：保存 RenderTask 句柄，供 cleanup cancel；同 canvas 重入前先 cancel 上一个。
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
        }
        localTask = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = localTask;
        await localTask.promise;
        if (token === renderTokenRef.current) {
          renderTaskRef.current = null;
        }
      } catch (err: any) {
        // pdf.js 取消渲染抛 RenderingCancelledException（name 字段判定），属预期，静默忽略。
        const name = err?.name || '';
        if (name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) {
          return;
        }
        if (token === renderTokenRef.current) {
          console.error('[PdfViewer] Render error:', err);
          setError(err instanceof Error ? err.message : 'PDF 渲染失败');
        }
      }
    })();

    return () => {
      // ★ FIX-7：effect 重跑/卸载时取消进行中的任务，避免「同 canvas 多 render」异常。
      if (localTask) {
        try { localTask.cancel(); } catch { /* ignore */ }
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
      if (token === tokenRefs.current[idx]) taskRefs.current[idx] = null;
    } catch (err: any) {
      const name = err?.name || '';
      if (name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) return;
      if (token === tokenRefs.current[idx]) {
        console.error('[PdfViewer] Scroll render error:', err);
        onError(err instanceof Error ? err.message : 'PDF 渲染失败');
      }
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
