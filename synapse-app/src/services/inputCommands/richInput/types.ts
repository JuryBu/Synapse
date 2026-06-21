/**
 * richInput 共享类型 —— Plan_5_M6 富文本输入框（contenteditable + 内联 atomic @token + 两级类型菜单）。
 *
 * AtType 七类复刻 Antigravity。token 在 DOM 里是 contenteditable=false 的 atomic span，
 * data-type/data-id/data-value 三元组承载结构化信息；发送时 extract 成 { plainText, tokens }，
 * 编辑回填时用 tokens[] 逐个 insertToken 重建（禁止 innerHTML 反序列化，对抗审查 P4/P17）。
 */

/** @ 引用类型（七类）。 */
export type AtType = 'file' | 'directory' | 'conversation' | 'workflow' | 'settings' | 'mcp' | 'terminal';

/** 一级类型菜单顺序（复刻 Antigravity：文件/目录在前，设置/MCP/终端在后）。 */
export const AT_TYPES: readonly AtType[] = ['file', 'directory', 'conversation', 'workflow', 'settings', 'mcp', 'terminal'];

/** token 规格（构造 span / 重建 / 提取共用）。 */
export interface TokenSpec {
  type: AtType;
  /** 稳定标识：conversationId / 文件绝对路径 / modeName / sectionId / mcp__server__tool / terminal sessionId。 */
  id: string;
  /** 显示文本（不含前导 @），如 "Writing A Summer Story" / "src/fileSystem.ts"。 */
  value: string;
}

/** 发送时从编辑器有序提取的 token。 */
export type ExtractedToken = TokenSpec;

export interface ExtractResult {
  /** 纯文本（token 替换为各自占位语义、零宽占位已 strip、换行已归一）。 */
  plainText: string;
  /** 有序 token 列表（注入分派 + 编辑回填重建用）。 */
  tokens: ExtractedToken[];
}

/** @ 触发上下文（contenteditable Range 版，替代 textarea 的字符下标）。 */
export interface AtTrigger {
  /** @ 之后到光标的过滤片段（可空）。 */
  query: string;
  /** @ 字符所在的文本节点。 */
  startNode: Text;
  /** @ 字符在该文本节点内的偏移。 */
  startOffset: number;
}

/** RichTextInput 通过 forwardRef + useImperativeHandle 暴露给父组件的命令式接口。 */
export interface RichTextInputHandle {
  /** 在当前 @ 触发处插入 atomic token（删掉 @query 段）。 */
  insertTokenAt(trigger: AtTrigger, t: TokenSpec): void;
  /** 在光标处直接插入 token（无 @query 段，如编辑回填）。 */
  insertToken(t: TokenSpec): void;
  /** 提取 { plainText, tokens }。 */
  extract(): ExtractResult;
  /** 用结构化内容重建编辑器（编辑回填：文本 + 有序 token，禁 innerHTML）。 */
  setContent(parts: Array<string | TokenSpec>): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
  /** 当前 @ 触发上下文（供父组件 refreshMenu）。 */
  getAtTrigger(): AtTrigger | null;
  getElement(): HTMLDivElement | null;
}

/** 运行时类型守卫：校验字符串是否合法 AtType（对抗审查 P5，防脏 DOM 的非法 data-type）。 */
export function isAtType(v: unknown): v is AtType {
  return typeof v === 'string' && (AT_TYPES as readonly string[]).includes(v);
}
