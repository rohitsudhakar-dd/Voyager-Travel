import { Navigate, useLocation } from 'react-router-dom';
import { RouteFallback } from '@/components/layout/Page';
import { useAuth } from './AuthProvider';

/** `/account` is the only route that requires a session (06-USER-FLOWS.md § 2). */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <RouteFallback />;
  if (status === 'guest') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
