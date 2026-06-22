/**
 * richInput 编辑回填重组算法 —— Plan_5_M6 收尾 D1。
 *
 * 把「持久化的 plainText 字符串 + 有序 richTokens」重组为 Array<string | TokenSpec>，
 * 交给 RichTextInput.setContent / domUtils.setEditorContent 无损还原 atomic 块。
 *
 * 算法要点（游标顺序切分）：
 *   - 旧消息无 richTokens（D1 之前） → 整条纯文本回填（与当前行为逐字节等价，向后兼容）；
 *   - 按 richTokens 顺序遍历，每个 token 用同一份 TOKEN_INLINE 算占位串，在 content 里从 cursor 起 indexOf；
 *   - 命中 → 把 token 前的纯文本段先 push、再 push token、cursor 前移过占位串末尾；
 *   - 占位串找不到（content 被外部手改过 / 不一致） → 跳过该 token、不破坏文本（容错）；
 *   - settings 类型占位为空串、content 里不可见 → 直接 push token（这正是必须存 richTokens 的根因）；
 *   - 末尾留下的纯文本段尾巴照常 push。
 *
 * 单一真相源：TOKEN_INLINE 从 domUtils export 复用，避免「占位规则改了一处忘了另一处」的漂移。
 */

import { TOKEN_INLINE } from './domUtils';
import type { ExtractedToken, TokenSpec } from './types';

export function buildRichParts(content: string, richTokens?: ExtractedToken[]): Array<string | TokenSpec> {
  if (!richTokens || richTokens.length === 0) return [content];
  const parts: Array<string | TokenSpec> = [];
  let cursor = 0;
  for (const tk of richTokens) {
    const placeholder = TOKEN_INLINE[tk.type](tk.value);
    if (placeholder === '') {
      // settings 类型：占位空串，content 里不可见，直接插 token（光有 content 无法还原）。
      parts.push(tk);
      continue;
    }
    const idx = content.indexOf(placeholder, cursor);
    if (idx < 0) continue; // 占位串找不到：跳过该 token，不破坏文本（容错路径）。
    if (idx > cursor) parts.push(content.slice(cursor, idx));
    parts.push(tk);
    cursor = idx + placeholder.length;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts.length > 0 ? parts : [content];
}
