import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 16,
          background: '#0a0a0f', color: '#e0e0e0', fontFamily: 'Inter, sans-serif',
        }}>
          <span style={{ fontSize: 48 }}>⚠️</span>
          <h2 style={{ margin: 0 }}>应用出现错误</h2>
          <p style={{ color: '#888', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 24px', borderRadius: 8, border: 'none',
              background: '#7c3aed', color: 'white', cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
