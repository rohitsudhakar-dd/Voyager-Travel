import type { CreateConversationResponse, SupportStreamEvent } from '@voyager/shared-schemas';
import { supportStreamEventSchema } from '@voyager/shared-schemas';
import { Headset, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { request, stream } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { errorMessage } from '@/api/errors';
import { Alert, IconButton, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useFocusTrap } from '@/lib/hooks';

const TOOL_ICONS: Record<string, string> = {
  lookup_booking: '🔍',
  get_cancellation_policy: '📋',
  initiate_cancellation: '✳️',
  get_loyalty_balance: '🎯',
  escalate_to_human: '🙋',
};

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools: { tool: string; label: string; outcome: 'pending' | 'ok' | 'error' }[];
  streaming: boolean;
}

/**
 * 04-STYLING.md § 4.9: a bottom-right launcher expanding to a 400×600 panel.
 * Tool calls are rendered as visible chips on purpose -- it makes the LLM
 * Observability trace legible to an audience before you switch tabs.
 */
export function SupportChatLauncher() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const conversationId = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useFocusTrap(panelRef, open);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [turns]);

  const ensureConversation = async (): Promise<string> => {
    if (conversationId.current) return conversationId.current;
    const response = await request<CreateConversationResponse>(endpoints.support.conversations, {
      method: 'POST',
      body: {},
    });
    conversationId.current = response.conversationId;
    return response.conversationId;
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;

    setDraft('');
    setFailure(null);
    setBusy(true);

    const assistantId = `assistant-${Date.now()}`;
    setTurns((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', content, tools: [], streaming: false },
      { id: assistantId, role: 'assistant', content: '', tools: [], streaming: true },
    ]);

    const update = (mutate: (turn: Turn) => Turn) =>
      setTurns((current) => current.map((turn) => (turn.id === assistantId ? mutate(turn) : turn)));

    const controller = new AbortController();
    abort.current = controller;

    try {
      const id = await ensureConversation();
      await stream(endpoints.support.messages(id), {
        method: 'POST',
        body: { content },
        signal: controller.signal,
        onEvent: (data) => {
          const parsed = supportStreamEventSchema.safeParse(safeJson(data));
          if (!parsed.success) return;
          applyEvent(parsed.data, update, setFailure);
        },
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setFailure(errorMessage(error));
      }
    } finally {
      update((turn) => ({ ...turn, streaming: false }));
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        data-testid="support-launcher"
        data-dd-action-name="Open support chat"
        onClick={() => setOpen((current) => !current)}
        className="fixed bottom-4 right-4 z-40 flex h-12 items-center gap-2 rounded-full bg-brand-600 px-4 text-body-md font-semibold text-white shadow-lg hover:bg-brand-700 lg:bottom-6 lg:right-6"
      >
        {open ? <X aria-hidden className="h-5 w-5" /> : <Headset aria-hidden className="h-5 w-5" />}
        {open ? 'Close' : 'Help'}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Voyager support"
          data-testid="support-panel"
          className="fixed bottom-20 right-4 z-40 flex h-[600px] max-h-[calc(100vh-7rem)] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xl animate-slide-in-bottom lg:right-6"
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <p className="text-heading-sm">Voyager support</p>
              <p className="text-caption text-fg-muted">
                Answers about bookings, changes and refunds
              </p>
            </div>
            <IconButton aria-label="Close support" size="sm" onClick={() => setOpen(false)}>
              <X aria-hidden className="h-4 w-4" />
            </IconButton>
          </header>

          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {turns.length === 0 ? (
              <p className="text-body-sm text-fg-muted">
                Ask about a booking reference, a cancellation, or your points balance. I can look
                things up while we talk.
              </p>
            ) : null}

            {turns.map((turn) => (
              <div
                key={turn.id}
                data-testid={`support-turn-${turn.role}`}
                className={cn('flex', turn.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div className="max-w-[85%] space-y-1.5">
                  {turn.tools.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {turn.tools.map((tool, index) => (
                        <li
                          key={`${tool.tool}-${index}`}
                          data-testid="support-tool-chip"
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption',
                            tool.outcome === 'error'
                              ? 'border-danger-500/30 bg-danger-50 text-danger-700'
                              : 'border-border bg-bg-sunken text-fg-muted',
                          )}
                        >
                          <span aria-hidden>{TOOL_ICONS[tool.tool] ?? '⚙️'}</span>
                          {tool.label}
                          {tool.outcome === 'pending' ? '…' : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {turn.content || turn.streaming ? (
                    <div
                      className={cn(
                        'rounded-lg px-3 py-2 text-body-sm',
                        turn.role === 'user' ? 'bg-brand-600 text-white' : 'bg-bg-sunken text-fg',
                      )}
                    >
                      {turn.content}
                      {turn.streaming ? <TypingIndicator /> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            {failure ? <Alert intent="danger">{failure}</Alert> : null}
          </div>

          <form
            className="flex items-end gap-2 border-t border-border px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Input
              label="Message"
              labelHidden
              placeholder="How can we help?"
              value={draft}
              maxLength={2000}
              containerClassName="flex-1"
              data-testid="support-input"
              onChange={(event) => setDraft(event.target.value)}
            />
            <IconButton
              type="submit"
              aria-label="Send message"
              disabled={busy || draft.trim().length === 0}
              data-testid="support-send"
              data-dd-action-name="Send support message"
            >
              <Send aria-hidden className="h-4 w-4" />
            </IconButton>
          </form>
        </div>
      ) : null}
    </>
  );
}

function applyEvent(
  event: SupportStreamEvent,
  update: (mutate: (turn: Turn) => Turn) => void,
  setFailure: (message: string) => void,
) {
  switch (event.type) {
    case 'token':
      update((turn) => ({ ...turn, content: turn.content + event.delta }));
      return;
    case 'tool_call':
      update((turn) => {
        const existing = turn.tools.findIndex((tool) => tool.tool === event.tool);
        const next = [...turn.tools];
        const chip = { tool: event.tool, label: event.label, outcome: event.outcome };
        if (existing === -1) next.push(chip);
        else next[existing] = chip;
        return { ...turn, tools: next };
      });
      return;
    case 'message':
      update((turn) => ({ ...turn, content: event.message.content, streaming: false }));
      return;
    case 'error':
      setFailure(event.message);
      return;
    case 'done':
      update((turn) => ({ ...turn, streaming: false }));
  }
}

function safeJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function TypingIndicator() {
  return (
    <span aria-hidden className="ml-1 inline-flex gap-0.5 align-middle">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1 w-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
