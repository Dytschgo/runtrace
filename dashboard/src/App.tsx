import { Component, lazy, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Shell } from './components/Shell';
import { ErrorState, Skeleton } from './components/ui';
import { useUrl, type PageName } from './lib/url';
// The page everyone opens comes with the app, so its data is asked for without waiting for another file first.
import Overview from './pages/Overview';

const pages: Record<PageName, ComponentType> = {
  Overview,
  Activity: lazy(() => import('./pages/ActivityPage')),
  Models: lazy(() => import('./pages/Models')),
  Projects: lazy(() => import('./pages/Projects')),
  Threads: lazy(() => import('./pages/Threads')),
  'Agent Trees': lazy(() => import('./pages/AgentTrees')),
  'Tool Calls': lazy(() => import('./pages/ToolCalls')),
  'Quota and Resets': lazy(() => import('./pages/Quota')),
  Storage: lazy(() => import('./pages/Storage')),
  'Data Quality': lazy(() => import('./pages/DataQuality')),
  Settings: lazy(() => import('./pages/Settings')),
  Search: lazy(() => import('./pages/SearchPage')),
};

/** Keeps a render failure in one page from blanking the shell and its navigation. */
class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string; error: Error | null }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    if (this.state.error) return <ErrorState error={new Error(`This page could not render: ${this.state.error.message}`)} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

export function App() {
  const { page } = useUrl();
  const Page = pages[page];
  return (
    <PageBoundary resetKey={`shell-${page}`}>
      <Shell>
        <PageBoundary resetKey={page}>
          <Suspense fallback={<Skeleton height="24rem" label={`Loading ${page}`} />}>
            <Page />
          </Suspense>
        </PageBoundary>
      </Shell>
    </PageBoundary>
  );
}
