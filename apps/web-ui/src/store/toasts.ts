import { create } from 'zustand';
import { uuid } from '@/lib/ids';

export type ToastIntent = 'success' | 'info' | 'warning' | 'danger';

export interface Toast {
  id: string;
  intent: ToastIntent;
  title: string;
  description?: string;
  /** 0 keeps it up until dismissed -- used for anything the user must read. */
  durationMs: number;
}

interface ToastStore {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION_MS = 5_000;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = uuid();
    set((state) => ({
      toasts: [
        ...state.toasts,
        { ...toast, id, durationMs: toast.durationMs ?? DEFAULT_DURATION_MS },
      ],
    }));
    return id;
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** Callable from anywhere, including non-component code such as query callbacks. */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ intent: 'success', title, description }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ intent: 'info', title, description }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ intent: 'warning', title, description }),
  danger: (title: string, description?: string) =>
    useToastStore.getState().push({ intent: 'danger', title, description }),
};
