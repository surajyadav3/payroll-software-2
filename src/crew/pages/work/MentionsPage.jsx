import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, AtSign, Hash } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RichText } from '@/crew/components/work/Composer';
import { Avatar, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/crew/components/ui';
import { api } from '@/crew/lib/api';
import { timeAgo } from '@/crew/lib/notifications';
/** Every message that @mentions me, newest first; click to jump into the conversation. */
export function MentionsPage() {
    const list = useQuery({ queryKey: ['work', 'mentions'], queryFn: () => api('/work/messages/mentions', { query: { limit: 100 } }).then((r) => r.data), refetchInterval: 30_000 });
    const navigate = useNavigate();
    const [now] = useState(() => Date.now());
    return (<div>
      <Link to="/work/chat" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4"/> Messages</Link>
      <PageHeader eyebrow="Work" title="Mentions" subtitle="Messages where someone @mentioned you."/>
      {list.error ? <ErrorState error={list.error} retry={() => list.refetch()}/> : list.isLoading ? <Skeleton className="h-40"/> : !(list.data ?? []).length ? (<Card><EmptyState icon={<AtSign className="size-6"/>} title="No mentions yet" body="When someone writes @ and your name in a channel or task, it shows up here."/></Card>) : (<Card className="divide-y divide-border">
          {(list.data ?? []).map((m) => (<button key={m.id} onClick={() => navigate(`/work/chat?c=${m.channelId}&m=${m.threadRootId ?? m.id}`)} className="flex w-full gap-3 px-5 py-4 text-left hover:bg-bg-subtle">
              <Avatar name={m.author?.name ?? '?'}/>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  <span className="font-semibold text-fg">{m.author?.name}</span>
                  <span className="flex items-center gap-0.5">{m.channelName ? <><Hash className="size-3"/>{m.channelName}</> : 'direct message'}</span>
                  <span>{timeAgo(m.createdAt, now)}</span>
                </div>
                <div className="mt-0.5 line-clamp-3 text-sm text-fg"><RichText body={m.body} mentioned={m.mentioned}/></div>
              </div>
            </button>))}
        </Card>)}
    </div>);
}
