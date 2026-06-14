import type { EditorTab } from '@/store/slices/editorTabs';
import { fileSystem } from '@/services/fileSystem';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

function promptUnsavedChoice(tab: EditorTab, actionLabel: string): UnsavedChoice {
  const answer = window.prompt(
    `文件 "${tab.fileName}" 有未保存修改。\n${actionLabel}前请输入：s 保存 / d 放弃 / c 取消`,
    's',
  );
  const normalized = answer?.trim().toLowerCase();
  if (normalized === 's' || normalized === 'save' || normalized === '保存') return 'save';
  if (normalized === 'd' || normalized === 'discard' || normalized === '放弃') return 'discard';
  return 'cancel';
}

export async function resolveUnsavedTabs(
  tabs: EditorTab[],
  actionLabel = '继续操作',
): Promise<boolean> {
  const dirtyTabs = tabs.filter(tab => tab.isDirty);
  for (const tab of dirtyTabs) {
    const choice = promptUnsavedChoice(tab, actionLabel);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      if (!tab.filePath || tab.content === undefined) {
        window.alert(`无法保存 "${tab.fileName}"：缺少可保存的文件内容。`);
        return false;
      }
      try {
        await fileSystem.writeFile(tab.filePath, tab.content);
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        window.alert(`保存 "${tab.fileName}" 失败：${message}`);
        return false;
      }
    }
  }
  return true;
}
