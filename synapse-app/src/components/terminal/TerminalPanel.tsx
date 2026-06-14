import { useState, useRef, useCallback, useEffect } from 'react';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import { isElectron } from '@platform/index';

interface TerminalTab {
  id: string;
  name: string;
  output: string[];
}

export function TerminalPanel() {
  const [tabs, setTabs] = useState<TerminalTab[]>([
    { id: 'default', name: '终端', output: ['synapse $'] },
  ]);
  const [activeTab, setActiveTab] = useState('default');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentTab = tabs.find(t => t.id === activeTab) || tabs[0];

  const addTab = useCallback(() => {
    const id = `term-${Date.now()}`;
    setTabs(prev => [...prev, { id, name: `终端 ${prev.length + 1}`, output: ['synapse $'] }]);
    setActiveTab(id);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) return [{ id: 'default', name: '终端', output: ['synapse $'] }];
      return next;
    });
    if (activeTab === id) {
      setActiveTab(tabs[0]?.id || 'default');
    }
  }, [activeTab, tabs]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeTab]);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('synapse:focus-terminal', focus);
    return () => window.removeEventListener('synapse:focus-terminal', focus);
  }, []);

  const appendOutput = useCallback((tabId: string, lines: string[]) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, output: [...t.output, ...lines] } : t));
    setTimeout(() => {
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    }, 50);
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const cmd = input.trim();
    const tabId = activeTab;
    setInput('');
    setHistoryIndex(null);

    if (!isElectron) {
      // Web mode: simulate terminal
      setTabs(prev => prev.map(t => {
        if (t.id !== tabId) return t;
        const newOutput = [...t.output];
        newOutput.push(`$ ${cmd}`);
        
        // Simulate some basic commands
        if (cmd === 'help') {
          newOutput.push('Synapse Terminal - 可用命令:');
          newOutput.push('  help    - 显示帮助');
          newOutput.push('  clear   - 清屏');
          newOutput.push('  ls      - 列出文件');
          newOutput.push('  echo    - 输出文本');
          newOutput.push('  ⚠️ 完整终端功能需要 Electron 模式');
        } else if (cmd === 'clear') {
          return { ...t, output: ['synapse $'] };
        } else if (cmd.startsWith('echo ')) {
          newOutput.push(cmd.slice(5));
        } else if (cmd === 'ls') {
          newOutput.push('📁 课件/  📁 笔记/  📁 实验/  📄 README.md  📄 课程大纲.xlsx');
        } else if (cmd === 'whoami') {
          newOutput.push('synapse-user');
        } else if (cmd === 'date') {
          newOutput.push(new Date().toLocaleString('zh-CN'));
        } else if (cmd === 'pwd') {
          newOutput.push('/workspace');
        } else if (cmd.startsWith('cat ')) {
          const file = cmd.slice(4).trim();
          newOutput.push(`[Web 模式] 显示文件: ${file}`);
          newOutput.push('提示: 使用编辑器面板查看文件内容');
        } else if (cmd === 'python' || cmd === 'python3' || cmd === 'node') {
          newOutput.push(`[Web 模式] ${cmd} 解释器不可用`);
          newOutput.push('提示: 在 Electron 模式下可运行完整的解释器环境');
        } else if (cmd === 'history') {
          history.forEach((h, idx) => newOutput.push(`  ${idx + 1}  ${h}`));
        } else if (cmd === 'env') {
          newOutput.push('SYNAPSE_MODE=web');
          newOutput.push('SYNAPSE_VERSION=1.0.0');
          newOutput.push('NODE_ENV=development');
        } else {
          newOutput.push(`⚠️ Web 模式不支持执行系统命令: ${cmd}`);
          newOutput.push('提示: 在 Electron 模式下可使用完整的系统终端');
        }
        newOutput.push('synapse $');
        return { ...t, output: newOutput };
      }));
    } else if (window.synapse?.command) {
      appendOutput(tabId, [`$ ${cmd}`, '执行中...']);
      const result = await window.synapse.command.exec(cmd);
      const lines: string[] = [];
      if (result.stdout.trim()) lines.push(...result.stdout.replace(/\r/g, '').split('\n').filter(Boolean));
      if (result.stderr.trim()) lines.push(...result.stderr.replace(/\r/g, '').split('\n').filter(Boolean).map(line => `⚠️ ${line}`));
      if (result.exitCode !== 0) lines.push(`⚠️ 退出码 ${result.exitCode}`);
      lines.push('synapse $');
      appendOutput(tabId, lines);
    }

    // Save to history
    setHistory(prev => [...prev, cmd]);

    // Auto-scroll
    setTimeout(() => {
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    }, 50);
  }, [input, activeTab, history, appendOutput]);

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`terminal-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <TerminalIcon size={12} />
            <span>{tab.name}</span>
            {tabs.length > 1 && (
              <button
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button className="terminal-tab-add" onClick={addTab} title="新建终端">
          <Plus size={14} />
        </button>
      </div>
      
      <div className="terminal-output" ref={outputRef}>
        {currentTab.output.map((line, i) => (
          <div key={i} className="terminal-line">
            {line.startsWith('$') ? (
              <span className="terminal-prompt">{line}</span>
            ) : line.startsWith('⚠️') ? (
              <span className="terminal-warning">{line}</span>
            ) : (
              <span>{line}</span>
            )}
          </div>
        ))}
      </div>

      <form className="terminal-input-form" onSubmit={handleSubmit}>
        <span className="terminal-prompt-symbol">$</span>
        <input
          ref={inputRef}
          type="text"
          className="terminal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (history.length === 0) return;
              const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
              setHistoryIndex(nextIndex);
              setInput(history[nextIndex] || '');
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (history.length === 0 || historyIndex === null) return;
              const nextIndex = historyIndex + 1;
              if (nextIndex >= history.length) {
                setHistoryIndex(null);
                setInput('');
              } else {
                setHistoryIndex(nextIndex);
                setInput(history[nextIndex] || '');
              }
            }
          }}
          placeholder={isElectron ? '输入命令...' : '输入命令（Web 模式限制）'}
          autoFocus
        />
      </form>
    </div>
  );
}
