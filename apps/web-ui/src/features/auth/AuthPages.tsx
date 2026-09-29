import { zodResolver } from '@hookform/resolvers/zod';
import {
  type LoginRequest,
  type SignupRequest,
  loginRequestSchema,
  signupRequestSchema,
} from '@voyager/shared-schemas';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, hasErrorType } from '@/api/errors';
import { PageContainer } from '@/components/layout/Page';
import { Alert, Button, Card, CardBody, Input } from '@/components/ui';
import { useAuth } from './AuthProvider';

function useAfterAuth() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return () => navigate(from ?? '/account', { replace: true });
}

export function LoginPage() {
  const { login } = useAuth();
  const done = useAfterAuth();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      await login(values);
      done();
    } catch (error) {
      setFailure(
        hasErrorType(error, 'AuthenticationError')
          ? 'That email and password do not match an account.'
          : errorMessage(error),
      );
    }
  });

  return (
    <AuthCard
      title="Sign in"
      footer={
        <p className="text-body-sm text-fg-muted">
          New to Voyager?{' '}
          <Link to="/signup" className="font-medium text-brand-600 hover:underline">
            Create an account
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {failure ? (
          <Alert intent="danger" testId="login-error">
            {failure}
          </Alert>
        ) : null}

        <Input
          label="Email"
          type="email"
          autoComplete="email"
          data-testid="login-email"
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          data-testid="login-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />

        <Button
          type="submit"
          fullWidth
          size="lg"
          loading={form.formState.isSubmitting}
          data-testid="login-submit"
          data-dd-action-name="Sign in"
        >
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function SignupPage() {
  const { signup } = useAuth();
  const done = useAfterAuth();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<SignupRequest>({
    resolver: zodResolver(signupRequestSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      await signup(values);
      done();
    } catch (error) {
      setFailure(
        hasErrorType(error, 'ConflictError')
          ? 'There is already an account with that email. Try signing in instead.'
          : errorMessage(error),
      );
    }
  });

  return (
    <AuthCard
      title="Create your account"
      description="Members earn Voyager points on every booking and keep their trips in one place."
      footer={
        <p className="text-body-sm text-fg-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {failure ? (
          <Alert intent="danger" testId="signup-error">
            {failure}
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="First name"
            autoComplete="given-name"
            data-testid="signup-first-name"
            error={form.formState.errors.firstName?.message}
            {...form.register('firstName')}
          />
          <Input
            label="Last name"
            autoComplete="family-name"
            data-testid="signup-last-name"
            error={form.formState.errors.lastName?.message}
            {...form.register('lastName')}
          />
        </div>

        <Input
          label="Email"
          type="email"
          autoComplete="email"
          data-testid="signup-email"
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters"
          data-testid="signup-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />

        <Button
          type="submit"
          fullWidth
          size="lg"
          loading={form.formState.isSubmitting}
          data-testid="signup-submit"
          data-dd-action-name="Sign up"
        >
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}

function AuthCard({
  title,
  description,
  footer,
  children,
}: {
  title: string;
  description?: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <PageContainer className="py-12">
      <div className="mx-auto max-w-md">
        <h1 className="text-display-sm">{title}</h1>
        {description ? <p className="mt-2 text-body-md text-fg-muted">{description}</p> : null}
        <Card variant="elevated" className="mt-6">
          <CardBody>{children}</CardBody>
        </Card>
        <div className="mt-4 text-center">{footer}</div>
      </div>
    </PageContainer>
  );
}
