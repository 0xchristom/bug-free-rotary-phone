import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ToastInput } from './toast-context.ts';

export const TOAST_LIFE_MS = 4_200;

interface ShownToast extends ToastInput {
  readonly id: number;
}

export interface ToastProviderProps {
  /** How long a toast stays (tests use a short one). */
  readonly lifeMs?: number;
  readonly children: ReactNode;
}

/**
 * Short confirmations in the corner ("Address copied"). They leave by themselves, so nothing
 * the user must read or act on goes here: errors and warnings stay on the screen.
 */
export function ToastProvider({ lifeMs = TOAST_LIFE_MS, children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ShownToast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { ...toast, id }]);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setToasts((list) => list.filter((item) => item.id !== id));
      }, lifeMs);
      timers.current.add(timer);
    },
    [lifeMs],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="k-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="k-toast" data-tone={toast.tone ?? 'muted'}>
            <b>{toast.title}</b>
            {toast.detail !== undefined && <span>{toast.detail}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
