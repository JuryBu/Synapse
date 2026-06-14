import type { FileDiffHunk, FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';

export interface TrackedFileChange {
  snapshot: FileSnapshot;
  diff: FileDiffSummary;
}

const pendingChanges: TrackedFileChange[] = [];

export function generateChangeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hashContent(content = ''): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function buildLineOps(before = '', after = '') {
  const beforeLines = before.length > 0 ? before.split(/\r?\n/) : [];
  const afterLines = after.length > 0 ? after.split(/\r?\n/) : [];
  const dp = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      dp[i][j] = beforeLines[i] === afterLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Array<{ type: 'context' | 'add' | 'delete'; content: string; oldLine?: number; newLine?: number }> = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      ops.push({ type: 'context', content: beforeLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < afterLines.length && (i === beforeLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'add', content: afterLines[j], newLine: j + 1 });
      j++;
    } else if (i < beforeLines.length) {
      ops.push({ type: 'delete', content: beforeLines[i], oldLine: i + 1 });
      i++;
    }
  }

  return { beforeLines, afterLines, ops, unchanged: dp[0][0] };
}

export function countLineChanges(before = '', after = ''): { additions: number; deletions: number } {
  const { beforeLines, afterLines, unchanged } = buildLineOps(before, after);
  return {
    additions: Math.max(afterLines.length - unchanged, 0),
    deletions: Math.max(beforeLines.length - unchanged, 0),
  };
}

export function buildDiffHunks(before = '', after = '', context = 3): FileDiffHunk[] {
  const { ops } = buildLineOps(before, after);
  const hunks: FileDiffHunk[] = [];
  let index = 0;

  const buildInlineBlocks = (hunkId: string, lines: FileDiffHunk['lines']) => {
    const blocks: NonNullable<FileDiffHunk['blocks']> = [];
    let startIndex: number | null = null;
    const flush = (endIndex: number) => {
      if (startIndex === null) return;
      const blockLines = lines.slice(startIndex, endIndex + 1);
      const oldNumbers = blockLines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
      const newNumbers = blockLines.map(line => line.newLine).filter((line): line is number => line !== undefined);
      blocks.push({
        id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
        status: 'pending',
        oldStart: oldNumbers[0] ?? 0,
        newStart: newNumbers[0] ?? 0,
        oldLines: oldNumbers.length,
        newLines: newNumbers.length,
        lineStart: startIndex,
        lineEnd: endIndex,
        lines: blockLines,
      });
      startIndex = null;
    };

    lines.forEach((line, lineIndex) => {
      if (line.type === 'context') {
        flush(lineIndex - 1);
        return;
      }
      if (startIndex === null) startIndex = lineIndex;
    });
    flush(lines.length - 1);
    return blocks;
  };

  while (index < ops.length) {
    const relativeChange = ops.slice(index).findIndex(op => op.type !== 'context');
    if (relativeChange === -1) break;
    const changeIndex = index + relativeChange;
    const start = Math.max(changeIndex - context, 0);
    let end = changeIndex;
    let trailingContext = 0;

    while (end < ops.length) {
      if (ops[end].type === 'context') {
        trailingContext++;
        if (trailingContext > context) break;
      } else {
        trailingContext = 0;
      }
      end++;
    }

    const lines = ops.slice(start, end);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    const hunkId = `hunk_${hunks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`;
    hunks.push({
      id: hunkId,
      status: 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      blocks: buildInlineBlocks(hunkId, lines),
      lines,
    });
    index = end;
  }

  return hunks;
}

export function recordTrackedFileChange(change: TrackedFileChange): void {
  pendingChanges.push(change);
}

export function consumeTrackedFileChanges(): TrackedFileChange[] {
  return pendingChanges.splice(0, pendingChanges.length);
}
