/**
 * @ 触发检测（contenteditable Range 版）—— Plan_5_M6。
 *
 * 替代 textarea 的 detectTrigger（线性字符下标）：contenteditable 无 selectionStart，基于光标 Range
 * 的 focusNode/focusOffset 在当前文本节点内回看。边界规则（行首/空白前缀、排除 @org/pkg 路径）抽成
 * isValidAtContext 共享，与 triggerDetect 的 @ 判定同口径。
 *
 * 对抗审查相关：
 *   P1  调用方应在 compositionend 后先 root.normalize() 再调本函数（合并被 IME 拆开的相邻文本节点）。
 *   P6  textBefore 判定前 strip 零宽占位（U+200B），使「token 后占位节点里打 @」也能触发；
 *       startOffset 用未 strip 的原始偏移（@query 在原始节点里连续）。
 *
 * 注：正则用 \s 即可——JS 的 \s 已涵盖普通空格 / Tab / 换行 / 全角空格 U+3000，无需单列全角，源码纯 ASCII。
 */

import type { AtTrigger } from './types';
import { ZWSP } from './domUtils';

/** @ 上下文合法性：光标前文本以「(行首|空白)@(非空白非/)」结尾时命中，返回匹配（m[2]=query）或 null。 */
export function isValidAtContext(textBefore: string): RegExpExecArray | null {
  return /(^|\s)@([^\s/]*)$/.exec(textBefore);
}

/** 基于当前光标 Range 检测 @ 触发；无触发返回 null。 */
export function detectAtTrigger(root: HTMLElement): AtTrigger | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
  if (!root.contains(focusNode)) return null;

  const raw = (focusNode.textContent ?? '').slice(0, focusOffset);
  // strip 零宽占位后判定（让 token 后占位节点里打 @ 也能命中，P6）
  const textBefore = raw.split(ZWSP).join('');
  const m = isValidAtContext(textBefore);
  if (!m) return null;
  const query = m[2];
  if (query.includes('/')) return null; // 排除路径 / scoped 包（同 triggerDetect 口径）

  // @ 在原始（未 strip）文本节点里的偏移：@query 子串在 raw 中连续，从末尾回找。
  const needle = '@' + query;
  const atIndex = raw.lastIndexOf(needle);
  if (atIndex < 0) return null;

  return { query, startNode: focusNode as Text, startOffset: atIndex };
}

/** / 命令触发上下文（单层菜单，无需 Range 锚点——命令始终在编辑器开头整体替换）。 */
export interface SlashTrigger {
  /** / 之后到光标的过滤片段（不含斜杠）。 */
  query: string;
}

/**
 * / 命令触发检测（contenteditable 版，与 @ 互斥，P19）。命中条件（严格，避免与文件路径里的 / 混淆）：
 *   1. 光标 collapsed、focusNode 是文本节点且在 root 内；
 *   2. 编辑器里没有任何 atomic token（/命令是纯文本指令，混 token 不触发）；
 *   3. focusNode 是 root 下首个非空文本节点（命令只在最开头）；
 *   4. 光标前文本（strip 零宽后）形如 /query（^/ 开头、query 无空白无第二个 /）。
 */
export function detectSlashTrigger(root: HTMLElement): SlashTrigger | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
  if (!root.contains(focusNode)) return null;
  if (root.querySelector('[data-token]')) return null; // 含 token → 非纯命令场景
  if (firstTextNode(root) !== focusNode) return null;   // 命令只在编辑器开头
  const raw = (focusNode.textContent ?? '').slice(0, focusOffset);
  const textBefore = raw.split(ZWSP).join('');
  const m = /^\/([^\s/]*)$/.exec(textBefore);
  if (!m) return null;
  return { query: m[1] };
}

/** root 下深度优先首个非空（去零宽后）文本节点。 */
function firstTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n && (n.textContent ?? '').split(ZWSP).join('') === '') {
    n = walker.nextNode() as Text | null;
  }
  return n;
}
