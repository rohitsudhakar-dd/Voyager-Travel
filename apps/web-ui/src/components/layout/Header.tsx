import { LogOut, Menu, Moon, Plane, Sun, User as UserIcon, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Badge, Button, IconButton } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';
import { useScrolled } from '@/lib/hooks';
import { useThemeStore } from '@/store/theme';
import { Logo } from './Logo';

const PRODUCT_TABS = [
  { to: '/search/flights', label: 'Flights', testId: 'nav-flights' },
  { to: '/search/hotels', label: 'Hotels', testId: 'nav-hotels' },
];

/** 64 px, sticky, and it grows a shadow once the page scrolls. */
export function Header() {
  const scrolled = useScrolled();
  const { user, logout } = useAuth();
  const { theme, toggle } = useThemeStore();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const signOut = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/');
  };

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b border-border bg-bg-elevated transition-shadow duration-fast',
        scrolled && 'shadow-xs',
      )}
    >
      <div className="mx-auto flex h-16 max-w-content items-center gap-4 px-4 lg:px-6">
        <Link to="/" data-testid="header-logo" className="shrink-0 text-fg">
          <Logo />
        </Link>

        <nav aria-label="Products" className="ml-4 hidden items-center gap-1 md:flex">
          {PRODUCT_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              data-testid={tab.testId}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-body-md font-semibold transition-colors duration-fast',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-fg-muted hover:text-fg',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <Link
            to="/manage"
            data-testid="nav-manage"
            className="hidden rounded-md px-3 py-2 text-body-md font-medium text-fg-muted hover:text-fg sm:block"
          >
            Manage booking
          </Link>

          <IconButton
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            data-testid="theme-toggle"
            data-dd-action-name="Toggle theme"
            onClick={toggle}
          >
            {theme === 'dark' ? (
              <Sun aria-hidden className="h-5 w-5" />
            ) : (
              <Moon aria-hidden className="h-5 w-5" />
            )}
          </IconButton>

          {user ? (
            <div className="relative">
              <button
                type="button"
                data-testid="account-menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-sunken"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-caption font-semibold text-white">
                  {user.firstName.charAt(0)}
                  {user.lastName.charAt(0)}
                </span>
                <span className="hidden text-body-md font-medium sm:inline">{user.firstName}</span>
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-border bg-bg-elevated p-1 shadow-lg"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <span className="truncate text-body-sm text-fg-muted">{user.email}</span>
                    <Badge intent="brand" size="sm">
                      {user.tier}
                    </Badge>
                  </div>
                  <Link
                    role="menuitem"
                    to="/account"
                    data-testid="menu-account"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 rounded-sm px-3 py-2 text-body-md hover:bg-bg-sunken"
                  >
                    <UserIcon aria-hidden className="h-4 w-4" /> Account and trips
                  </Link>
                  <button
                    role="menuitem"
                    type="button"
                    data-testid="menu-sign-out"
                    data-dd-action-name="Sign out"
                    onClick={signOut}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-body-md hover:bg-bg-sunken"
                  >
                    <LogOut aria-hidden className="h-4 w-4" /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate('/login')}
              data-testid="header-sign-in"
            >
              Sign in
            </Button>
          )}

          <IconButton
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            data-testid="mobile-menu-toggle"
            className="md:hidden"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X aria-hidden className="h-5 w-5" />
            ) : (
              <Menu aria-hidden className="h-5 w-5" />
            )}
          </IconButton>
        </div>
      </div>

      {menuOpen ? (
        <nav aria-label="Mobile navigation" className="border-t border-border px-4 py-2 md:hidden">
          {[
            ...PRODUCT_TABS,
            { to: '/manage', label: 'Manage booking', testId: 'nav-manage-mobile' },
          ].map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              data-testid={tab.testId}
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2.5 text-body-md font-medium text-fg hover:bg-bg-sunken"
            >
              <Plane aria-hidden className="h-4 w-4 text-fg-muted" />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
