import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, LoginRequest, SignupRequest, User } from '@voyager/shared-schemas';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { request } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { queryKeys } from '@/api/queryClient';
import { tokens } from '@/api/tokens';

/**
 * Auth state. Deliberately simple -- email and password, a 15-minute access
 * token and an opaque refresh token. Token refresh itself lives in the HTTP
 * client so every call benefits from it, not just the ones that go through here.
 */

interface AuthContextValue {
  user: User | null;
  status: 'loading' | 'authenticated' | 'guest';
  login: (credentials: LoginRequest) => Promise<User>;
  signup: (details: SignupRequest) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(() => Boolean(tokens.access));

  useEffect(() => tokens.subscribe(() => setHasToken(Boolean(tokens.access))), []);

  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => request<User>(endpoints.auth.me, { signal }),
    enabled: hasToken,
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = useMutation({
    mutationFn: (credentials: LoginRequest) =>
      request<AuthResponse>(endpoints.auth.login, { method: 'POST', body: credentials }),
  });

  const signupMutation = useMutation({
    mutationFn: (details: SignupRequest) =>
      request<AuthResponse>(endpoints.auth.signup, { method: 'POST', body: details }),
  });

  const value = useMemo<AuthContextValue>(() => {
    const adopt = (response: AuthResponse) => {
      tokens.set({ accessToken: response.accessToken, refreshToken: response.refreshToken });
      queryClient.setQueryData(queryKeys.me, response.user);
      return response.user;
    };

    return {
      user: me.data ?? null,
      status: !hasToken ? 'guest' : me.isPending ? 'loading' : me.data ? 'authenticated' : 'guest',

      login: async (credentials) => adopt(await loginMutation.mutateAsync(credentials)),
      signup: async (details) => adopt(await signupMutation.mutateAsync(details)),

      logout: async () => {
        try {
          await request(endpoints.auth.logout, {
            method: 'POST',
            body: { refreshToken: tokens.refresh },
          });
        } catch {
          // A failed logout still clears the client; the refresh token expires
          // on its own after 30 days.
        }
        tokens.clear();
        queryClient.removeQueries({ queryKey: queryKeys.me });
        queryClient.removeQueries({ queryKey: queryKeys.account });
        queryClient.removeQueries({ queryKey: queryKeys.loyalty });
      },
    };
  }, [me.data, me.isPending, hasToken, loginMutation, signupMutation, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
