import '@/styles/layout.css';
import '@/styles/fileTree.css';
import '@/styles/chat.css';
import '@/styles/settings.css';
import '@/styles/editor.css';
import '@/styles/ui.css';
import '@/styles/conversationList.css';
import '@/styles/components.css';
import '@/styles/wizard.css';
import '@/styles/richInput.css';
import { AppLayout } from '@components/layout/AppLayout';
import { useThemeEffect } from '@/hooks/useThemeEffect';
import { useEffect, useState } from 'react';
import { FirstUseWizard } from '@/components/settings/FirstUseWizard';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setConnectionStatus } from '@/store/slices/agentSettings';
import type { RootState } from '@/store';

function App() {
  const dispatch = useAppDispatch();
  const apiKey = useAppSelector((s: RootState) => s.settings.apiKeys?.openai);
  const connectionStatus = useAppSelector((s: RootState) => s.agentSettings.connectionStatus);
  const dirtyTabCount = useAppSelector((s: RootState) => s.editorTabs.tabs.filter(tab => tab.isDirty).length);
  useThemeEffect();
  const [onboarded, setOnboarded] = useState(() => {
    return localStorage.getItem('synapse_onboarded') === 'true';
  });

  useEffect(() => {
    if (!apiKey && connectionStatus !== 'missing') {
      dispatch(setConnectionStatus('missing'));
      return;
    }
    if (apiKey && (connectionStatus === 'unknown' || connectionStatus === 'missing')) {
      dispatch(setConnectionStatus('configured'));
    }
  }, [apiKey, connectionStatus, dispatch]);

  useEffect(() => {
    if (dirtyTabCount === 0) return undefined;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '存在未保存的文件修改';
      return event.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyTabCount]);

  if (!onboarded) {
    return (
      <div className="app-frame">
        <div className="app-background" />
        <WindowTitleBar />
        <FirstUseWizard onComplete={() => {
          localStorage.setItem('synapse_onboarded', 'true');
          setOnboarded(true);
        }} />
      </div>
    );
  }

  return (
    <div className="app-frame">
      <div className="app-background" />
      <WindowTitleBar />
      <AppLayout />
    </div>
  );
}

export default App;
