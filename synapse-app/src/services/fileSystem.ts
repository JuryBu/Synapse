/**
 * Synapse File System Service
 * Web 模式：使用 IndexedDB + 内存 模拟文件系统
 * Electron 模式：通过 IPC 调用 Node.js fs
 */

import { isElectron } from '@platform/index';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: number;
  children?: FileNode[];
  extension?: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  lastOpened: number;
}

// ==========================================
// Web 模式：Demo 文件系统（模拟数据）
// ==========================================

const DEMO_FILE_TREE: FileNode = {
  name: '示例工作区',
  path: '/workspace',
  type: 'directory',
  children: [
    {
      name: '📚 课件',
      path: '/workspace/课件',
      type: 'directory',
      children: [
        { name: '第1章-绪论.pdf', path: '/workspace/课件/第1章-绪论.pdf', type: 'file', extension: 'pdf', size: 2048000 },
        { name: '第2章-线性表.pdf', path: '/workspace/课件/第2章-线性表.pdf', type: 'file', extension: 'pdf', size: 3072000 },
        { name: '第3章-栈和队列.pptx', path: '/workspace/课件/第3章-栈和队列.pptx', type: 'file', extension: 'pptx', size: 5120000 },
        { name: '第4章-树与二叉树.pptx', path: '/workspace/课件/第4章-树与二叉树.pptx', type: 'file', extension: 'pptx', size: 4096000 },
        { name: '第5章-图.docx', path: '/workspace/课件/第5章-图.docx', type: 'file', extension: 'docx', size: 1024000 },
      ],
    },
    {
      name: '📝 笔记',
      path: '/workspace/笔记',
      type: 'directory',
      children: [
        { name: '学习计划.md', path: '/workspace/笔记/学习计划.md', type: 'file', extension: 'md', size: 4096 },
        { name: '错题整理.md', path: '/workspace/笔记/错题整理.md', type: 'file', extension: 'md', size: 8192 },
      ],
    },
    {
      name: '🧪 实验',
      path: '/workspace/实验',
      type: 'directory',
      children: [
        { name: '排序算法比较.py', path: '/workspace/实验/排序算法比较.py', type: 'file', extension: 'py', size: 2048 },
        { name: '二叉树遍历.cpp', path: '/workspace/实验/二叉树遍历.cpp', type: 'file', extension: 'cpp', size: 3072 },
        { name: '图的最短路径.java', path: '/workspace/实验/图的最短路径.java', type: 'file', extension: 'java', size: 4096 },
      ],
    },
    { name: 'README.md', path: '/workspace/README.md', type: 'file', extension: 'md', size: 1024 },
    { name: '课程大纲.xlsx', path: '/workspace/课程大纲.xlsx', type: 'file', extension: 'xlsx', size: 15360 },
  ],
};

// Demo file contents for web mode
const DEMO_FILES: Record<string, string> = {
  '/workspace/笔记/学习计划.md': '# 学习计划\n\n## 本周目标\n- [ ] 复习线性表\n- [ ] 完成栈和队列习题\n- [ ] 预习树与二叉树\n\n## 重点难点\n1. 链表的头插法与尾插法\n2. 栈的应用（表达式求值）\n3. 二叉树的遍历算法',
  '/workspace/笔记/错题整理.md': '# 错题整理\n\n## 第2章 线性表\n\n### 题目1: 单链表反转\n**错误原因**: 忘记处理头节点\n**正确思路**: 使用三指针法...',
  '/workspace/README.md': '# 数据结构课程\n\n- 教材: 《数据结构（C语言版）》\n- 学期: 2025-2026 第二学期\n- 教师: 张老师',
  '/workspace/实验/排序算法比较.py': '# 排序算法时间复杂度比较实验\nimport time\nimport random\n\ndef bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\n\ndef quick_sort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr)//2]\n    left = [x for x in arr if x < pivot]\n    middle = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quick_sort(left) + middle + quick_sort(right)',
};

class FileSystemService {
  private memoryFiles = new Map<string, string>();
  private memoryFileUrls = new Map<string, string>();
  private fileTree: FileNode;
  private workspaces: Workspace[] = [];
  private currentWorkspace: string = 'default';
  private workspaceTrees = new Map<string, FileNode>();
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.fileTree = JSON.parse(JSON.stringify(DEMO_FILE_TREE));
    this.workspaceTrees.set('default', this.fileTree);
    // Load demo files
    for (const [path, content] of Object.entries(DEMO_FILES)) {
      this.memoryFiles.set(path, content);
    }
    // Load workspaces from localStorage
    const saved = localStorage.getItem('synapse_workspaces');
    if (saved) {
      try { this.workspaces = JSON.parse(saved); } catch {}
    }
    if (this.workspaces.length === 0) {
      this.workspaces = [{ id: 'default', name: '示例工作区', path: '/workspace', lastOpened: Date.now() }];
    }
    for (const ws of this.workspaces) {
      if (!this.workspaceTrees.has(ws.id)) {
        this.workspaceTrees.set(ws.id, ws.id === 'default'
          ? this.fileTree
          : { name: ws.name, path: ws.path, type: 'directory', children: [] });
      }
    }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() { this.listeners.forEach(fn => fn()); }
  private saveWorkspaces() { localStorage.setItem('synapse_workspaces', JSON.stringify(this.workspaces)); }
  private saveCurrentTree() { this.workspaceTrees.set(this.currentWorkspace, this.fileTree); }
  private getCurrentWorkspacePath(): string {
    return this.workspaces.find(w => w.id === this.currentWorkspace)?.path || this.fileTree.path || '/workspace';
  }

  // ==========================================
  // Workspace Management
  // ==========================================

  getWorkspaces(): Workspace[] { return this.workspaces; }

  getCurrentWorkspace(): string { return this.currentWorkspace; }

  hasNode(path: string): boolean {
    return !!this.findNode(path);
  }

  clearLoadedWorkspace(): void {
    this.saveCurrentTree();
    this.currentWorkspace = '';
    this.fileTree = { name: '未加载工作区', path: '', type: 'directory', children: [] };
    this.notify();
  }

  createWorkspace(name: string): Workspace {
    this.saveCurrentTree();
    const ws: Workspace = {
      id: `ws_${Date.now()}`,
      name,
      path: `/workspace/${name}`,
      lastOpened: Date.now(),
    };
    this.workspaces.push(ws);
    this.saveWorkspaces();
    // Create workspace root folder
    const root: FileNode = { name, path: ws.path, type: 'directory', children: [] };
    this.fileTree = root;
    this.workspaceTrees.set(ws.id, root);
    this.currentWorkspace = ws.id;
    this.notify();
    return ws;
  }

  createWorkspaceFromFiles(name: string, files: File[]): Workspace {
    const ws = this.createWorkspace(name);
    void this.uploadFiles(files, ws.path);
    return ws;
  }

  openExternalWorkspace(ws: Workspace): void {
    this.saveCurrentTree();
    const existing = this.workspaces.find(w => w.id === ws.id || w.path === ws.path);
    if (existing) {
      existing.name = ws.name;
      existing.lastOpened = Date.now();
      this.currentWorkspace = existing.id;
      this.fileTree = this.workspaceTrees.get(existing.id) ?? { name: ws.name, path: ws.path, type: 'directory', children: [] };
      this.workspaceTrees.set(existing.id, this.fileTree);
    } else {
      this.workspaces.unshift({ ...ws, lastOpened: Date.now() });
      this.currentWorkspace = ws.id;
      this.fileTree = { name: ws.name, path: ws.path, type: 'directory', children: [] };
      this.workspaceTrees.set(ws.id, this.fileTree);
    }
    this.saveWorkspaces();
    this.notify();
  }

  switchWorkspace(id: string) {
    const ws = this.workspaces.find(w => w.id === id);
    if (ws) {
      this.saveCurrentTree();
      ws.lastOpened = Date.now();
      this.currentWorkspace = id;
      this.fileTree = this.workspaceTrees.get(id) ?? { name: ws.name, path: ws.path, type: 'directory', children: [] };
      this.workspaceTrees.set(id, this.fileTree);
      this.saveWorkspaces();
      this.notify();
    }
  }

  deleteWorkspace(id: string) {
    this.workspaces = this.workspaces.filter(w => w.id !== id);
    this.workspaceTrees.delete(id);
    if (this.currentWorkspace === id) {
      const next = this.workspaces[0] ?? { id: 'default', name: '示例工作区', path: '/workspace', lastOpened: Date.now() };
      if (this.workspaces.length === 0) this.workspaces = [next];
      this.currentWorkspace = next.id;
      this.fileTree = this.workspaceTrees.get(next.id) ?? JSON.parse(JSON.stringify(DEMO_FILE_TREE));
      this.workspaceTrees.set(next.id, this.fileTree);
    }
    this.saveWorkspaces();
    this.notify();
  }

  // ==========================================
  // File Operations
  // ==========================================

  async listDir(dirPath: string): Promise<FileNode[]> {
    if (isElectron && window.synapse) {
      return await window.synapse.file.list(dirPath);
    }
    // Find the directory node
    const node = this.findNode(dirPath);
    return node?.children ?? this.fileTree.children ?? [];
  }

  async readFile(filePath: string): Promise<string> {
    if (isElectron && window.synapse) {
      return await window.synapse.file.read(filePath);
    }
    if (this.memoryFiles.has(filePath)) {
      return this.memoryFiles.get(filePath)!;
    }
    return `// 文件内容预览: ${filePath}\n// Web 模式下暂不支持真实文件读取`;
  }

  async readBinary(filePath: string): Promise<ArrayBuffer> {
    if (isElectron && window.synapse) {
      const raw = await window.synapse.file.readBinary(filePath);
      if (raw instanceof ArrayBuffer) return raw;
      if (raw instanceof Uint8Array) {
        return new Uint8Array(raw).buffer;
      }
      if (Array.isArray(raw)) {
        return new Uint8Array(raw).buffer;
      }
      throw new Error('无法读取二进制文件');
    }

    const url = this.memoryFileUrls.get(filePath);
    if (url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法加载文件: ${response.status}`);
      return await response.arrayBuffer();
    }

    const text = this.memoryFiles.get(filePath);
    if (text !== undefined) {
      return new Uint8Array(new TextEncoder().encode(text)).buffer;
    }

    throw new Error(`Web 模式下请先导入真实文件: ${filePath}`);
  }

  async convertOfficeToPdf(filePath: string): Promise<{ outputPath: string; tempDir?: string }> {
    if (isElectron && window.synapse?.file.convertOffice) {
      const result = await window.synapse.file.convertOffice(filePath);
      if (result?.error || !result?.outputPath) {
        throw new Error(result?.message || 'Office 转换失败');
      }
      return { outputPath: result.outputPath, tempDir: result.tempDir };
    }
    throw new Error('Web 模式暂无本地 Office 转换能力，请在 Electron 模式下打开。');
  }

  async cleanupTempPath(targetPath: string): Promise<void> {
    if (isElectron && window.synapse?.file.cleanupTemp) {
      const result = await window.synapse.file.cleanupTemp(targetPath);
      if (result?.error) throw new Error(result.message || '临时文件清理失败');
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (isElectron && window.synapse) {
      const result = await window.synapse.file.write(filePath, content);
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(result.message || '文件写入失败');
      }
      return;
    }
    this.memoryFiles.set(filePath, content);
    // Update size in tree or create missing node.
    const node = this.findNode(filePath);
    const size = new Blob([content]).size;
    if (node) {
      node.size = size;
    } else {
      this.addFileNode(filePath, size);
    }
    this.notify();
  }

  async createFile(dirPath: string, fileName: string, content = ''): Promise<string> {
    const filePath = `${dirPath}/${fileName}`;
    if (isElectron && window.synapse) {
      const result = await window.synapse.file.write(filePath, content);
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(result.message || '文件创建失败');
      }
      this.notify();
      return filePath;
    }
    const ext = fileName.split('.').pop() || '';
    const parentNode = this.findNode(dirPath);
    if (parentNode && parentNode.type === 'directory') {
      if (!parentNode.children) parentNode.children = [];
      parentNode.children.push({
        name: fileName,
        path: filePath,
        type: 'file',
        extension: ext,
        size: new Blob([content]).size,
        modifiedAt: Date.now(),
      });
    }
    this.memoryFiles.set(filePath, content);
    this.notify();
    return filePath;
  }

  async createDirectory(parentPath: string, dirName: string): Promise<string> {
    const dirPath = `${parentPath}/${dirName}`;
    if (isElectron && window.synapse) {
      await window.synapse.file.mkdir(dirPath);
      this.notify();
      return dirPath;
    }
    const parentNode = this.findNode(parentPath);
    if (parentNode && parentNode.type === 'directory') {
      if (!parentNode.children) parentNode.children = [];
      parentNode.children.push({
        name: dirName,
        path: dirPath,
        type: 'directory',
        children: [],
      });
    }
    this.notify();
    return dirPath;
  }

  async deleteFile(filePath: string): Promise<void> {
    if (isElectron && window.synapse) {
      await window.synapse.file.delete(filePath);
      this.notify();
      return;
    }
    this.removeFromTree(filePath);
    this.memoryFiles.delete(filePath);
    const url = this.memoryFileUrls.get(filePath);
    if (url) URL.revokeObjectURL(url);
    this.memoryFileUrls.delete(filePath);
    this.notify();
  }

  async renameFile(oldPath: string, newName: string): Promise<string> {
    const node = this.findNode(oldPath);
    if (!node) throw new Error('File not found');
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const newPath = `${parentPath}/${newName}`;
    if (isElectron && window.synapse) {
      await window.synapse.file.rename(oldPath, newPath);
      this.notify();
      return newPath;
    }
    node.name = newName;
    node.path = newPath;
    if (node.type === 'file') {
      node.extension = newName.split('.').pop();
      // Move content
      const content = this.memoryFiles.get(oldPath);
      if (content !== undefined) {
        this.memoryFiles.delete(oldPath);
        this.memoryFiles.set(newPath, content);
      }
      const url = this.memoryFileUrls.get(oldPath);
      if (url) {
        this.memoryFileUrls.delete(oldPath);
        this.memoryFileUrls.set(newPath, url);
      }
    }
    this.updateChildPaths(node, oldPath, newPath);
    this.notify();
    return newPath;
  }

  async searchFiles(query: string): Promise<Array<{ path: string; match: string }>> {
    const results: Array<{ path: string; match: string }> = [];
    const lowerQuery = query.toLowerCase();

    const searchNode = (node: FileNode) => {
      if (node.name.toLowerCase().includes(lowerQuery)) {
        results.push({ path: node.path, match: `文件名匹配: ${node.name}` });
      }
      if (node.children) {
        for (const child of node.children) searchNode(child);
      }
    };
    searchNode(this.fileTree);

    for (const [path, content] of this.memoryFiles) {
      if (content.toLowerCase().includes(lowerQuery)) {
        const lineIdx = content.toLowerCase().indexOf(lowerQuery);
        const lineStart = content.lastIndexOf('\n', lineIdx) + 1;
        const lineEnd = content.indexOf('\n', lineIdx);
        const matchLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        results.push({ path, match: matchLine.slice(0, 80) });
      }
    }

    return results;
  }

  async getWorkspaceTree(): Promise<FileNode> {
    if (isElectron && window.synapse?.workspace) {
      const tree = await window.synapse.workspace.tree(this.getCurrentWorkspacePath());
      this.fileTree = tree;
      this.workspaceTrees.set(this.currentWorkspace, tree);
      return tree;
    }
    return this.fileTree;
  }

  getFileUrl(filePath: string): string | undefined {
    return this.memoryFileUrls.get(filePath);
  }

  // ==========================================
  // File Upload (Web mode - drag & drop / file input)
  // ==========================================

  async uploadFile(file: File, targetDir?: string): Promise<string> {
    const rootPath = this.getCurrentWorkspacePath();
    const defaultCourseDir = this.findNode(`${rootPath}/课件`) ? `${rootPath}/课件` : rootPath;
    const dir = targetDir || defaultCourseDir;
    const relativePath = (file as any).webkitRelativePath as string | undefined;
    const filePath = relativePath
      ? `${rootPath}/${relativePath.replace(/\\/g, '/')}`
      : `${dir}/${file.name}`;
    const ext = file.name.split('.').pop() || '';
    
    // Read text files into memory; keep binary files as object URLs for viewers.
    const textLike = /^(text\/|application\/json)/.test(file.type)
      || ['md', 'txt', 'csv', 'json', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'py', 'java', 'cpp', 'c', 'h', 'yml', 'yaml'].includes(ext.toLowerCase());
    if (textLike) {
      const text = await file.text().catch(() => '');
      this.memoryFiles.set(filePath, text);
    } else {
      const oldUrl = this.memoryFileUrls.get(filePath);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      this.memoryFileUrls.set(filePath, URL.createObjectURL(file));
    }
    
    // Add to tree
    this.addFileNode(filePath, file.size, ext);
    this.notify();
    return filePath;
  }

  async uploadFiles(files: File[], targetDir?: string): Promise<string[]> {
    const paths: string[] = [];
    for (const file of files) {
      paths.push(await this.uploadFile(file, targetDir));
    }
    return paths;
  }

  // ==========================================
  // Helpers
  // ==========================================

  private findNode(path: string): FileNode | undefined {
    const search = (node: FileNode): FileNode | undefined => {
      if (node.path === path) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = search(child);
          if (found) return found;
        }
      }
      return undefined;
    };
    return search(this.fileTree);
  }

  private ensureDirectory(dirPath: string): FileNode {
    const normalized = dirPath.replace(/\\/g, '/');
    const rootPath = this.fileTree.path;
    if (normalized === rootPath) return this.fileTree;
    const relative = normalized.startsWith(`${rootPath}/`) ? normalized.slice(rootPath.length + 1) : normalized;
    const segments = relative.split('/').filter(Boolean);
    let current = this.fileTree;

    for (const segment of segments) {
      if (!current.children) current.children = [];
      const nextPath = `${current.path}/${segment}`;
      let next = current.children.find(c => c.path === nextPath && c.type === 'directory');
      if (!next) {
        next = { name: segment, path: nextPath, type: 'directory', children: [] };
        current.children.push(next);
      }
      current = next;
    }

    return current;
  }

  private addFileNode(filePath: string, size: number, ext?: string) {
    const normalized = filePath.replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() || normalized;
    const parentPath = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : this.fileTree.path;
    const parentNode = this.ensureDirectory(parentPath);
    if (!parentNode.children) parentNode.children = [];
    parentNode.children = parentNode.children.filter(c => c.path !== normalized);
    parentNode.children.push({
      name: fileName,
      path: normalized,
      type: 'file',
      extension: ext || fileName.split('.').pop() || '',
      size,
      modifiedAt: Date.now(),
    });
  }

  private updateChildPaths(node: FileNode, oldPrefix: string, newPrefix: string) {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.path.startsWith(oldPrefix)) {
        child.path = `${newPrefix}${child.path.slice(oldPrefix.length)}`;
      }
      this.updateChildPaths(child, oldPrefix, newPrefix);
    }
  }

  private removeFromTree(path: string) {
    const removeFrom = (node: FileNode): boolean => {
      if (node.children) {
        const idx = node.children.findIndex(c => c.path === path);
        if (idx !== -1) { node.children.splice(idx, 1); return true; }
        for (const child of node.children) {
          if (removeFrom(child)) return true;
        }
      }
      return false;
    };
    removeFrom(this.fileTree);
  }

  getFileIcon(extension?: string): string {
    const iconMap: Record<string, string> = {
      pdf: '📕', pptx: '📊', ppt: '📊',
      docx: '📄', doc: '📄',
      xlsx: '📈', xls: '📈',
      md: '📝', txt: '📃',
      py: '🐍', js: '🟨', ts: '🔷', tsx: '⚛️', jsx: '⚛️',
      cpp: '🔧', c: '🔧', java: '☕', rs: '🦀',
      html: '🌐', css: '🎨',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      mp4: '🎬', mp3: '🎵',
      zip: '📦', rar: '📦',
    };
    return iconMap[extension?.toLowerCase() ?? ''] ?? '📄';
  }

  formatFileSize(bytes?: number): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
}

export const fileSystem = new FileSystemService();
