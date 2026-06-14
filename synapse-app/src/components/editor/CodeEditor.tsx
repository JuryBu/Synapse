/**
 * CodeEditor Component
 * Lightweight code display with syntax highlighting (no Monaco dependency)
 * Uses react-syntax-highlighter or simple pre/code for now
 */
import { useState, useCallback, useEffect } from 'react';
import { Copy, Check, Save } from 'lucide-react';

interface CodeEditorProps {
  filename: string;
  content: string;
  language?: string;
  readOnly?: boolean;
  dirty?: boolean;
  savedContent?: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => void | Promise<void>;
}

export function CodeEditor({ filename, content, language, readOnly = true, dirty = false, savedContent, onChange, onSave }: CodeEditorProps) {
  const [value, setValue] = useState(content);
  const [copied, setCopied] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const originalContent = savedContent ?? content;

  useEffect(() => {
    setValue(content);
    setIsDirty(dirty);
  }, [content, dirty]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  const handleSave = useCallback(async () => {
    try {
      await onSave?.(value);
      setIsDirty(false);
    } catch {
      setIsDirty(true);
    }
  }, [value, onSave]);

  // Detect language from filename
  const lang = language || detectLanguage(filename);

  return (
    <div className="code-editor">
      <div className="code-editor-toolbar">
        <span className="code-editor-filename">
          {filename}
          {isDirty && <span className="dirty-indicator" title="未保存"> ●</span>}
        </span>
        <span className="code-editor-lang">{lang}</span>
        <div className="code-editor-actions">
          <button className="code-editor-btn" onClick={handleCopy} title="复制">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {!readOnly && (
            <button className="code-editor-btn" onClick={handleSave} title="保存 (Ctrl+S)">
              <Save size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="code-editor-content">
        {readOnly ? (
          <pre className="code-editor-pre">
            <code>{value}</code>
          </pre>
        ) : (
          <textarea
            className="code-editor-textarea"
            value={value}
            onChange={e => { const v = e.target.value; setValue(v); setIsDirty(v !== originalContent); onChange?.(v); }}
            onKeyDown={e => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSave();
              }
              // Tab support
              if (e.key === 'Tab') {
                e.preventDefault();
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                const newVal = value.substring(0, start) + '  ' + value.substring(end);
                setValue(newVal);
                setIsDirty(newVal !== originalContent);
                onChange?.(newVal);
                setTimeout(() => {
                  e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 2;
                });
              }
            }}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', css: 'css', html: 'html', json: 'json',
    md: 'markdown', txt: 'text', sh: 'bash', yml: 'yaml', yaml: 'yaml',
    rs: 'rust', go: 'go', java: 'java', cpp: 'c++', c: 'c', h: 'c',
  };
  return langMap[ext || ''] || 'text';
}
