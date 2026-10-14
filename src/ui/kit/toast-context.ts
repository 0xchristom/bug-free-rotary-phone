import { createContext, useContext } from 'react';
import type { Tone } from './tone.ts';

export interface ToastInput {
  readonly title: string;
  readonly detail?: string;
  readonly tone?: Tone;
}

export type ShowToast = (toast: ToastInput) => void;

/** Outside a ToastProvider a toast is dropped: nothing to show it in. */
export const ToastContext = createContext<ShowToast>(() => undefined);

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
