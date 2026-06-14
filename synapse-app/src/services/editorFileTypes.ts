import type { EditorTab } from '@/store/slices/editorTabs';

export type EditorFileType = EditorTab['type'];

const OFFICE_EXTENSIONS = new Set(['doc', 'docm', 'ppt', 'pptm', 'xls', 'xlsx', 'xlsm']);

export function resolveEditorType(fileNameOrExtension: string): EditorFileType {
  const raw = fileNameOrExtension.trim().toLowerCase();
  const ext = raw.includes('.') ? raw.split('.').pop() || '' : raw.replace(/^\./, '');
  if (!ext) return 'code';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'docx') return 'docx';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  return 'code';
}

