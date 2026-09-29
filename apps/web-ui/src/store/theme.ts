import { create } from 'zustand';
import { STORAGE_KEYS, readStored, writeStored } from '@/lib/storage';

export type Theme = 'light' | 'dark';

interface ThemeStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

/**
 * index.html applies the stored theme before first paint, so this store only
 * has to stay in step with the attribute it already set.
 */
function initialTheme(): Theme {
  const stored = readStored(STORAGE_KEYS.theme);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  writeStored(STORAGE_KEYS.theme, theme);
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: initialTheme(),

  setTheme: (theme) => {
    apply(theme);
    set({ theme });
  },

  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
