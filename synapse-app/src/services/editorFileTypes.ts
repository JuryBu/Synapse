import type { EditorTab } from '@/store/slices/editorTabs';

export type EditorFileType = EditorTab['type'];

// ★ M4-4-S2：pptx/docx 并入 office 集合，走 OfficeViewer → LibreOffice headless → PDF 真版式预览。
//   原先 pptx/docx 各自特判成独立 type（命中 EditorArea 的 PptxViewer/jszip、DocxViewer/mammoth 文本抽取），
//   现统一归 'office'，复用已就绪的 LibreOffice→PDF 链路。PptxViewer/DocxViewer 组件不删
//   （SynopsisPanel / synopsisEngine 仍引用 pptx/docx 概念，属另一套「知识概要」体系）。
const OFFICE_EXTENSIONS = new Set(['doc', 'docm', 'docx', 'ppt', 'pptm', 'pptx', 'xls', 'xlsx', 'xlsm']);

export function resolveEditorType(fileNameOrExtension: string): EditorFileType {
  const raw = fileNameOrExtension.trim().toLowerCase();
  const ext = raw.includes('.') ? raw.split('.').pop() || '' : raw.replace(/^\./, '');
  if (!ext) return 'code';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  return 'code';
}

