/**
 * BPC Scheduler（后台预压缩调度单例）—— Plan_5 M5-BPC ★核心模块（决策①②）。
 *
 * 定位：把 record 压缩从「撞 90% 硬阈值才同步阻塞」升级为「提前在后台预生成、下一轮无缝替换注入前缀」。
 *   它【绝不借道 AgentLoop.run()】（run() 有重入闸 + isStreaming 卡死风险），而是独立单例：持有 AgentLoop 实例引用
 *   （attachLoop 注入），调其 public `bpcGenerate`（= generateAndAppend 的 'bpc' 包装），用【自己的 controller 集合】
 *   管中止（与 AgentLoop.compressControllers 隔离 → stop() 不误伤 BPC、scheduler.abort 不误伤主对话）。
 *
 * 状态承载（决策②，职责分离）：
 *   - 运行态数据（BpcSnapshot：深拷贝冻结的 compressedSegment、step/round 游标、targetReplaceStep、生成结果 recordMd）
 *     全在本类的内存字段里——大对象、纯运行态、重启即弃，【不持久化、不进 Redux】。
 *   - UI 可订阅的【枚举态 + 进度】通过 dispatch 极薄 bpc slice 投影出去（CompressionRing/StatusBar 纯订阅 slice）。
 *
 * ★ 本批（PhaseA, BPC-0~BPC-3）范围：建单例 + 内存态 + 状态机方法（evaluateWater/triggerSnapshot/runGeneration/
 *   discardCurrent/abort/restart/takeReadyPrefix）。【接线进 run() / δ 替换 / 五边界 / UI 留 BPC-4~7（本批不做）】，
 *   故这些方法已可调用、状态机自洽，但尚无外部调用点（run 不调 evaluateWater、AgentPanel 不调 attachLoop）。
 *
 * 状态机：idle → snapshotting → generating → ready →(takeReadyPrefix)→ replacing → idle
 *   异常支线：generating 失败/中止 → (δ 窗口内) retry runGeneration / (越上限) discardCurrent → idle
 *   用户/边界支线：abort → cooldown（冷却到期回 idle）；熔断 → circuit-broken（restart 回 idle）；
 *                discardCurrent（撞硬阈值/对话切换）→ idle。
 */

import { store, type RootState } from '../store';
import { setBpcUiState, resetBpcUi, type BpcUiStateEnum } from '../store/slices/bpc';
import { addNotification } from '../store/slices/notifications';
import { DEFAULT_BPC_CONFIG } from '../store/slices/agentSettings';
import type { AgentLoop } from './agentLoop';
import type { ChatMessage } from './aiClient';

/**
 * 调度状态（scheduler 内部权威态；与 bpc slice 的 BpcUiStateEnum 同枚举，slice 是其 UI 投影）。
 */
type SchedulerState = BpcUiStateEnum;

/**
 * BPC 快照（scheduler 内存，绝不进 slice / 持久化）。triggerSnapshot 瞬间锁定，generating 期间 store 照常发展不影响它。
 */
interface BpcSnapshot {
  /** 拍快照时的目标对话 id（takeReadyPrefix/evaluateWater 据此校验身份，对话切换则丢弃，防张冠李戴）。 */
  conversationId: string;
  /** 拍快照瞬间锁定的 step 游标（= identifyRounds(过滤tool的store.messages).totalSteps，值拷贝，绝不后续重算）。 */
  snapshotStepCursor: number;
  /** 拍快照瞬间锁定的 round 游标（= 同上 totalRounds）。 */
  snapshotRoundCursor: number;
  /** 被压段（深拷贝冻结，含 tool；bpcGenerate 内部自行过滤 tool / 占位化）。 */
  compressedSegment: ChatMessage[];
  /** δ 替换最晚上限 step（= snapshotStepCursor + 1 + deltaSteps）；越此仍无 ready 则放弃 BPC 转硬阻塞。 */
  targetReplaceStep: number;
  /** 拍快照时间戳（ms）。 */
  createdAt: number;
  /** ready 后填入的注入前缀（buildStableRecordPrefix 产物）；generating 期间为 null。 */
  recordMd?: string | null;
}

/** evaluateWater 入参：水位口径由调用方（BPC-4 接线处）按 run() 同款公式算好传入，scheduler 不重算（避免口径漂移）。 */
export interface BpcWaterContext {
  triggerTokens: number;
  modelContextWindow: number;
  conversationId: string;
  /** 当前 step 游标（= identifyRounds(requestHistory).totalSteps，与 snapshotStepCursor 同口径，调用方现算传入）。 */
  currentStepCursor: number;
}

class BpcScheduler {
  /** 当前在途快照（null = 无）。 */
  private snapshot: BpcSnapshot | null = null;
  /** 调度状态机权威态。 */
  private state: SchedulerState = 'idle';
  /** BPC 自己的中止器集合（与 AgentLoop.compressControllers 隔离）。 */
  private abortControllers = new Set<AbortController>();
  /** 注入的 AgentLoop 实例（attachLoop 设置；切模型/MCP refresh 重建时重新注入 + discardCurrent 在途）。 */
  private loop: AgentLoop | null = null;
  /** 在途生成 Promise（防并发重入 runGeneration）。 */
  private genPromise: Promise<void> | null = null;
  /** 冷却到期时间戳（ms）；null = 非冷却。 */
  private cooldownUntil: number | null = null;
  /** 熔断态：true 时停 BPC 直到 restart()。 */
  private circuitBroken = false;
  /** 上次成功替换时的 step 游标（熔断判据用）。 */
  private lastReplaceStepCursor: number | null = null;
  /** 连续「替换后几乎没推进就又触发」计数（达 2 次熔断）。 */
  private consecutiveImmediateRetrigger = 0;
  /** δ 窗口内自动重试次数（上限 1，防无限重试）。 */
  private retryCount = 0;

  // ---- 配置读取（全局默认 + 本对话覆盖，口径与 BPC-4 接线一致）----

  private get config() {
    const s = store.getState() as RootState;
    return s.agentSettings?.bpc ?? DEFAULT_BPC_CONFIG;
  }

  /** 生效预压触发水位 = 本对话覆盖 ?? 全局默认（number override 用 ?? 而非 ||，0 不被吞）。 */
  private effectiveBpcThreshold(): number {
    const s = store.getState() as RootState;
    const override = s.conversation?.bpcThresholdOverride;
    return typeof override === 'number' && Number.isFinite(override) ? override : this.config.bpcThreshold;
  }

  // ---- 公开只读访问器（供 UI / BPC-4 接线判断）----

  getState(): SchedulerState { return this.state; }
  isIdle(): boolean { return this.state === 'idle'; }
  isBusy(): boolean { return this.state !== 'idle'; }
  hasReadySnapshot(): boolean { return this.state === 'ready' && this.snapshot != null; }
  getCircuitBroken(): boolean { return this.circuitBroken; }

  /** 是否处于冷却期（手动中止后 abortCooldownMin 分钟内）。 */
  inCooldown(): boolean {
    if (this.cooldownUntil == null) return false;
    if (Date.now() >= this.cooldownUntil) {
      // 冷却到期：清冷却态回 idle（惰性收尾，避免依赖定时器）。
      this.cooldownUntil = null;
      if (this.state === 'cooldown') this.setState('idle', { cooldownUntil: null });
      return false;
    }
    return true;
  }

  // ---- 生命周期：AgentLoop 注入 ----

  /**
   * AgentPanel 构建 AgentLoop 后注入（BPC-4 接线，本批仅提供 API）。
   * AgentLoop 重建（切模型/MCP refresh）时：先 detach 旧 loop（discardCurrent 在途 BPC，旧 loop 已 stop），再 attach 新的。
   */
  attachLoop(loop: AgentLoop): void {
    if (this.loop && this.loop !== loop) {
      // 换了新 loop 实例 → 在途 BPC 基于旧 loop，作废。
      this.discardCurrent();
    }
    this.loop = loop;
  }

  /** AgentLoop 销毁时调（cleanup）。仅当传入的是当前持有的 loop 才解绑 + 丢在途（防并发重建误解绑新 loop）。 */
  detachLoop(loop: AgentLoop): void {
    if (this.loop === loop) {
      this.discardCurrent();
      this.loop = null;
    }
  }

  // ---- 状态机内部桥（scheduler 权威态 → bpc slice UI 投影）----

  private setState(
    next: SchedulerState,
    extra?: { progress?: number; cooldownUntil?: number | null; lastError?: string },
  ): void {
    this.state = next;
    // 只把【确实提供的】键带给 slice：cooldownUntil / lastError 仅在 extra 显式含该键时透传，
    //   让 slice 的「进 idle/ready 自动清 lastError」逻辑（依赖 'lastError' in payload 判定）正常生效。
    const payload: { state: SchedulerState; progress?: number; cooldownUntil?: number | null; lastError?: string } = { state: next };
    if (extra && typeof extra.progress === 'number') payload.progress = extra.progress;
    if (extra && 'cooldownUntil' in extra) payload.cooldownUntil = extra.cooldownUntil;
    if (extra && 'lastError' in extra) payload.lastError = extra.lastError;
    store.dispatch(setBpcUiState(payload));
  }

  // ---- 核心调度 ----

  /**
   * 水位评估（BPC-4 在 run while 循环每轮末 fire-and-forget 调用，绝不 await）。
   *   ratio >= effectiveBpcThreshold && 空闲 && 未冷却 && 未熔断 → triggerSnapshot。
   *   ★ 口径：triggerTokens/modelContextWindow 由调用方按 run() 同款公式算好传入，scheduler 不重算。
   *   ★ 熔断判据（边界⑤）：替换后 step 推进 <= circuitBreakGapSteps 又触发 → 计数，连续 2 次熔断。
   */
  evaluateWater(ctx: BpcWaterContext): void {
    if (!ctx.conversationId || ctx.modelContextWindow <= 0) return;
    if (this.circuitBroken) return;
    if (this.state !== 'idle') return;       // 已有在途/ready/replacing BPC，不重复触发
    if (this.inCooldown()) return;           // 冷却期不触发（inCooldown 内部会惰性收尾到期态）

    const ratio = ctx.triggerTokens / ctx.modelContextWindow;
    if (ratio < this.effectiveBpcThreshold()) return;

    // ★ 边界⑤ 熔断判据：上次替换后几乎没推进（step 间距 <= circuitBreakGapSteps）就又到触发线 → 立即重触发。
    if (this.lastReplaceStepCursor != null) {
      const gap = ctx.currentStepCursor - this.lastReplaceStepCursor;
      if (gap <= this.config.circuitBreakGapSteps) {
        this.consecutiveImmediateRetrigger += 1;
        if (this.consecutiveImmediateRetrigger >= 2) {
          this.tripCircuitBreaker();
          return;
        }
      } else {
        // 推进足够 → 重置立即重触发计数（正常压缩节奏）。
        this.consecutiveImmediateRetrigger = 0;
      }
    }

    this.triggerSnapshot(ctx.conversationId, ctx.currentStepCursor);
  }

  /**
   * 拍快照（state→snapshotting）：从当前 store 现算被压段 + 锁定 step/round 游标 + structuredClone 深拷贝冻结，
   *   随即进 runGeneration（state→generating）。需 loop 已 attach（拿 computeBpcSnapshotInput / bpcGenerate）。
   */
  triggerSnapshot(conversationId: string, currentStepCursor: number): void {
    if (!this.loop) {
      console.warn('[bpcScheduler] triggerSnapshot 跳过：AgentLoop 未 attach');
      return;
    }
    if (this.state !== 'idle') return;
    void currentStepCursor; // 触发判定已在 evaluateWater 完成；snapshotStepCursor 以下方现算为准（瞬间锁定）

    this.setState('snapshotting', { progress: 0.1 });
    try {
      const input = this.loop.computeBpcSnapshotInput(conversationId);
      if (input.compressedSegment.length === 0) {
        // 无可压段（对话太短）→ 直接回 idle，不留半快照。
        this.setState('idle', { progress: 0 });
        return;
      }
      const frozen = deepCloneSegment(input.compressedSegment);
      this.snapshot = {
        conversationId,
        snapshotStepCursor: input.snapshotStepCursor,
        snapshotRoundCursor: input.snapshotRoundCursor,
        compressedSegment: frozen,
        targetReplaceStep: input.snapshotStepCursor + 1 + this.config.deltaSteps,
        createdAt: Date.now(),
        recordMd: null,
      };
      this.retryCount = 0;
      void this.runGeneration();
    } catch (err) {
      console.warn('[bpcScheduler] triggerSnapshot 失败，回 idle:', err);
      this.snapshot = null;
      this.setState('idle', { progress: 0 });
    }
  }

  /**
   * 后台生成（state→generating → 成功 ready / 失败 retry 或 discard）。
   *   new controller 加进 abortControllers；await loop.bpcGenerate（复用 generateBatch 的 race 可中止链路）；
   *   成功 → snapshot.recordMd=结果，state→ready；失败/中止 → δ 窗口内 retry（上限 1）否则 discardCurrent。
   *   ★ 进度：generateBatch 不流式无中间进度 → generating 用 0.5 indeterminate，ready=1。
   */
  private async runGeneration(): Promise<void> {
    if (!this.loop || !this.snapshot) return;
    if (this.genPromise) return; // 防重入
    const snapshot = this.snapshot;
    const loop = this.loop;

    const controller = new AbortController();
    this.abortControllers.add(controller);
    this.setState('generating', { progress: 0.5 });

    const task = (async () => {
      try {
        const result = await loop.bpcGenerate(snapshot.conversationId, snapshot.compressedSegment, controller.signal);
        // 中途被丢弃（discardCurrent 把 snapshot 置 null / 换了别的快照）→ 不回写。
        if (this.snapshot !== snapshot) return;
        if (controller.signal.aborted) {
          // 被 abort：交给 finally 后的 retry/discard 判定（这里不直接转态）。
          return;
        }
        if (result.appended || result.recordMd) {
          snapshot.recordMd = result.recordMd;
          this.setState('ready', { progress: 1 });
        } else {
          // 没真落批（batchSlice 空 / generateBatch 返回 null）→ 视作本次无效，δ 窗口内重试或放弃。
          this.handleGenerationFailureOrAbort(snapshot, '生成未产出 record 批');
        }
      } catch (err) {
        if (this.snapshot === snapshot) {
          this.handleGenerationFailureOrAbort(snapshot, String((err as Error)?.message ?? err));
        }
      } finally {
        this.abortControllers.delete(controller);
        this.genPromise = null;
        // 若 task 内因 abort 提前 return（未转 ready/重试），在此按当前态兜底判定。
        if (this.snapshot === snapshot && this.state === 'generating') {
          if (controller.signal.aborted) {
            this.handleGenerationFailureOrAbort(snapshot, '后台生成被中止');
          }
        }
      }
    })();
    this.genPromise = task;
    await task;
  }

  /**
   * 生成失败 / 中止的统一处理（δ 窗口自动 retry，规范 §8.2④）：
   *   - 当前 step 仍在 δ 窗口内（currentStep < targetReplaceStep）且 retryCount < 1 → 重试 runGeneration（重新生成）。
   *   - 越过 δ 上限或重试已用尽 → discardCurrent（放弃 BPC，下次撞 90% 走硬阻塞兜底）。
   *   ★ 当前 step 用现算（与 snapshotStepCursor 同口径）；scheduler 不持有「当前 step」，从 store 现算。
   */
  private handleGenerationFailureOrAbort(snapshot: BpcSnapshot, reason: string): void {
    if (this.snapshot !== snapshot) return;
    const currentStep = this.currentStepFromStore(snapshot.conversationId);
    const withinWindow = currentStep != null && currentStep < snapshot.targetReplaceStep;
    if (withinWindow && this.retryCount < 1) {
      this.retryCount += 1;
      console.warn(`[bpcScheduler] 生成失败/中止（${reason}），δ 窗口内重试（第 ${this.retryCount} 次）`);
      // 重新生成（snapshot 不变，复用已冻结的被压段）。
      this.setState('snapshotting', { progress: 0.1 });
      void this.runGeneration();
    } else {
      console.warn(`[bpcScheduler] 生成失败/中止（${reason}），越 δ 上限或重试用尽 → 放弃 BPC`);
      this.discardCurrent(reason);
    }
  }

  /**
   * 取走 ready 的注入前缀（BPC-4 在 run 进入时调；本批仅提供 API，无调用点）。
   *   仅当 state==='ready' 且 snapshot 身份匹配当前 conversationId 才返回；返回后 state→replacing→（替换完）idle，
   *   记 lastReplaceStepCursor = currentStepCursor（熔断判据用）。替换组装/无阻塞替换在 BPC-4。
   */
  takeReadyPrefix(conversationId: string, currentStepCursor: number): { recordMd: string | null; snapshotStepCursor: number; snapshotRoundCursor: number } | null {
    if (this.state !== 'ready' || !this.snapshot) return null;
    if (this.snapshot.conversationId !== conversationId) {
      // 对话已切换 → 作废，不张冠李戴。
      this.discardCurrent('takeReadyPrefix 对话身份不匹配');
      return null;
    }
    const snap = this.snapshot;
    this.setState('replacing', { progress: 1 });
    const result = {
      recordMd: snap.recordMd ?? null,
      snapshotStepCursor: snap.snapshotStepCursor,
      snapshotRoundCursor: snap.snapshotRoundCursor,
    };
    // 替换收尾：清快照、记替换游标、回 idle。
    this.snapshot = null;
    this.lastReplaceStepCursor = currentStepCursor;
    this.setState('idle', { progress: 0 });
    return result;
  }

  /**
   * 丢弃当前在途 BPC（abort 全部 controller + 清快照 + 回 idle）。
   *   供 BPC-4 边界①②（撞硬阈值丢弃在途 BPC）、对话切换、loop 重建用。幂等。
   */
  discardCurrent(reason?: string): void {
    for (const c of this.abortControllers) c.abort();
    this.abortControllers.clear();
    this.snapshot = null;
    this.genPromise = null;
    this.retryCount = 0;
    if (reason) console.warn('[bpcScheduler] discardCurrent:', reason);
    // 冷却/熔断态不被 discard 覆盖（它们有独立收尾）；其余一律回 idle。
    if (this.state !== 'cooldown' && this.state !== 'circuit-broken') {
      this.setState('idle', { progress: 0 });
    }
  }

  /**
   * 用户手动中止（CompressionRing 的 × 按钮，BPC-6）：discardCurrent + 设冷却 abortCooldownMin 分钟，state→cooldown。
   */
  abort(): void {
    const cooldownUntil = Date.now() + this.config.abortCooldownMin * 60_000;
    // 先丢在途（此时仍是 generating/ready 等），再切冷却态（discardCurrent 不覆盖 cooldown）。
    this.snapshot = null;
    for (const c of this.abortControllers) c.abort();
    this.abortControllers.clear();
    this.genPromise = null;
    this.retryCount = 0;
    this.cooldownUntil = cooldownUntil;
    this.setState('cooldown', { progress: 0, cooldownUntil });
  }

  /**
   * 熔断后用户手动重启（CompressionRing 的「重启 BPC」按钮，BPC-5/6）：清熔断 + 冷却，回 idle。
   */
  restart(): void {
    this.circuitBroken = false;
    this.cooldownUntil = null;
    this.consecutiveImmediateRetrigger = 0;
    this.lastReplaceStepCursor = null;
    this.snapshot = null;
    for (const c of this.abortControllers) c.abort();
    this.abortControllers.clear();
    this.genPromise = null;
    this.retryCount = 0;
    store.dispatch(resetBpcUi());
    this.state = 'idle';
  }

  // ---- 熔断（边界⑤）----

  private tripCircuitBreaker(): void {
    this.circuitBroken = true;
    this.snapshot = null;
    for (const c of this.abortControllers) c.abort();
    this.abortControllers.clear();
    this.genPromise = null;
    this.setState('circuit-broken', { progress: 0, lastError: 'BPC 循环已停止' });
    store.dispatch(addNotification({
      type: 'warning',
      title: 'BPC 后台压缩已熔断',
      message: '检测到压缩后立即又触发的循环，已停止后台预压缩，请在设置中手动重启 BPC。',
      duration: 0, // 持久（不自动消失），等用户处理
    }));
  }

  // ---- 工具 ----

  /** 从当前 store 现算 step 游标（与 snapshotStepCursor 同口径）；loop 未 attach 返回 null。 */
  private currentStepFromStore(conversationId: string): number | null {
    if (!this.loop) return null;
    try {
      // 复用 computeBpcSnapshotInput 的 step 口径（它内部 identifyRounds 全量 store.messages）。
      return this.loop.computeBpcSnapshotInput(conversationId).snapshotStepCursor;
    } catch {
      return null;
    }
  }

  // ---- 测试/调试辅助（不影响生产逻辑）----

  /** ★ 仅供 fixture 自检 / 调试：返回内存态快照浅视图（不含 compressedSegment 本体，避免大对象外泄）。 */
  __debugSnapshotMeta(): {
    state: SchedulerState;
    hasSnapshot: boolean;
    snapshotStepCursor: number | null;
    targetReplaceStep: number | null;
    circuitBroken: boolean;
    cooldownUntil: number | null;
    lastReplaceStepCursor: number | null;
  } {
    return {
      state: this.state,
      hasSnapshot: this.snapshot != null,
      snapshotStepCursor: this.snapshot?.snapshotStepCursor ?? null,
      targetReplaceStep: this.snapshot?.targetReplaceStep ?? null,
      circuitBroken: this.circuitBroken,
      cooldownUntil: this.cooldownUntil,
      lastReplaceStepCursor: this.lastReplaceStepCursor,
    };
  }
}

/**
 * 深拷贝冻结被压段：优先 structuredClone（纯数据 OK，含 contentParts/attachments 的 sha256 引用态、无 base64，体积可控），
 *   不可用时回退 JSON 往返（record 源本就 placeholder 化、无函数/循环引用，JSON 往返安全）。
 */
function deepCloneSegment(segment: ChatMessage[]): ChatMessage[] {
  try {
    if (typeof structuredClone === 'function') return structuredClone(segment);
  } catch {
    // structuredClone 对极少数不可克隆值会抛 → 回退 JSON。
  }
  return JSON.parse(JSON.stringify(segment));
}

/** ★ 模块单例：footer/StatusBar/settings 三处订阅、run()/AgentPanel 接线（BPC-4+）共用同一实例。 */
export const bpcScheduler = new BpcScheduler();
