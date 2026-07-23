import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { tgChats, tgMessages, tgInsights, tgStatus, tgRetryBackfill, TG_STATUS_KEY } from '../lib/tgUserclient';
import { formatDate } from '../lib/format';

export default function TgDialogsPanel({ operatorId }: { operatorId: number }) {
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);

  const statusQ = useQuery({
    queryKey: TG_STATUS_KEY(operatorId),
    queryFn: () => tgStatus(operatorId).then(r => r.data),
    refetchInterval: (query) => {
      const job = query.state.data?.latest_backfill_job;
      return job?.status === 'running' || job?.status === 'pending' ? 3000 : false;
    },
  });

  const retryMut = useMutation({
    mutationFn: () => tgRetryBackfill({ operator_id: operatorId }),
    onSuccess: () => {
      statusQ.refetch();
    },
  });

  const chatsQ = useQuery({
    queryKey: ['tg-chats', operatorId],
    queryFn: () => tgChats(operatorId).then(r => r.data),
  });

  const messagesQ = useQuery({
    queryKey: ['tg-messages', selectedChatId],
    queryFn: () => tgMessages(selectedChatId!).then(r => r.data),
    enabled: !!selectedChatId,
  });

  const insightsQ = useQuery({
    queryKey: ['tg-insights', selectedChatId],
    queryFn: () => tgInsights({ chat: selectedChatId! }).then(r => r.data),
    enabled: !!selectedChatId,
  });

  const insight = insightsQ.data?.[0];
  const backfillJob = statusQ.data?.latest_backfill_job;

  return (
    <div className="flex flex-col">
      {backfillJob && (
        <div className="px-4 py-2 text-xs border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
          {backfillJob.status === 'running' && (
            <span className="text-amber-600 dark:text-amber-400 font-medium">
              ⏳ Загружаем историю… чатов пройдено: {backfillJob.chats_scanned}, сообщений сохранено: {backfillJob.messages_saved}
            </span>
          )}
          {backfillJob.status === 'pending' && (
            <span className="text-amber-600 dark:text-amber-400 font-medium">
              ⏳ В очереди на загрузку истории переписок…
            </span>
          )}
          {backfillJob.status === 'done' && (
            <span className="text-emerald-600 dark:text-emerald-400">
              ✓ История загружена (чатов: {backfillJob.chats_scanned}, сообщений: {backfillJob.messages_saved})
            </span>
          )}
          {backfillJob.status === 'error' && (
            <div className="flex items-center gap-2 w-full justify-between">
              <span className="text-red-500 font-medium truncate">
                ⚠ Ошибка загрузки истории: {backfillJob.last_error}
              </span>
              <button
                className="btn-ghost text-xs text-blue-600 px-2 py-0.5"
                onClick={() => retryMut.mutate()}
                disabled={retryMut.isPending}
              >
                Повторить
              </button>
            </div>
          )}
        </div>
      )}
      <div className="flex h-[600px]">
      <div className="w-1/3 border-r border-gray-200 dark:border-slate-800 overflow-y-auto">
        {chatsQ.isLoading && <div className="p-4 text-gray-500">Загрузка чатов...</div>}
        {chatsQ.data?.length === 0 && <div className="p-4 text-gray-500">Нет чатов</div>}
        {chatsQ.data?.map(chat => (
          <div
            key={chat.id}
            onClick={() => setSelectedChatId(chat.id)}
            className={`p-3 border-b border-gray-100 dark:border-slate-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors ${selectedChatId === chat.id ? 'bg-blue-50 dark:bg-slate-800' : ''}`}
          >
            <div className="font-medium truncate">{chat.partner_name || chat.title || 'Чат'}</div>
            <div className="text-xs text-gray-500 mt-1">
              {formatDate(chat.last_message_at)}
            </div>
          </div>
        ))}
      </div>
      <div className="w-2/3 flex flex-col bg-gray-50 dark:bg-slate-900/50">
        {!selectedChatId ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">Выберите чат слева</div>
        ) : (
          <>
            {insight && (
              <div className="p-4 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 shadow-sm z-10">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-sm">AI Анализ</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${(insight.quality_score ?? 0) >= 80 ? 'bg-emerald-100 text-emerald-800' : (insight.quality_score ?? 0) >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
                    {insight.quality_score ?? 0}/100
                  </span>
                </div>
                <div className="text-sm text-gray-700 dark:text-slate-300 mb-2">{insight.summary}</div>
                {insight.red_flags?.length > 0 && (
                  <div className="mb-1">
                    <span className="text-xs font-semibold text-red-600">Риски:</span>
                    <ul className="list-disc list-inside text-xs text-red-600">
                      {insight.red_flags.map((rf, i) => <li key={i}>{rf}</li>)}
                    </ul>
                  </div>
                )}
                {insight.highlights?.length > 0 && (
                  <div>
                    <span className="text-xs font-semibold text-emerald-600">Плюсы:</span>
                    <ul className="list-disc list-inside text-xs text-emerald-600">
                      {insight.highlights.map((hl, i) => <li key={i}>{hl}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messagesQ.isLoading && <div className="text-center text-gray-500">Загрузка сообщений...</div>}
              {messagesQ.data?.slice().reverse().map(msg => (
                <div key={msg.id} className={`flex ${msg.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${msg.direction === 'out' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 border border-gray-200 dark:border-slate-700'}`}>
                    <div>{msg.text || (msg.kind === 'voice' ? `Голосовое сообщение (${msg.voice_duration_sec} сек)` : 'Вложение')}</div>
                    <div className={`text-[10px] mt-1 text-right ${msg.direction === 'out' ? 'text-blue-200' : 'text-gray-400'}`}>
                      {new Date(msg.sent_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
