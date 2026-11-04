import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { CircleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Toast, ToastDescription, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { describeTrouble, type NoticeText, type Trouble } from './notices.ts';

/**
 * The one place anything in this app says that something went wrong.
 *
 * Before this, a failed ingest left a line in a drawer nobody had open, a
 * refused play left nothing at all, and a browser that cannot write to its
 * own filesystem left a song that simply never appeared. All of them now come
 * out here: a plain first line on the stage, the technical reason under it for
 * whoever wants it, and a dismiss for everyone else.
 *
 * A context rather than props, because the places that fail are the leaves —
 * the media element, the stem loader, the writer — and threading a callback
 * down to each of them would put the error surface in the signature of every
 * component between.
 */

/** How long a notice stays before it takes itself away. */
const KEEP_MS = 8000;

interface Shown extends NoticeText {
  readonly id: number;
  /** Troubles are marked; a plain notice is not a failure. */
  readonly bad: boolean;
}

interface NoticesApi {
  /** Something a person should see, that is not a failure. */
  show(text: NoticeText): void;
  /** Something that went wrong, in whichever part of the app it went wrong in. */
  report(trouble: Trouble): void;
}

const NoticesContext = createContext<NoticesApi | null>(null);

export function NoticesProvider({ children }: { readonly children: ReactNode }) {
  const [shown, setShown] = useState<readonly Shown[]>([]);

  const dismiss = useCallback((id: number): void => {
    setShown((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const push = useCallback(
    (text: NoticeText, bad: boolean): void => {
      // The clock is the id: two notices cannot land in the same millisecond
      // from one thread, and nothing needs the ids to be consecutive.
      const id = Date.now() + Math.random();
      setShown((current) => [...current, { ...text, id, bad }]);
      setTimeout(() => {
        dismiss(id);
      }, KEEP_MS);
    },
    [dismiss],
  );

  const api = useMemo<NoticesApi>(
    () => ({
      show: (text) => {
        push(text, false);
      },
      report: (trouble) => {
        push(describeTrouble(trouble), true);
      },
    }),
    [push],
  );

  return (
    <NoticesContext.Provider value={api}>
      {children}
      <ToastViewport>
        {shown.map((notice) => (
          <Toast key={notice.id} variant={notice.bad ? 'destructive' : 'default'} role="status">
            {notice.bad && <CircleAlert className="mt-0.5" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <ToastTitle>{notice.headline}</ToastTitle>
              {notice.detail !== null && <ToastDescription>{notice.detail}</ToastDescription>}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="dismiss"
              className="-mr-1 shrink-0 text-muted-foreground"
              onClick={() => {
                dismiss(notice.id);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </Toast>
        ))}
      </ToastViewport>
    </NoticesContext.Provider>
  );
}

/**
 * The reporter, for anything inside the provider. Outside it, a no-op rather
 * than a throw: a component that reports a failure should not become a
 * failure of its own in a test that renders it alone.
 */
export function useNotices(): NoticesApi {
  const api = useContext(NoticesContext);
  return useMemo<NoticesApi>(
    () =>
      api ?? {
        show: () => undefined,
        report: () => undefined,
      },
    [api],
  );
}
