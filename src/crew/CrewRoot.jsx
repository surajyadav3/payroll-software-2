import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Header from '@/components/Header';
import { Skeleton, ToastProvider, cx } from '@/crew/components/ui';
import { useAuth } from '@/crew/lib/auth';
import { clearAllDrafts } from '@/crew/lib/draft-store';
import './crew.css';

/**
 * The frame around every screen ported from the new CrewCore platform (Work, Messages,
 * Performance): the app's usual header (search, notifications), then the screen inside the
 * `.ccw` wrapper its styles are scoped to (crew.css), with its data cache and toasts.
 *
 * Usage (App.jsx): <Route element={<CrewRoot title="Work" />}> … </Route>. `fullBleed` is for a
 * screen that fills the whole content area below the header (Messages).
 */
const OPTIONS = {
    defaultOptions: {
        queries: {
            // Request-lean: nothing refetches on a timer; a screen refetches when it is opened
            // again after 30 s, when the window regains focus, or when a change invalidates it.
            staleTime: 30_000,
            retry: (failures, error) => failures < 2 && !(error?.status >= 400 && error?.status < 500),
            refetchOnWindowFocus: true,
        },
    },
};

// One cache per signed-in account, shared by every CrewRoot on the page. When someone else signs
// in on this browser, the previous account's data is dropped.
let current = { account: undefined, client: null };
function clientFor(account) {
    if (!current.client || current.account !== account) {
        current.client?.clear();
        current = { account, client: new QueryClient(OPTIONS) };
    }
    return current.client;
}

export default function CrewRoot({ title, breadcrumb, fullBleed = false, children }) {
    const { me } = useAuth();
    const account = me ? `${me.user.id}:${me.tenant.id}` : null;
    useEffect(() => {
        if (!account) clearAllDrafts();
    }, [account]);
    return (
        <QueryClientProvider client={clientFor(account)}>
            <div style={fullBleed ? { height: '100dvh', display: 'flex', flexDirection: 'column' } : undefined}>
                <Header title={title} breadcrumb={breadcrumb} />
                {/* .ccw scopes the styles (crew.css): utilities work inside it, not on it. */}
                <div className="ccw" style={fullBleed ? { flex: 1, minHeight: 0 } : undefined}>
                    <ToastProvider>
                        <div className={cx('bg-bg', fullBleed ? 'h-full overflow-hidden' : 'min-h-[calc(100dvh-var(--header-h))]')}>
                            <div className={fullBleed ? 'h-full' : 'mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8'}>
                                <Suspense fallback={<Skeleton className="h-64" />}>{children ?? <Outlet />}</Suspense>
                            </div>
                        </div>
                    </ToastProvider>
                </div>
            </div>
        </QueryClientProvider>
    );
}
