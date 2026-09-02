import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT:  'var(--bg)',
          muted:    'var(--bg-muted)',
          elevated: 'var(--bg-elevated)',
          hover:    'var(--bg-hover)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          muted:   'var(--fg-muted)',
          subtle:  'var(--fg-subtle)',
        },
        border: {
          DEFAULT: 'var(--border)',
          muted:   'var(--border-muted)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          fg:      'var(--accent-fg)',
          muted:   'var(--accent-muted)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger:  'var(--danger)',
        info:    'var(--info)',
      },
      fontFamily: {
        sans:  ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono:  ['var(--font-mono)'],
      },
      spacing: {
        '1':  '4px',
        '2':  '8px',
        '3':  '12px',
        '4':  '16px',
        '6':  '24px',
        '8':  '32px',
        '12': '48px',
        '16': '64px',
        '24': '96px',
      },
      borderRadius: {
        sm:      'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg:      'var(--radius-lg)',
        full:    'var(--radius-full)',
      },
      boxShadow: {
        resting:  'var(--shadow-resting)',
        floating: 'var(--shadow-floating)',
        modal:    'var(--shadow-modal)',
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '1.4', letterSpacing: '0.01em' }],
        xs:    ['12px', { lineHeight: '1.4', letterSpacing: '0.01em' }],
        sm:    ['13px', { lineHeight: '1.5' }],
        base:  ['14px', { lineHeight: '1.5' }],
        md:    ['15px', { lineHeight: '1.4' }],
        lg:    ['16px', { lineHeight: '1.5' }],
        xl:    ['18px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        '2xl': ['24px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
      },
      maxWidth: {
        content: '1280px',
        reading: '640px',
      },
      height: {
        row:         '36px',
        'row-touch': '44px',
      },
    },
  },
  plugins: [],
}

export default config
