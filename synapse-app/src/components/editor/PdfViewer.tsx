/**
 * PdfViewer Component
 * Uses pdf.js to render PDF pages in canvas
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface PdfViewerProps {
  data: ArrayBuffer | string; // ArrayBuffer or data URL
  currentPage?: number;
  onPageChange?: (page: number) => void;
}

export function PdfViewer({ data, currentPage = 1, onPageChange }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(currentPage);
  const [scale, setScale] = useState(1.5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pdfRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError('');
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
        setError(err instanceof Error ? err.message : 'PDF 加载失败');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  // Render current page with scale
  useEffect(() => {
    if (!pdfRef.current || !canvasRef.current) return;
    (async () => {
      const pdfPage = await pdfRef.current.getPage(page);
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    })();
  }, [page, totalPages, scale]);

  const goPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    onPageChange?.(clamped);
  }, [totalPages, onPageChange]);

  const zoomIn = useCallback(() => setScale(s => Math.min(s + 0.25, 4)), []);
  const zoomOut = useCallback(() => setScale(s => Math.max(s - 0.25, 0.5)), []);

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
        <button onClick={zoomOut}>−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn}>+</button>
      </div>
      <div className="pdf-viewer-canvas-container">
        <canvas ref={canvasRef} style={{ maxWidth: '100%', height: 'auto' }} />
      </div>
    </div>
  );
}
