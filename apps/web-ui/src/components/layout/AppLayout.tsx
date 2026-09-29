import { Outlet } from 'react-router-dom';
import { SupportChatLauncher } from '@/features/support/SupportChatLauncher';
import { Footer } from './Footer';
import { Header } from './Header';

/** Semantic landmarks plus a skip link, per 04-STYLING.md § 7. */
export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="v-skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
      <SupportChatLauncher />
    </div>
  );
}
