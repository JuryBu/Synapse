import { platform } from '@/platform';
import type { AssistantRun, FileDiffSummary, FileSnapshot, Message } from '@/store/slices/conversation';
import {
  sanitizeMessagesForPersistence,
  releaseMessageAttachments,
  migrateMessagesAttachments,
  rollbackMigratedShas,
  collectMessageShas,
} from './attachmentRefs';
import { copyRecord, copyRecordFrom } from './recordStore';
import type { SynapseRecord } from './recordStore';

export const CONVERSATION_SCHEMA_VERSION = 1;
export const AUTOSAVE_ID = 'autosave-current';
const AUTOSAVE_KEY = 'synapse_autosave';

// ★ M2-6 切换闸门：切换/新建对话流程是异步多 await（saveCurrentToHistory→loadConversationSnapshot→
//   setConversation），其间若已 fork autosave 成真实 id 并 clearAutosaveSnapshot()，AgentPanel 的 700ms
//   autosave debounce 仍可能以「切走前对话的 id=null/AUTOSAVE_ID」迟到触发，把 AUTOSAVE_ID 行重新写回
//   （复活已 fork 的草稿）→ 下次启动 loadAutosaveSnapshot 误把它当上次对话恢复、mode 归属错乱。
//   切换/新建期间置闸，saveAutosaveSnapshot 落 AUTOSAVE_ID 行时若闸门开启则直接跳过——把这条竞态的封堵
//   收进持久化层，调用方只需 begin/endConversationSwitch 包住切换流程，避免散落的跨组件 ref。
//   用计数器（非布尔）记重入：并发/嵌套的切换+分支各自 begin/end 配对，只有全部结束才真正落闸解除，
//   避免后完成者的 end 提前给前者解闸而漏掉竞态窗口。
let conversationSwitchDepth = 0;
export function beginConversationSwitch(): void {
  conversationSwitchDepth += 1;
}
export function endConversationSwitch(): void {
  conversationSwitchDepth = Math.max(0, conversationSwitchDepth - 1);
}
export function isConversationSwitching(): boolean {
  return conversationSwitchDepth > 0;
}
const LEGACY_CONVERSATIONS_KEY = 'synapse_conversations';
const LEGACY_CONVERSATION_METADATA_KEY = 'synapse:conversation:metadata';

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
  model: string;
  archived?: boolean;
  tags?: string[];
  // M3-1a：子代理对话标记。普通历史列表默认过滤掉（listConversationSummaries），仅 M3-3 卡片专门读取。
  isSubAgent?: boolean;
}

export interface ConversationSnapshot {
  id?: string | null;
  title?: string;
  model?: string;
  // M2-6 对话级元数据：每个对话记自己的 agent 模式 / 思考层级（真相在 agentSettings 镜像，落库随对话存）。
  //   保存时由调用方填入当前 agentSettings.mode / reasoningEffort；undefined 时持久化层不覆盖已有行的旧值。
  mode?: string;
  reasoningEffort?: string;
  archived?: boolean;
  tags?: string[];
  messages: Message[];
  assistantRuns?: Record<string, AssistantRun>;
  fileSnapshots?: Record<string, FileSnapshot>;
  pendingDiffs?: FileDiffSummary[];
  timestamp?: number;
  // M2-3 对话分支溯源：仅 fork 出的新对话携带；普通保存为 undefined（落 NULL）。
  parentId?: string | null;
  branchedFromMessageId?: string | null;
  // M3-1a 真子代理：子代理跑完落库的独立 conversation 带 true（+ parentId=主对话 id），供卡片点进查看。
  //   普通对话保存为 undefined（落默认 false），不进 Redux 当前对话 slice、不污染主对话 UI。
  isSubAgent?: boolean;
}

export interface ConversationListFilters {
  query?: string;
  archived?: 'all' | 'active' | 'archived';
  tags?: string[];
  limit?: number;
}

export interface ConversationExportBundle {
  version: number;
  exportedAt: string;
  filters?: ConversationListFilters;
  conversations: Array<{
    summary: ConversationSummary;
    snapshot: ConversationSnapshot | null;
  }>;
}

export function createConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成一条新消息 id。
 * ★ M2-3 分支主键修复：messages.id 是全局 UNIQUE 主键。分支把消息复制成【独立新对话】时，
 *   若复用源 message.id，INSERT 会撞 `UNIQUE constraint failed: messages.id`。
 *   故复制时每条消息必须换新 id（branchedFromMessageId 仍指向源原 id，见 branchConversation）。
 *
 * ★ 审查 issue①②根治：原实现 `msg_<ts>_<6位base36随机>` 的唯一性在【同批紧循环 map】里只剩随机后缀一个维度
 *   （所有 Date.now() 落同毫秒），36^6 ≈ 21.7 亿空间——既可能同批自撞（生日悖论，长对话非零概率），
 *   也可能撞库里任意历史 message.id（全库越满概率越高），而 replaceMessages 是纯 INSERT（撞则整批事务回滚→分支失败）。
 *   改用 crypto.randomUUID()（122 位随机，全库碰撞概率趋于 0），同时治同批自撞与跨行撞，且与 attachment sha 体系风格自洽。
 *   非安全上下文 / 旧环境无 randomUUID 时回退到「时间戳 + 双段随机」高熵后缀（仍由 branchConversation 内 Set 兜底去重）。
 */
function createMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `msg_${uuid}`;
  // Fallback（无 crypto.randomUUID 的环境）：双段随机扩大熵，降低同毫秒同后缀概率。
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function saveAutosaveSnapshot(snapshot: ConversationSnapshot): Promise<void> {
  const id = snapshot.id || AUTOSAVE_ID;
  // ★ M2-6 切换竞态封堵（本轮收紧，把 mode/reasoningEffort 一并纳入保护）：
  //   切换/新建/分支流程进行中（begin~endConversationSwitch 窗口），丢弃【任何 id】的被动 autosave 写入，
  //   而非仅挡 AUTOSAVE_ID 镜像。原因：切走对话时 AgentPanel 的 700ms autosave debounce 可能在
  //   「setConversation(刚加载对话) 已生效、但 setReasoningEffort(该对话 DB 值) 尚未在同批 render 落定」的
  //   窗口到点，用【全局旧 reasoningEffort】update 回刚加载对话的真实 id 行 → 把 DB 里该对话存的 high 冲成 auto
  //   （真机 A2：high→auto）。saveAutosaveSnapshot 是唯一的被动 autosave 入口；切换前 saveCurrentToHistory
  //   已主动把切走对话落库、切换后依赖变化会重新触发 debounce，故切换窗口内丢弃这一拍 autosave 不丢数据，
  //   却能堵死「加载瞬间用全局旧值回写覆盖刚加载对话」的覆盖点（mode 同享此保护，不破坏 mode 既有行为）。
  //   主动落库（saveConversationSnapshot / handleNewConversation / branch promotion）走 persistPlatformSnapshot，
  //   不经此函数，不受闸门影响——它们本就该落库。
  if (isConversationSwitching()) return;
  const timestamp = snapshot.timestamp ?? Date.now();
  // M2-R6：落库前剥掉任何残留 base64（持 sha256 引用即清内联 data:），localStorage / 平台两条路都净化。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  const normalized = {
    ...snapshot,
    id,
    messages: sanitizedMessages,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    timestamp,
  };

  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage may be unavailable or full; Electron persistence below is still attempted.
  }

  const metadata = {
    title: snapshot.title || '自动保存',
    model: snapshot.model,
    // M2-6：autosave 也带上当前对话 mode / reasoningEffort，使刷新/重启后恢复对话能拿回设置。
    mode: snapshot.mode,
    reasoningEffort: snapshot.reasoningEffort,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
  };

  await persistPlatformSnapshot(id, metadata, sanitizedMessages);
}

export async function clearAutosaveSnapshot(): Promise<void> {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Ignore unavailable localStorage.
  }
  await platform.conversation.delete(AUTOSAVE_ID).catch(() => false);
}

export async function loadAutosaveSnapshot(): Promise<ConversationSnapshot | null> {
  const fromPlatform = await loadPlatformSnapshot(AUTOSAVE_ID);
  if (fromPlatform?.messages.length) return fromPlatform;

  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed.messages)) return parsed;
  } catch {
    return null;
  }
  return null;
}

export async function saveConversationSnapshot(snapshot: ConversationSnapshot): Promise<ConversationSummary | null> {
  if (!snapshot.messages.length) return null;
  const id = !snapshot.id || snapshot.id === AUTOSAVE_ID ? createConversationId() : snapshot.id;
  const title = snapshot.title || getFallbackTitle(snapshot.messages);
  const timestamp = snapshot.timestamp ?? Date.now();
  const metadata = {
    title,
    model: snapshot.model,
    // M2-6：随对话保存当前 mode / reasoningEffort（undefined 时持久化层不覆盖旧值，见 persistPlatformSnapshot）。
    mode: snapshot.mode,
    reasoningEffort: snapshot.reasoningEffort,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
    // M2-3：fork 时携带溯源，普通保存为 undefined（不覆盖已有行的 parent 字段）。
    parentId: snapshot.parentId,
    branchedFromMessageId: snapshot.branchedFromMessageId,
    // M3-1a：子代理对话落库带 true（create 时写定）；普通保存为 undefined → 落默认 false。
    isSubAgent: snapshot.isSubAgent,
  };

  // M2-R6：正式保存同样落库去 base64。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  await persistPlatformSnapshot(id, metadata, sanitizedMessages);
  // ★ Codex P2-2 修复：子代理对话【不写 legacy map】——legacy metadata 不带 isSubAgent，
  //   写了就会被 listLegacyConversationSummaries 列进普通历史且无法过滤。子对话只走 platform 层（带 is_subagent 列），
  //   主路径按 isSubAgent 过滤即可彻底排除出普通列表。
  if (!snapshot.isSubAgent) writeLegacyConversation(id, sanitizedMessages);

  return {
    id,
    title,
    lastMessage: metadata.lastMessage,
    timestamp,
    messageCount: snapshot.messages.length,
    model: snapshot.model || 'unknown',
    archived: Boolean(snapshot.archived),
    tags: normalizeTags(snapshot.tags),
  };
}

/** branchConversation 的返回：新对话 summary + 新对话身份信息（供调用方切换/落库）。 */
export interface BranchResult {
  summary: ConversationSummary;
  newId: string;
  parentId: string;
  branchedFromMessageId: string;
  /** 分支携带到新对话的消息子集（含分支点该条），供调用方 setConversation 切入。 */
  messages: Message[];
  title: string;
  model?: string;
  /**
   * 附件 addRef 最终仍失败的 sha256 列表（已含 1 次重试后仍未 +1 的）。空数组=全部成功。
   * 这些 sha 在新分支里【未对齐 refCount】：源对话删除后归零会被误删实体 → 新分支该图永久缺失。
   * 上层据此提示用户「分支附件可能未完整保留」，便于其重新分支或保留源对话。
   */
  addRefFailedShas: string[];
}

/**
 * 对单个 sha 做 addRef，统一识别两类失败：
 *   - Promise reject（Electron IPC 抖动 / DB 锁）→ catch 捕获；
 *   - 返回 { error:true }（Web 端 meta 不存在等）→ 不 reject，需显式判定。
 * 成功返回 true；任一类失败返回 false（不抛）。
 */
async function tryAddRefOnce(sha: string): Promise<boolean> {
  try {
    const res = await platform.attachment.addRef(sha);
    // Web 端 addRef 对不存在 meta 返回 { error:true }（非 reject），必须显式识别为失败。
    if (res && typeof res === 'object' && 'error' in res && (res as { error?: unknown }).error) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 对话分支（M2-3）：在源对话 fromMessageId 处「从此分支」，把【该消息及之前的消息子集】另存为一个新对话。
 *
 * 语义（复制而非移动，源对话绝不改动）：
 *   1. 取源 messages 里 fromMessageId 及之前的连续前缀子集（含该条）。
 *   2. createConversationId 生成新 id；saveConversationSnapshot 落新对话
 *      （messages=子集，parentId=源 id，branchedFromMessageId=fromMessageId）。
 *   3. copyRecord(源, 新, keptSteps, keptRounds) 继承到该点的 record 多批次。
 *      - keptRounds = 子集里 role==='user' 的条数；
 *      - keptSteps  = 子集里 role!=='tool' 的条数（★ 与 clampToBatch / agentLoop requestHistory「不含 tool」step 口径严格一致）。
 *   4. 附件 refCount：对子集 collectMessageShas 得到的每个 sha256 调 platform.attachment.addRef（+1）。
 *      新对话与源对话复用同一附件实体，必须 +1，否则源对话删除/GC 后新分支的图失效（与 R6 fork refCount 欠计同类坑）。
 *      —— 顺序：先 save（落库即引用态，与源行同时引用同一 sha）再 addRef，使「持有数」对齐「refCount」。
 *      —— 失败补偿：addRef 失败（reject 或 Web 端 {error:true}）会做 1 次有限重试；仍失败的 sha 收进
 *         BranchResult.addRefFailedShas 并 console.warn，上层据此提示「分支附件可能未完整保留」。每个 sha 至多 +1，守恒。
 *
 * @param srcId 源对话 id（写入新对话 parentId 溯源；分支不修改源）。
 * @param fromMessageId 分支点消息 id。
 * @param messages 源对话当前完整消息列表（运行态 store 的 messages）。
 * @param meta 新对话标题/模型（缺省由消息派生）；recordSrcId 指定 record 实际所在的 id——
 *   autosave 源刚 fork 成真实 id 时，record 仍在 AUTOSAVE_ID 键下尚未迁移，此时 recordSrcId 应传旧 id，
 *   否则 copyRecord 从新真实 id 读不到任何 record（缺省回退 srcId）。
 *   recordSnapshot：可选的【内存 record 快照】——autosave 源分支时，调用方在 clearAutosaveSnapshot
 *   （会经 SQLite FK CASCADE 级联删掉 records 行）之前先抓好的源 record。传入则优先从内存继承（copyRecordFrom），
 *   不再依赖可能已被级联删除的库行（修 issue④⑤：Electron autosave 分支 record 继承落空 + 双模式不对等）。
 * @returns BranchResult；分支点不存在 / 源消息为空 / 落库失败 → null。
 */
export async function branchConversation(
  srcId: string,
  fromMessageId: string,
  messages: Message[],
  // M2-6：mode / reasoningEffort 可选——分支继承源对话当前设置并落到新分支 DB 行，
  //   使新分支「切走再切回」恢复出的设置与分支那一刻一致（缺省则 create 落默认 planning/auto）。
  meta?: { title?: string; model?: string; mode?: string; reasoningEffort?: string; recordSrcId?: string; recordSnapshot?: SynapseRecord | null },
): Promise<BranchResult | null> {
  if (!srcId || !fromMessageId || !Array.isArray(messages) || messages.length === 0) return null;
  const cutIdx = messages.findIndex(m => m.id === fromMessageId);
  if (cutIdx < 0) return null;

  // 1. 子集 = 分支点及之前（含该条）。深拷贝隔离，绝不触碰源 store 引用。
  //    ★ M2-3 主键修复：messages.id 是全局 UNIQUE 主键。分支是【复制成独立新对话】，源对话原行仍占着原 message.id，
  //      若新对话复用同一批 message.id，replaceMessages → INSERT 会撞 `UNIQUE constraint failed: messages.id`。
  //      故每条复制出的消息重新生成 message.id。安全性：
  //        - record 继承只用 convId + step/round 计数（copyRecord），不依赖 message.id；
  //        - 附件 refCount 只看 contentParts/attachments 的 sha256（collectMessageShas），不依赖 message.id；
  //        - 按「清洁分支语义」新对话不复制 assistantRuns/fileSnapshots/pendingDiffs，
  //          故 AssistantRun.messageId / runEvents 等按 message.id 的反向关联无需重映射（本就不带过去）。
  //      branchedFromMessageId 必须指向【源对话的原 message.id】（fromMessageId），不是这里换出来的新 id。
  //
  //    ★ 审查 issue①（同批去重兜底）：createMessageId 已升级为 crypto.randomUUID（碰撞趋于 0），
  //      但这里再加一道 Set 去重做【确定性】保证——同批内绝不出现两条相同 id（不靠概率），
  //      杜绝纯 INSERT 撞 UNIQUE 致整批事务回滚、分支静默失败。
  //
  //    ★ 审查 issue③（high）修复：原 `{...m}` 全量展开会把每条消息内联的【运行/差异态】
  //      （runId / runEvents / diffs / rollbackSnapshotId / 流式态）一并带进新分支并落库（IPC 会写
  //      run_id/run_events/diffs/rollback_snapshot_id 列）。这与「清洁分支语义」自相矛盾：顶层
  //      assistantRuns/fileSnapshots/pendingDiffs 被置空，但消息级内联态没清 → 新分支渲染出源对话遗留的
  //      diff 卡片，而新分支 fileSnapshots={}，对这些遗留 diff 接受/拒绝/回溯时 snapshotId 落空 →
  //      rollbackFileDiff 抛「缺少回退快照」或误改活动工作区；runId 在新分支 assistantRuns 里悬空。
  //      故这里显式剥离运行/差异/流式态，只保留纯内容态（role/content/contentParts/attachments/thinking/
  //      timestamp/model/toolCalls 等），与顶层「不带 assistantRuns/fileSnapshots/pendingDiffs」一致；
  //      且不影响 collectMessageShas（只看 contentParts/attachments）和 copyRecord（只看 step/round 计数）。
  const usedIds = new Set<string>();
  const subset = messages.slice(0, cutIdx + 1).map(m => {
    const {
      runId: _runId,
      runEvents: _runEvents,
      diffs: _diffs,
      rollbackSnapshotId: _rollbackSnapshotId,
      isStreaming: _isStreaming,
      streamState: _streamState,
      streamMode: _streamMode,
      fallbackReason: _fallbackReason,
      showStreamCursor: _showStreamCursor,
      showGeneratingPlaceholder: _showGeneratingPlaceholder,
      // ★ M4-8-S3：reconnect 是 UI 瞬态（重连进度），分支复制时一并剥离，绝不带进新对话/落库。
      reconnect: _reconnect,
      ...keep
    } = m;
    // 确定性去重：极小概率两次 randomUUID 撞了也再生成，绝不让同批出现重复 id。
    let id = createMessageId();
    while (usedIds.has(id)) id = createMessageId();
    usedIds.add(id);
    return { ...keep, id };
  });
  if (subset.length === 0) return null;

  // 2. step/round 口径（★ 必须与 clampToBatch / copyRecord 严格一致）：
  //    keptSteps 不含 tool 角色；keptRounds 只算 user 角色。
  const keptRounds = subset.filter(m => m.role === 'user').length;
  const keptSteps = subset.filter(m => m.role !== 'tool').length;

  const newId = createConversationId();
  const title = meta?.title || getFallbackTitle(subset);

  // 3. 落新对话（带 parent 溯源）。源对话完全不动。
  const summary = await saveConversationSnapshot({
    id: newId,
    title,
    model: meta?.model,
    // M2-6：分支继承源对话 mode / reasoningEffort（调用方传入当前设置）。
    mode: meta?.mode,
    reasoningEffort: meta?.reasoningEffort,
    messages: subset,
    parentId: srcId,
    branchedFromMessageId: fromMessageId,
    timestamp: Date.now(),
  });
  if (!summary) return null;

  // 4. 继承 record 到分支点（截连续前缀批次）。record 是加速层，失败不阻塞分支。
  //    record 实际所在 id 可能 != parent srcId（autosave 刚 fork 时 record 还在旧 AUTOSAVE_ID 键下）。
  //    ★ issue④⑤：autosave 源分支时调用方会先 clearAutosaveSnapshot（Electron 经 FK CASCADE 级联删掉
  //      `records WHERE conversation_id='autosave-current'`），此时按 recordSrcId 现读已是 null。
  //      故调用方在级联删除前抓好的内存 record 快照（meta.recordSnapshot）优先 —— 从内存继承，两端一致；
  //      未传快照（普通真实对话分支，record 仍在库）则回退按 id 现读。
  const recordSrcId = meta?.recordSrcId || srcId;
  if (meta && 'recordSnapshot' in meta && meta.recordSnapshot !== undefined) {
    await copyRecordFrom(meta.recordSnapshot ?? null, newId, keptSteps, keptRounds).catch(() => null);
  } else {
    await copyRecord(recordSrcId, newId, keptSteps, keptRounds).catch(() => null);
  }

  // 5. 附件 refCount +1：新对话复用源对话同一附件实体，每个 sha256 加一次引用（与 collectMessageShas 口径守恒：
  //    每条消息内同一 sha 只计一次、跨消息累加）。
  //    ★ 补偿（本轮修复）：addRef 是引用计数关键写，失败后果是数据级（源删后归零误删实体 → 新分支图永久缺失），
  //    比纯读降级更严重，故不再静默吞错：
  //      - 区分 reject 与 Web 端返回的 { error:true }（tryAddRefOnce 内统一识别）；
  //      - 首次失败做 1 次有限重试（吸收 IPC 抖动 / DB 短暂锁）；
  //      - 仍失败的 sha 收集进 addRefFailedShas，console.warn 一条可观测日志，并随 BranchResult 回传上层提示。
  //    注意守恒：每个 sha 至多 +1（成功即不再重试），失败则 0 次，与 collectMessageShas 持有口径严格对齐，绝不重复 addRef。
  const shas = collectMessageShas(subset);
  const addRefFailedShas: string[] = [];
  if (shas.length > 0) {
    await Promise.all(shas.map(async sha => {
      if (await tryAddRefOnce(sha)) return;
      // 1 次有限重试。
      if (await tryAddRefOnce(sha)) return;
      addRefFailedShas.push(sha);
    }));
  }
  if (addRefFailedShas.length > 0) {
    // 可观测日志：用户无感知的数据级风险，至少落一条 warn 便于排查。
    console.warn(
      `[branchConversation] ${addRefFailedShas.length} 个附件 addRef 失败（重试后仍未 +1），`
      + `源对话删除后这些图可能被误删：`,
      addRefFailedShas,
    );
  }

  return {
    summary,
    newId,
    parentId: srcId,
    branchedFromMessageId: fromMessageId,
    messages: subset,
    title,
    model: meta?.model,
    addRefFailedShas,
  };
}

export async function listConversationSummaries(filters: string | ConversationListFilters = ''): Promise<ConversationSummary[]> {
  const normalizedFilters = normalizeFilters(filters);
  const trimmed = normalizedFilters.query.trim();
  const platformRows = await (trimmed
    ? platform.conversation.search(trimmed, {
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
    })
    : platform.conversation.list({
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
    })).catch(() => []);
  const summaries = platformRows
    .map(mapConversationSummary)
    .filter((summary): summary is ConversationSummary => Boolean(summary))
    .filter(summary => summary.id !== AUTOSAVE_ID)
    .filter(summary => summary.messageCount > 0)
    // ★ Codex P2-2 修复：子代理对话是内部 transcript，仅 M3-3 卡片点进查看，不进普通历史列表/侧边栏/批量操作。
    .filter(summary => !summary.isSubAgent);

  const legacy = listLegacyConversationSummaries(normalizedFilters);
  const seen = new Set(summaries.map(summary => summary.id));
  for (const summary of legacy) {
    if (!seen.has(summary.id)) summaries.push(summary);
  }

  return summaries
    .filter(summary => matchesFilters(summary, normalizedFilters))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function loadConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await platform.conversation.update(id, { title }).catch(() => false);
  updateLegacyConversationMetadata(id, { title });
}

export async function deleteConversationSnapshot(id: string): Promise<void> {
  // M2-R6 refCount GC：删对话前先把它引用的附件 sha256 收齐，删后逐个 release（归零删实体）。
  // 删消息记录会丢失引用信息，故必须在 delete 之前读取。失败吞掉，不阻塞删除主流程。
  await releaseConversationAttachments(id);
  await platform.conversation.delete(id).catch(() => false);
  deleteLegacyConversation(id);
}

export async function deleteConversationSnapshots(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;

  // M2-R6 refCount GC：批量删同样先收集再 release。
  await Promise.all(uniqueIds.map(id => releaseConversationAttachments(id)));

  if (platform.conversation.batchDelete) {
    await platform.conversation.batchDelete(uniqueIds).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
  }

  uniqueIds.forEach(deleteLegacyConversation);
}

/** 删对话前：读出其消息、收集附件 sha256 并 release（refCount-1，归零 GC）。失败静默。 */
async function releaseConversationAttachments(id: string): Promise<void> {
  try {
    const snapshot = await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
    if (snapshot?.messages?.length) {
      await releaseMessageAttachments(snapshot.messages);
    }
  } catch {
    // GC 是加速/清理层，绝不阻塞删除主流程。
  }
}

/**
 * M2-R6 懒迁移入口：把一个 snapshot 里旧内联 base64 抽离成 sha256 引用，若有变更则回写 DB（按 id 持久化）。
 * 「用到才迁、不阻塞渲染」——调用方（AgentPanel / ConversationList）在 load 之后 fire-and-forget 调用，
 * 迁移成功后下次加载即引用态。
 *
 * onMigrated 回调（可选）：迁移确有变更时，把【迁移后的引用态 messages + 对话 id】交回调用方，
 * 由调用方决定是否安全地用其更新 store（需自行校验 store 当前对话未被切换/未追加新消息，再 dispatch）。
 * 不提供回调则仅回写 DB（store 保持旧 base64 态，下次加载即引用态）。
 *
 * 返回迁移后的 messages（changed=false 时即原 messages）。
 */
/**
 * 按 conversationId 的在途迁移锁（模块级 Map<id, Promise>）。
 * ★ Codex 中风险修复（并发迁移竞态）：AgentPanel 挂载迁 AUTOSAVE、ConversationList 切换迁目标对话，
 *   多入口/多窗口/重载下若对同一 DB 行（仍内联 base64）在首个迁移回写完成前重入，两路各 put 一遍 →
 *   refCount 翻倍，writeback 幂等只在【完成后】生效，竞态窗口内防不住。
 *   同 id 复用同一 in-flight 迁移 Promise，串行化首个迁移；后到的复用结果，不再重复 put。
 */
const inflightMigrations = new Map<string, Promise<Message[]>>();

export function migrateSnapshotAttachments(
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  if (!snapshot?.messages?.length) return Promise.resolve(snapshot?.messages ?? []);
  const id = snapshot.id || AUTOSAVE_ID;
  const existing = inflightMigrations.get(id);
  if (existing) return existing;
  const task = runSnapshotMigration(id, snapshot, onMigrated)
    .finally(() => { inflightMigrations.delete(id); });
  inflightMigrations.set(id, task);
  return task;
}

async function runSnapshotMigration(
  id: string,
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  const { messages, changed, newShas } = await migrateMessagesAttachments(snapshot.messages);
  if (!changed) return snapshot.messages;
  const refMessages = sanitizeMessagesForPersistence(messages);
  // 回写：仅替换消息体（已是引用态，sanitize 再兜一道），保持元数据不变。
  // ★ Codex 中风险②修复：必须把【所有读取来源】都回写成引用态，否则下次 load 仍读到旧 base64 →
  //   重复 put 抬高 ref_count 且永不清。来源含：平台 DB（loadPlatformSnapshot）、legacy map（loadLegacyConversationSnapshot）、
  //   AUTOSAVE_KEY localStorage 镜像。三者全覆盖才真正闭环（迁移幂等）。
  // ★ Codex 中风险修复（回写失败 → 重复 put）：迁移在回写前已 put 成功(refCount+1)。若回写抛错，
  //   DB 仍是旧内联态，下次 load 再次 hasInlineBase64 → 再 put → refCount 单调上涨、GC 永远追不平。
  //   故回写抛错时把本轮新增引用 newShas 逐个 release 回滚，并【不通知 onMigrated】（store 保持旧 base64 态，
  //   下次重迁会重新 put），使「put 与持有关系」严格守恒。
  try {
    const existing = await platform.conversation.get(id).catch(() => null);
    if (existing) {
      // 平台 DB 有行：replaceMessages 覆盖即闭环（下次 loadPlatformSnapshot 优先返回引用态）。
      await platform.conversation.replaceMessages(id, refMessages.map(message => ({
        ...message,
        conversationId: id,
      })));
      // 顺带清理同 id 的 legacy 残留（若存在），避免它日后又被当旧数据读出。
      if (id in readLegacyConversationMap()) writeLegacyConversation(id, refMessages);
    } else if (id in readLegacyConversationMap()) {
      // 纯 legacy 对话（平台 DB 无行、仅 synapse_conversations map 有）：必须回写 legacy map，
      // 否则每次打开都重新 put、ref_count 暴涨且 base64 永留。覆盖为引用态后下次不再迁移。
      writeLegacyConversation(id, refMessages);
    } else {
      // 平台 DB 与 legacy 均无该 id 的行：无处可回写，下次 load 仍会读到旧 base64 重迁 →
      // 与「回写失败」同源，回滚本轮引用避免 refCount 漂移。
      await rollbackMigratedShas(newShas);
      return snapshot.messages;
    }
    // 同步 localStorage 自动保存镜像（若当前就是 autosave）。
    if (id === AUTOSAVE_ID) {
      try {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          parsed.messages = refMessages;
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(parsed));
        }
      } catch { /* localStorage 不可用则跳过 */ }
    }
  } catch {
    // 回写失败：回滚本轮新增引用，保持 DB 旧内联态（下次再迁），不通知 onMigrated。
    await rollbackMigratedShas(newShas);
    return snapshot.messages;
  }
  // 回写成功后通知调用方（让其把 store 也修正成引用态，杜绝 store 残留 base64 反复被 autosave 写回）。
  try {
    onMigrated?.(id, messages);
  } catch {
    // 回调异常不影响迁移结果。
  }
  return messages;
}

export async function updateConversationMetadata(
  id: string,
  metadata: { title?: string; archived?: boolean; tags?: string[] },
): Promise<void> {
  const normalized = normalizeMetadataPatch(metadata);
  await platform.conversation.update(id, normalized).catch(() => false);
  updateLegacyConversationMetadata(id, normalized);
}

export async function updateConversationsMetadata(
  ids: string[],
  metadata: { archived?: boolean; tags?: string[] },
): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;
  const normalized = normalizeMetadataPatch(metadata);

  if (platform.conversation.batchUpdate) {
    await platform.conversation.batchUpdate(uniqueIds, normalized).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
  }

  uniqueIds.forEach(id => updateLegacyConversationMetadata(id, normalized));
}

export async function exportConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return loadConversationSnapshot(id);
}

export async function exportConversationSnapshots(
  ids: string[],
  filters?: ConversationListFilters,
): Promise<ConversationExportBundle> {
  const wanted = new Set(ids);
  const summaries = (await listConversationSummaries({ ...(filters ?? {}), archived: filters?.archived ?? 'all' }))
    .filter(summary => wanted.has(summary.id));
  const conversations = await Promise.all(summaries.map(async summary => ({
    summary,
    snapshot: await exportConversationSnapshot(summary.id),
  })));

  return {
    version: CONVERSATION_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    filters,
    conversations,
  };
}

async function loadPlatformSnapshot(id: string): Promise<ConversationSnapshot | null> {
  try {
    const conversation = await platform.conversation.get(id);
    if (!conversation) return null;
    const messages = await platform.conversation.listMessages(id);
    return {
      id,
      title: conversation.title,
      model: conversation.model,
      // M2-6：随快照回带对话级 mode / reasoningEffort（两端 mapConversation/Web get 都带这两字段）。
      //   旧对话该列为 null/缺省 → 回退默认（mode='planning'、reasoningEffort='auto'），切换时同步进全局 agentSettings。
      //   ★ 健壮性：用「空串/NULL/undefined 都回退」（fallbackMeta，非纯 ??）——DB reasoning_effort 列无 DEFAULT，
      //     旧行或异常写入可能落空串 ''，?? 不拦空串会让下拉框落空（子代理 low 提到）。mode 一并兜空串保持对称。
      mode: fallbackMeta(conversation.mode, 'planning'),
      reasoningEffort: fallbackMeta(conversation.reasoningEffort ?? conversation.reasoning_effort, 'auto'),
      archived: Boolean(conversation.archived),
      tags: normalizeTags(conversation.tags),
      messages: messages as Message[],
      assistantRuns: conversation.assistantRuns ?? {},
      fileSnapshots: conversation.fileSnapshots ?? {},
      pendingDiffs: conversation.pendingDiffs ?? [],
      timestamp: normalizeTimestamp(conversation.updatedAt ?? conversation.timestamp),
      // M2-3：分支溯源随快照回带（两端 mapConversation/Web get 都已带上这两字段，普通对话为 null）。
      parentId: conversation.parentId ?? conversation.parent_id ?? null,
      branchedFromMessageId: conversation.branchedFromMessageId ?? conversation.branched_from_message_id ?? null,
      // M3-1a：子代理标记随快照回带（两端 mapConversation/Web get 都映射成 isSubAgent，普通对话 false）。
      isSubAgent: Boolean(conversation.isSubAgent ?? conversation.is_subagent),
    };
  } catch {
    return null;
  }
}

async function persistPlatformSnapshot(
  id: string,
  metadata: {
    title: string;
    model?: string;
    // M2-6 对话级元数据（undefined 时 IPC / Web update 均跳过不覆盖旧值）。
    mode?: string;
    reasoningEffort?: string;
    schemaVersion: number;
    lastMessage: string;
    assistantRuns: Record<string, AssistantRun>;
    fileSnapshots: Record<string, FileSnapshot>;
    pendingDiffs: FileDiffSummary[];
    archived?: boolean;
    tags?: string[];
    // M2-3 对话分支溯源（仅 create 时有意义；update 路径下若为 undefined，IPC 端会跳过不覆盖）。
    parentId?: string | null;
    branchedFromMessageId?: string | null;
    // M3-1a 子代理标记（仅 create 时有意义；update 路径下若为 undefined，IPC / Web 端会跳过不覆盖）。
    isSubAgent?: boolean;
  },
  messages: Message[],
): Promise<void> {
  const existing = await platform.conversation.get(id).catch(() => null);
  let createdNew = false;
  // M2-R6 终极防线：所有平台落库都从这里走，内部再 sanitize 一道（幂等），
  // 即便上游漏调 sanitizeMessagesForPersistence 也保证 DB 绝不含 base64。
  const safeMessages = sanitizeMessagesForPersistence(messages);
  try {
    if (existing) {
      await platform.conversation.update(id, metadata);
    } else {
      await platform.conversation.create({ id, ...metadata });
      createdNew = true;
    }

    await platform.conversation.replaceMessages(id, safeMessages.map(message => ({
      ...message,
      conversationId: id,
    })));
  } catch (error) {
    if (createdNew) await platform.conversation.delete(id).catch(() => false);
    throw error;
  }
}

function mapConversationSummary(row: any): ConversationSummary | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title || '新对话',
    lastMessage: row.lastMessage || row.last_message || '',
    timestamp: normalizeTimestamp(row.updatedAt ?? row.timestamp ?? row.createdAt),
    messageCount: Number(row.messageCount ?? row.message_count ?? 0),
    model: row.model || 'unknown',
    archived: Boolean(row.archived),
    tags: normalizeTags(row.tags),
    // M3-1a：两端 mapConversation/Web summary 都带 isSubAgent（驼峰）/ is_subagent（下划线），普通对话 false。
    isSubAgent: Boolean(row.isSubAgent ?? row.is_subagent),
  };
}

/**
 * 对话级元数据（mode / reasoningEffort）回退：null / undefined / 空串都回退到默认。
 * ★ M2-6 健壮性：reasoning_effort 列无 DEFAULT，旧行/异常可能落空串 ''；纯 `?? 'auto'` 不拦空串，
 *   会让恢复出的下拉值落空。统一走此函数，把空串也视作「未设置」回退默认（与 dispatch 侧 `x || 'auto'` 同口径）。
 */
function fallbackMeta(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function getLastMessageText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  return last?.content?.slice(0, 200) ?? '';
}

function getFallbackTitle(messages: Message[]): string {
  const firstUser = messages.find(message => message.role === 'user')?.content?.trim();
  if (!firstUser) return '新对话';
  return firstUser.slice(0, 30) + (firstUser.length > 30 ? '...' : '');
}

function readLegacyConversationMap(): Record<string, Message[]> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function readLegacyConversationMetadata(): Record<string, Partial<ConversationSummary>> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATION_METADATA_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLegacyConversationMetadata(metadata: Record<string, Partial<ConversationSummary>>): void {
  try {
    localStorage.setItem(LEGACY_CONVERSATION_METADATA_KEY, JSON.stringify(metadata));
  } catch {
    // Ignore unavailable localStorage.
  }
}

function writeLegacyConversation(id: string, messages: Message[]): void {
  try {
    const stored = readLegacyConversationMap();
    stored[id] = messages;
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
  } catch {
    // Legacy compatibility is best-effort; platform persistence is primary.
  }
}

function deleteLegacyConversation(id: string): void {
  try {
    const stored = readLegacyConversationMap();
    delete stored[id];
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
    const metadata = readLegacyConversationMetadata();
    delete metadata[id];
    writeLegacyConversationMetadata(metadata);
  } catch {
    // Ignore unavailable localStorage.
  }
}

function updateLegacyConversationMetadata(id: string, patch: Partial<ConversationSummary>): void {
  const metadata = readLegacyConversationMetadata();
  const current = metadata[id] ?? {};
  metadata[id] = {
    ...current,
    ...patch,
    tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
  };
  writeLegacyConversationMetadata(metadata);
}

function loadLegacyConversationSnapshot(id: string): ConversationSnapshot | null {
  const messages = readLegacyConversationMap()[id];
  if (!Array.isArray(messages)) return null;
  const metadata = readLegacyConversationMetadata()[id] ?? {};
  return {
    id,
    title: metadata.title || getFallbackTitle(messages),
    archived: Boolean(metadata.archived),
    tags: normalizeTags(metadata.tags),
    messages,
    timestamp: Date.now(),
  };
}

function listLegacyConversationSummaries(filters: ConversationListFilters): ConversationSummary[] {
  const lowerQuery = filters.query?.toLowerCase() ?? '';
  const metadata = readLegacyConversationMetadata();
  return Object.entries(readLegacyConversationMap())
    .filter(([, messages]) => Array.isArray(messages))
    .map(([id, messages]) => {
      const meta = metadata[id] ?? {};
      const title = meta.title || getFallbackTitle(messages);
      const lastMessage = getLastMessageText(messages);
      return {
        id,
        title,
        lastMessage,
        timestamp: Math.max(...messages.map(message => Number(message.timestamp) || 0), 0) || Date.now(),
        messageCount: messages.length,
        model: messages.find(message => message.model)?.model || 'unknown',
        archived: Boolean(meta.archived),
        tags: normalizeTags(meta.tags),
      };
    })
    .filter(summary => {
      if (!lowerQuery) return true;
      const messages = readLegacyConversationMap()[summary.id] ?? [];
      return [summary.title, summary.lastMessage, summary.model, ...(summary.tags ?? []), ...messages.map(message => message.content)]
        .join('\n')
        .toLowerCase()
        .includes(lowerQuery);
    })
    .filter(summary => matchesFilters(summary, filters));
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map(tag => String(tag).trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function normalizeFilters(filters: string | ConversationListFilters): ConversationListFilters & {
  query: string;
  archived: 'all' | 'active' | 'archived';
  tags: string[];
  limit: number;
} {
  if (typeof filters === 'string') {
    return { query: filters, archived: 'active', tags: [], limit: 100 };
  }
  return {
    query: filters.query ?? '',
    archived: filters.archived ?? 'active',
    tags: normalizeTags(filters.tags),
    limit: filters.limit ?? 100,
  };
}

function normalizeMetadataPatch<T extends { tags?: string[] }>(patch: T): T {
  if (patch.tags === undefined) return patch;
  return { ...patch, tags: normalizeTags(patch.tags) };
}

function matchesFilters(summary: ConversationSummary, filters: ConversationListFilters): boolean {
  const archivedFilter = filters.archived ?? 'active';
  if (archivedFilter === 'active' && summary.archived) return false;
  if (archivedFilter === 'archived' && !summary.archived) return false;
  const requiredTags = normalizeTags(filters.tags);
  if (requiredTags.length) {
    const summaryTags = new Set(normalizeTags(summary.tags).map(tag => tag.toLowerCase()));
    if (!requiredTags.every(tag => summaryTags.has(tag.toLowerCase()))) return false;
  }
  return true;
}
