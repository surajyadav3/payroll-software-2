import { lazy, Suspense } from 'react';

/**
 * Route entry points for the screens ported from the new CrewCore platform. Everything is
 * loaded on demand, so the rest of the app does not carry this code (or its stylesheet) until
 * someone opens Work, Messages or Performance.
 */
const CrewRoot = lazy(() => import('./CrewRoot'));

export const WorkPage = lazy(() => import('./pages/work/WorkPage').then((m) => ({ default: m.WorkPage })));
export const MyWorkPage = lazy(() => import('./pages/work/MyWorkPage').then((m) => ({ default: m.MyWorkPage })));
export const ProjectPage = lazy(() => import('./pages/work/ProjectPage').then((m) => ({ default: m.ProjectPage })));
export const ChatPage = lazy(() => import('./pages/work/ChatPage').then((m) => ({ default: m.ChatPage })));
export const MentionsPage = lazy(() => import('./pages/work/MentionsPage').then((m) => ({ default: m.MentionsPage })));
export const PerformancePage = lazy(() => import('./pages/performance/PerformancePage').then((m) => ({ default: m.PerformancePage })));

const loading = (
  <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>
);

/** The frame (header, data cache, toasts, scoped styles) for a group of ported routes. */
export function CrewShell(props) {
  return <Suspense fallback={loading}><CrewRoot {...props} /></Suspense>;
}
