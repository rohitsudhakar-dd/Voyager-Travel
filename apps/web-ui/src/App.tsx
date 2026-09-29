import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { createQueryClient } from '@/api/queryClient';
import { ChaosProvider } from '@/chaos/ChaosProvider';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ToastRegion } from '@/components/ui';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { Router } from '@/router';

export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ChaosProvider>
              <Router />
              <ToastRegion />
            </ChaosProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
