import forms from '@tailwindcss/forms';
import type { Config } from 'tailwindcss';

/**
 * Every colour resolves to a CSS custom property declared in
 * src/styles/tokens.css, so `[data-theme="dark"]` and `[data-theme="ops"]`
 * swap the whole palette without a single class change (04-STYLING.md § 9).
 */
const scale = (name: string, steps: number[]) =>
  Object.fromEntries(steps.map((step) => [step, `var(--v-${name}-${step})`]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: scale('brand', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        accent: scale('accent', [50, 100, 300, 500, 600, 700]),
        neutral: {
          0: 'var(--v-neutral-0)',
          ...scale('neutral', [25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        },
        success: scale('success', [50, 500, 700]),
        warning: scale('warning', [50, 500, 700]),
        danger: scale('danger', [50, 500, 700]),
        info: scale('info', [50, 500, 700]),
        bg: 'var(--v-bg)',
        'bg-elevated': 'var(--v-bg-elevated)',
        'bg-sunken': 'var(--v-bg-sunken)',
        border: 'var(--v-border)',
        'border-strong': 'var(--v-border-strong)',
        fg: 'var(--v-text)',
        'fg-muted': 'var(--v-text-muted)',
        'fg-inverse': 'var(--v-text-inverse)',
      },
      fontFamily: {
        sans: ['"Inter var"', 'Inter', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-lg': ['2.75rem', { lineHeight: '3.25rem', fontWeight: '700' }],
        'display-sm': ['2rem', { lineHeight: '2.5rem', fontWeight: '700' }],
        'heading-lg': ['1.5rem', { lineHeight: '2rem', fontWeight: '600' }],
        'heading-md': ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        'heading-sm': ['1rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        'body-lg': ['1rem', { lineHeight: '1.5rem', fontWeight: '400' }],
        'body-md': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '400' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.125rem', fontWeight: '400' }],
        caption: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
        'price-lg': ['1.75rem', { lineHeight: '2.125rem', fontWeight: '700' }],
        'price-md': ['1.25rem', { lineHeight: '1.625rem', fontWeight: '700' }],
        'mono-sm': ['0.8125rem', { lineHeight: '1.125rem', fontWeight: '500' }],
      },
      borderRadius: {
        sm: 'var(--v-radius-sm)',
        md: 'var(--v-radius-md)',
        lg: 'var(--v-radius-lg)',
        xl: 'var(--v-radius-xl)',
        full: 'var(--v-radius-full)',
      },
      boxShadow: {
        xs: 'var(--v-shadow-xs)',
        sm: 'var(--v-shadow-sm)',
        md: 'var(--v-shadow-md)',
        lg: 'var(--v-shadow-lg)',
        xl: 'var(--v-shadow-xl)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--v-ease)',
        out: 'var(--v-ease-out)',
      },
      transitionDuration: {
        fast: 'var(--v-dur-fast)',
        normal: 'var(--v-dur-normal)',
        slow: 'var(--v-dur-slow)',
      },
      maxWidth: { content: '1200px' },
      gridTemplateColumns: { results: '280px 1fr' },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-in-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in var(--v-dur-normal) var(--v-ease-out)',
        'slide-up': 'slide-up var(--v-dur-normal) var(--v-ease-out)',
        'slide-in-right': 'slide-in-right var(--v-dur-slow) var(--v-ease-out)',
        'slide-in-bottom': 'slide-in-bottom var(--v-dur-slow) var(--v-ease-out)',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [forms],
} satisfies Config;
