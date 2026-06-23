import { Check, RotateCcw } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { FileDiffBlock, FileDiffHunk, FileDiffSummary } from '@/store/slices/conversation';
import { fileSystem } from '@/services/fileSystem';

interface ReviewChangesViewProps {
  diffs: FileDiffSummary[];
  snapshots: Record<string, { id: string; path: string; content?: string }>;
  onAccept: (diffId: string) => void | Promise<void>;
  onReject: (diffId: string) => void | Promise<void>;
  onAcceptHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onRejectHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onAcceptBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
  onRejectBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
}

// ★ 中文化：文件变更类型标签
function changeLabel(type: FileDiffSummary['changeType']) {
  if (type === 'created') return '新建';
  if (type === 'deleted') return '已删除';
  return '已编辑';
}

// ★ 中文化：审阅状态标签（文件 / hunk / block 通用）
function statusLabel(status: string) {
  if (status === 'accepted') return '已接受';
  if (status === 'rejected') return '已拒绝';
  if (status === 'mixed') return '部分处理';
  return '待处理';
}

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): FileDiffBlock[] {
  const blocks: FileDiffBlock[] = [];
  let startIndex: number | null = null;
  const flush = (endIndex: number) => {
    if (startIndex === null) return;
    const lines = hunk.lines.slice(startIndex, endIndex + 1);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    blocks.push({
      id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
      status: hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      lineStart: startIndex,
      lineEnd: endIndex,
      lines,
    });
    startIndex = null;
  };

  hunk.lines.forEach((line, index) => {
    if (line.type === 'context') {
      flush(index - 1);
      return;
    }
    if (startIndex === null) startIndex = index;
  });
  flush(hunk.lines.length - 1);
  return blocks;
}

export function ReviewChangesView({
  diffs,
  snapshots,
  onAccept,
  onReject,
  onAcceptHunk,
  onRejectHunk,
  onAcceptBlock,
  onRejectBlock,
}: ReviewChangesViewProps) {
  const pendingDiffs = diffs.filter(d => d.status === 'pending');
  const [collapsedHunks, setCollapsedHunks] = useState<Record<string, boolean>>({});

  const runBatch = (action: 'accept' | 'reject') => {
    void (async () => {
      for (const diff of pendingDiffs) {
        if (action === 'accept') {
          await onAccept(diff.id);
        } else {
          await onReject(diff.id);
        }
      }
    })();
  };

  return (
    <div className="review-changes-view">
      <div className="review-header">
        <div>
          <h2>审查更改</h2>
          <p>共 {diffs.length} 个文件有改动{pendingDiffs.length > 0 ? `，${pendingDiffs.length} 个待处理` : ''}</p>
        </div>
        <div className="review-header-actions">
          <button disabled={pendingDiffs.length === 0} onClick={() => runBatch('reject')}>
            全部拒绝
          </button>
          <button disabled={pendingDiffs.length === 0} className="primary" onClick={() => runBatch('accept')}>
            全部接受
          </button>
        </div>
      </div>

      <div className="review-file-list">
        {diffs.length === 0 ? (
          <div className="review-empty">暂无可审阅的文件变更</div>
        ) : diffs.map(diff => {
          const snapshot = diff.snapshotId ? snapshots[diff.snapshotId] : undefined;
          return (
            <div key={diff.id} className={`review-file-card status-${diff.status}`}>
              <div className="review-file-title">
                <span className="review-file-icon">{fileSystem.getFileIcon(diff.path.split('.').pop())}</span>
                <div>
                  <strong>{diff.path.split(/[\\/]/).pop()}</strong>
                  <span>{diff.path}</span>
                </div>
                <span className={`review-change-kind kind-${diff.changeType}`}>{changeLabel(diff.changeType)}</span>
                {/* ★ +N/-N 突出徽标：加大字号 + 高对比红绿底，对齐 IDE diff 标题处 */}
                <span className="review-lines-badge">
                  <span className="review-lines added">+{diff.additions}</span>
                  <span className="review-lines removed">-{diff.deletions}</span>
                </span>
              </div>
              <div className="review-file-actions">
                <span className={`review-status status-${diff.status}`}>{statusLabel(diff.status)}</span>
                {diff.status === 'pending' && (
                  <>
                    <button onClick={() => onReject(diff.id)}>
                      <RotateCcw size={14} />
                      拒绝
                    </button>
                    <button className="primary" onClick={() => onAccept(diff.id)}>
                      <Check size={14} />
                      接受
                    </button>
                  </>
                )}
              </div>
              {snapshot && (
                <div className="review-snapshot-note">
                  快照已就绪：{snapshot.id}
                </div>
              )}
              {diff.hunks && diff.hunks.length > 0 && (
                <div className="review-diff-preview">
                  {diff.hunks.map((hunk, hunkIndex) => {
                    const hunkId = hunk.id ?? `${diff.id}:hunk:${hunkIndex}`;
                    const hunkStatus = hunk.status ?? 'pending';
                    const collapsed = !!collapsedHunks[hunkId];
                    const blocks = (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunkId)).map((block, blockIndex) => ({
                      ...block,
                      id: block.id ?? `${hunkId}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
                      status: block.status ?? 'pending',
                    }));
                    const blockByLineStart = new Map(blocks.map(block => [block.lineStart, block]));
                    return (
                    <div className="review-diff-hunk" key={`${diff.id}-${hunkIndex}`}>
                      <div className="review-diff-header">
                        <span>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
                        <div className="review-hunk-actions">
                          <span className={`review-hunk-status status-${hunkStatus}`}>{statusLabel(hunkStatus)}</span>
                          <button onClick={() => setCollapsedHunks(current => ({ ...current, [hunkId]: !collapsed }))}>
                            {collapsed ? '展开此块' : '折叠此块'}
                          </button>
                          {hunkStatus === 'pending' && (
                            <>
                              <button onClick={() => onRejectHunk?.(diff.id, hunkId)}>
                                <RotateCcw size={13} />
                                拒绝此块
                              </button>
                              <button className="primary" onClick={() => onAcceptHunk?.(diff.id, hunkId)}>
                                <Check size={13} />
                                接受此块
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {!collapsed && hunk.lines.map((line, lineIndex) => {
                        const block = blockByLineStart.get(lineIndex);
                        const blockStatus = block?.status ?? 'pending';
                        return (
                          <Fragment key={lineIndex}>
                            {block && (
                              <div className="review-inline-block-bar">
                                <span>
                                  段 -{block.oldStart || 0},{block.oldLines} +{block.newStart || 0},{block.newLines}
                                </span>
                                <div className="review-hunk-actions">
                                  <span className={`review-hunk-status status-${blockStatus}`}>{statusLabel(blockStatus)}</span>
                                  {blockStatus === 'pending' && (
                                    <>
                                      <button onClick={() => onRejectBlock?.(diff.id, hunkId, block.id!)}>
                                        <RotateCcw size={13} />
                                        拒绝此段
                                      </button>
                                      <button className="primary" onClick={() => onAcceptBlock?.(diff.id, hunkId, block.id!)}>
                                        <Check size={13} />
                                        接受此段
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            )}
                            {/* ★ IDE 风格行号：旧行号 + 新行号双列，删除行无新号、新增行无旧号 */}
                            <div className={`review-diff-line ${line.type}`}>
                              <span className="review-line-no review-line-no-old">{line.oldLine ?? ''}</span>
                              <span className="review-line-no review-line-no-new">{line.newLine ?? ''}</span>
                              <span className="review-diff-sign">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
                              <code>{line.content || ' '}</code>
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )})}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
