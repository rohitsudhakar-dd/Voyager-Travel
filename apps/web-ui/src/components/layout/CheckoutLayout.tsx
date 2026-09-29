import { Lock } from 'lucide-react';
import { Link, Outlet } from 'react-router-dom';
import { Logo } from './Logo';

/**
 * Checkout gets its own header -- logo, step indicator, secure-payment mark and
 * no product navigation, the way real OTAs reduce abandonment. The step
 * indicator itself is rendered by each step, which is what owns the step index.
 */
export function CheckoutLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a href="#main" className="v-skip-link">
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-bg-elevated">
        <div className="mx-auto flex h-16 max-w-content items-center justify-between gap-4 px-4 lg:px-6">
          <Link to="/" data-testid="checkout-logo" className="text-fg">
            <Logo />
          </Link>
          <p className="inline-flex items-center gap-1.5 text-body-sm text-fg-muted">
            <Lock aria-hidden className="h-4 w-4 text-success-700" />
            Secure payment
          </p>
        </div>
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
