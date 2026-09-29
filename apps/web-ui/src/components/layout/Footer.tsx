import { Link } from 'react-router-dom';
import { env } from '@/lib/env';
import { Logo } from './Logo';

const COLUMNS = [
  {
    heading: 'Book',
    links: [
      { to: '/search/flights', label: 'Flights' },
      { to: '/search/hotels', label: 'Hotels' },
      { to: '/manage', label: 'Manage a booking' },
    ],
  },
  {
    heading: 'Voyager',
    links: [
      { to: '/account', label: 'Account and trips' },
      { to: '/login', label: 'Sign in' },
      { to: '/signup', label: 'Join Voyager Rewards' },
    ],
  },
  {
    heading: 'Help',
    links: [
      { to: '/manage', label: 'Change or cancel' },
      { to: '/manage', label: 'Baggage allowance' },
      { to: '/manage', label: 'Contact support' },
    ],
  },
];

/**
 * The build badge is a genuinely useful demo prop: it ties what is on screen to
 * a deployment marker, so "which version am I looking at" is never a question.
 */
export function Footer() {
  return (
    <footer className="mt-16 border-t border-border bg-bg-elevated">
      <div className="mx-auto max-w-content px-4 py-10 lg:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo className="text-fg" />
            <p className="mt-3 max-w-xs text-body-sm text-fg-muted">
              Flights and hotels, booked in one place. Every airline, hotel and payment provider in
              Voyager is invented.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-heading-sm text-fg">{column.heading}</h2>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={`${column.heading}-${link.label}`}>
                    <Link to={link.to} className="text-body-md text-fg-muted hover:text-fg">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
          <p className="text-body-sm text-fg-muted">
            A demo environment. No real payments are processed and no real personal data is stored.
          </p>
          <p
            data-testid="build-badge"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-sunken px-2.5 py-1 font-mono text-mono-sm text-fg-muted"
          >
            <span>{env.ddEnv}</span>
            <span aria-hidden>·</span>
            <span>{env.version}</span>
            {env.commitSha ? (
              <>
                <span aria-hidden>·</span>
                <span>{env.commitSha}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </footer>
  );
}
