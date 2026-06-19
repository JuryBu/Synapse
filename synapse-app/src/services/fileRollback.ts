import type { FileDiffHunk, FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';
import { hashContent } from './fileChangeTracker';
import { fileSystem } from './fileSystem';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';
type HunkStatus = ReviewStatus | 'mixed';

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): NonNullable<FileDiffHunk['blocks']> {
  const blocks: NonNullable<FileDiffHunk['blocks']> = [];
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

function summarizeBlockStatus(hunk: FileDiffHunk): HunkStatus {
  const blocks = hunk.blocks ?? [];
  if (blocks.length === 0) return hunk.status ?? 'pending';
  if (blocks.every(block => block.status === 'accepted')) return 'accepted';
  if (blocks.every(block => block.status === 'rejected')) return 'rejected';
  if (blocks.some(block => !block.status || block.status === 'pending')) return 'pending';
  return 'mixed';
}

function normalizeHunks(diff: FileDiffSummary): Array<FileDiffHunk & { id: string; status: HunkStatus }> {
  return (diff.hunks ?? []).map((hunk, index) => ({
    ...hunk,
    id: hunk.id ?? `${diff.id}:hunk:${index}`,
    status: hunk.status ?? 'pending',
    blocks: (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunk.id ?? `${diff.id}:hunk:${index}`)).map((block, blockIndex) => ({
      ...block,
      id: block.id ?? `${hunk.id ?? `${diff.id}:hunk:${index}`}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
      status: block.status ?? (hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending'),
    })),
  }));
}

function splitLines(content = ''): string[] {
  return content.length > 0 ? content.split(/\r?\n/) : [];
}

function materializeReviewedContent(beforeContent: string, hunks: Array<FileDiffHunk & { status: HunkStatus }>): string {
  const beforeLines = splitLines(beforeContent);
  const output: string[] = [];
  let beforeCursor = 1;

  const sorted = [...hunks].sort((a, b) => (a.oldStart || a.newStart) - (b.oldStart || b.newStart));
  for (const hunk of sorted) {
    const firstOldLine = hunk.lines.find(line => line.oldLine !== undefined)?.oldLine;
    const hunkOldStart = firstOldLine ?? hunk.oldStart;
    const copyUntil = Math.max((hunkOldStart || beforeCursor) - 1, beforeCursor - 1);
    while (beforeCursor <= copyUntil && beforeCursor <= beforeLines.length) {
      output.push(beforeLines[beforeCursor - 1]);
      beforeCursor += 1;
    }

    for (const [lineIndex, line] of hunk.lines.entries()) {
      const block = hunk.blocks?.find(item => lineIndex >= item.lineStart && lineIndex <= item.lineEnd);
      const reviewStatus = block?.status ?? (hunk.status === 'mixed' ? 'pending' : hunk.status);
      if (line.type === 'context') {
        output.push(line.content);
      } else if (reviewStatus === 'rejected' && line.type === 'delete') {
        output.push(line.content);
      } else if (reviewStatus !== 'rejected' && line.type === 'add') {
        output.push(line.content);
      }
    }

    const oldNumbers = hunk.lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const maxOldLine = oldNumbers.length > 0 ? Math.max(...oldNumbers) : beforeCursor - 1;
    beforeCursor = Math.max(beforeCursor, maxOldLine + 1);
  }

  while (beforeCursor <= beforeLines.length) {
    output.push(beforeLines[beforeCursor - 1]);
    beforeCursor += 1;
  }

  return output.join('\n');
}

export async function rollbackFileDiff(diff: FileDiffSummary, snapshot?: FileSnapshot): Promise<void> {
  let currentContent = '';
  try {
    currentContent = await fileSystem.readFile(diff.path, diff.contextId);
  } catch (err) {
    if (diff.changeType === 'created') return;
    throw err;
  }

  if (
    diff.changeType === 'created' &&
    !fileSystem.hasNode(diff.path) &&
    currentContent.startsWith('// 文件内容预览:')
  ) {
    return;
  }

  if (diff.afterHash && hashContent(currentContent) !== diff.afterHash) {
    throw new Error(`文件已在 AI 修改后继续变化，已停止回退: ${diff.path}`);
  }

  if (diff.changeType === 'created') {
    await fileSystem.deleteFile(diff.path, diff.contextId);
    return;
  }

  if (!snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  await fileSystem.writeFile(diff.path, snapshot.content ?? '', diff.contextId);
}

export async function applyHunkReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  hunkId: string,
  status: ReviewStatus,
): Promise<void> {
  if (!diff.hunks || diff.hunks.length === 0) {
    throw new Error(`缺少 hunk 数据，无法局部审阅: ${diff.path}`);
  }
  if (diff.changeType === 'deleted') {
    throw new Error(`删除文件暂不支持 hunk 级审阅: ${diff.path}`);
  }
  if (diff.changeType !== 'created' && !snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  const beforeContent = diff.changeType === 'created' ? '' : (snapshot?.content ?? '');
  const currentHunks = normalizeHunks(diff);
  if (!currentHunks.some(hunk => hunk.id === hunkId)) {
    throw new Error(`找不到 hunk: ${hunkId}`);
  }

  const expectedContent = materializeReviewedContent(beforeContent, currentHunks);
  let currentContent = '';
  try {
    currentContent = await fileSystem.readFile(diff.path, diff.contextId);
  } catch (err) {
    if (diff.changeType === 'created' && expectedContent.length === 0) {
      currentContent = '';
    } else {
      throw err;
    }
  }

  if (hashContent(currentContent) !== hashContent(expectedContent)) {
    throw new Error(`文件已在 AI 修改后继续变化，已停止局部审阅: ${diff.path}`);
  }

  const nextHunks = currentHunks.map(hunk => hunk.id === hunkId
    ? {
      ...hunk,
      blocks: hunk.blocks?.map(block => {
        const currentStatus = block.status ?? 'pending';
        return currentStatus === 'pending' ? { ...block, status } : block;
      }),
    }
    : hunk);
  const normalizedNextHunks = nextHunks.map(hunk => ({ ...hunk, status: summarizeBlockStatus(hunk) }));
  const nextContent = materializeReviewedContent(beforeContent, normalizedNextHunks);
  if (diff.changeType === 'created' && nextContent.length === 0 && normalizedNextHunks.every(hunk => hunk.blocks?.every(block => block.status === 'rejected') ?? hunk.status === 'rejected')) {
    await fileSystem.deleteFile(diff.path, diff.contextId);
    return;
  }
  await fileSystem.writeFile(diff.path, nextContent, diff.contextId);
}

export async function applyDiffReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  status: ReviewStatus,
): Promise<void> {
  if (diff.changeType === 'deleted') {
    if (status === 'rejected') {
      await rollbackFileDiff(diff, snapshot);
    }
    return;
  }

  if (!diff.hunks || diff.hunks.length === 0) {
    if (status === 'rejected') {
      await rollbackFileDiff(diff, snapshot);
      return;
    }
    let currentContent = '';
    try {
      currentContent = await fileSystem.readFile(diff.path, diff.contextId);
    } catch (err) {
      if (diff.changeType === 'created') throw err;
      throw err;
    }
    if (diff.afterHash && hashContent(currentContent) !== diff.afterHash) {
      throw new Error(`文件已在 AI 修改后继续变化，已停止接受: ${diff.path}`);
    }
    return;
  }

  if (diff.changeType !== 'created' && !snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  const beforeContent = diff.changeType === 'created' ? '' : (snapshot?.content ?? '');
  const currentHunks = normalizeHunks(diff);
  const expectedContent = materializeReviewedContent(beforeContent, currentHunks);
  let currentContent = '';
  try {
    currentContent = await fileSystem.readFile(diff.path, diff.contextId);
  } catch (err) {
    if (diff.changeType === 'created' && expectedContent.length === 0) {
      currentContent = '';
    } else {
      throw err;
    }
  }

  if (hashContent(currentContent) !== hashContent(expectedContent)) {
    throw new Error(`文件已在 AI 修改后继续变化，已停止文件级审阅: ${diff.path}`);
  }

  const nextHunks = currentHunks.map(hunk => {
    const blocks = hunk.blocks?.map(block => {
      const currentStatus = block.status ?? 'pending';
      return currentStatus === 'pending' ? { ...block, status } : block;
    });
    const nextHunk = { ...hunk, blocks };
    const nextStatus = summarizeBlockStatus(nextHunk);
    return nextStatus === 'pending' ? { ...nextHunk, status } : { ...nextHunk, status: nextStatus };
  });

  const nextContent = materializeReviewedContent(beforeContent, nextHunks);
  if (diff.changeType === 'created' && nextContent.length === 0 && nextHunks.every(hunk => hunk.blocks?.every(block => block.status === 'rejected') ?? hunk.status === 'rejected')) {
    await fileSystem.deleteFile(diff.path, diff.contextId);
    return;
  }
  await fileSystem.writeFile(diff.path, nextContent, diff.contextId);
}

export async function applyBlockReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  hunkId: string,
  blockId: string,
  status: ReviewStatus,
): Promise<void> {
  if (!diff.hunks || diff.hunks.length === 0) {
    throw new Error(`缺少 hunk 数据，无法局部审阅: ${diff.path}`);
  }
  if (diff.changeType === 'deleted') {
    throw new Error(`删除文件暂不支持 inline 块级审阅: ${diff.path}`);
  }
  if (diff.changeType !== 'created' && !snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  const beforeContent = diff.changeType === 'created' ? '' : (snapshot?.content ?? '');
  const currentHunks = normalizeHunks(diff);
  const targetHunk = currentHunks.find(hunk => hunk.id === hunkId);
  const targetBlock = targetHunk?.blocks?.find(block => block.id === blockId);
  if (!targetHunk) throw new Error(`找不到 hunk: ${hunkId}`);
  if (!targetBlock) throw new Error(`找不到 inline block: ${blockId}`);

  const expectedContent = materializeReviewedContent(beforeContent, currentHunks);
  let currentContent = '';
  try {
    currentContent = await fileSystem.readFile(diff.path, diff.contextId);
  } catch (err) {
    if (diff.changeType === 'created' && expectedContent.length === 0) {
      currentContent = '';
    } else {
      throw err;
    }
  }

  if (hashContent(currentContent) !== hashContent(expectedContent)) {
    throw new Error(`文件已在 AI 修改后继续变化，已停止 inline 块级审阅: ${diff.path}`);
  }

  const nextHunks = currentHunks.map(hunk => {
    if (hunk.id !== hunkId) return hunk;
    const blocks = hunk.blocks?.map(block => block.id === blockId ? { ...block, status } : block);
    const nextHunk = { ...hunk, blocks };
    return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
  });
  const nextContent = materializeReviewedContent(beforeContent, nextHunks);
  if (diff.changeType === 'created' && nextContent.length === 0 && nextHunks.every(hunk => hunk.blocks?.every(block => block.status === 'rejected') ?? hunk.status === 'rejected')) {
    await fileSystem.deleteFile(diff.path, diff.contextId);
    return;
  }
  await fileSystem.writeFile(diff.path, nextContent, diff.contextId);
}
