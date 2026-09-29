import type { BookingSummary } from '@voyager/shared-schemas';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from '@/api/hooks/account';
import { useMyBookings } from '@/api/hooks/booking';
import { errorMessage } from '@/api/errors';
import { PageContainer, PageHeading } from '@/components/layout/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  type TableColumn,
} from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { formatDateShort, formatMoney, initials } from '@/lib/format';

const STATE_INTENT: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  CONFIRMED: 'success',
  HELD: 'warning',
  PENDING_PAYMENT: 'warning',
  CANCELLED: 'danger',
  FAILED: 'danger',
  REFUNDED: 'info',
};

/**
 * 06-USER-FLOWS.md § 5 names `GET /bookings/mine` and § 2.4 names
 * `GET /bff/account`. Both are used: the BFF call fills the page and its first
 * page of history in one round trip, and pagination then goes straight to
 * `/bookings/mine` -- which is the query S3 degrades.
 */
export default function AccountPage() {
  const { user } = useAuth();
  const account = useAccount(true);
  const [page, setPage] = useState(1);
  const extraPages = useMyBookings(page, page > 1);

  const bookings: BookingSummary[] =
    page > 1 && extraPages.data ? extraPages.data.bookings : (account.data?.bookings ?? []);
  const total = extraPages.data?.total ?? account.data?.bookingsTotal ?? 0;
  const pageSize = extraPages.data?.size ?? 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const columns: TableColumn<BookingSummary>[] = [
    {
      id: 'headline',
      header: 'Booking',
      render: (booking) => (
        <span className="flex flex-col">
          <span className="text-body-md text-fg">{booking.headline}</span>
          {booking.pnr ? (
            <Link
              to={`/manage/${booking.pnr}`}
              className="font-mono text-mono-sm text-brand-600 hover:underline"
            >
              {booking.pnr}
            </Link>
          ) : null}
        </span>
      ),
    },
    {
      id: 'travelDate',
      header: 'Travel date',
      render: (booking) => (booking.travelDate ? formatDateShort(booking.travelDate) : '—'),
    },
    {
      id: 'state',
      header: 'Status',
      render: (booking) => (
        <Badge intent={STATE_INTENT[booking.state] ?? 'neutral'} size="sm" dot>
          {booking.state.replace(/_/g, ' ').toLowerCase()}
        </Badge>
      ),
    },
    {
      id: 'totalCents',
      header: 'Total',
      align: 'right',
      render: (booking) => (
        <span className="tabular">{formatMoney(booking.totalCents, booking.currency)}</span>
      ),
    },
  ];

  return (
    <PageContainer className="py-10">
      <PageHeading title="Your account" />

      {account.isError ? (
        <Alert intent="danger" title="We could not load your account" className="mt-4">
          {errorMessage(account.error)}
        </Alert>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Booking history</CardTitle>
          </CardHeader>
          <CardBody>
            {account.isPending ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} shape="rect" className="h-12" />
                ))}
              </div>
            ) : bookings.length === 0 ? (
              <EmptyState
                title="No bookings yet"
                description="When you book a flight or a hotel it will appear here."
                action={
                  <Link
                    to="/"
                    className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-body-md font-semibold text-white hover:bg-brand-700"
                  >
                    Start searching
                  </Link>
                }
              />
            ) : (
              <>
                <Table
                  caption="Your bookings"
                  columns={columns}
                  rows={bookings}
                  getRowKey={(booking) => booking.id}
                  testId="account-bookings"
                  className={extraPages.isFetching ? 'opacity-60' : undefined}
                />
                {pageCount > 1 ? (
                  <nav
                    aria-label="Booking history pages"
                    className="mt-3 flex items-center justify-between gap-3"
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => current - 1)}
                    >
                      Previous
                    </Button>
                    <span className="tabular text-body-sm text-fg-muted">
                      Page {page} of {pageCount}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page >= pageCount}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next
                    </Button>
                  </nav>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card variant="elevated">
            <CardBody className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-heading-sm text-brand-700"
              >
                {user ? initials(user.firstName, user.lastName) : '—'}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-heading-sm">
                  {user ? `${user.firstName} ${user.lastName}` : 'Your profile'}
                </span>
                <span className="block truncate text-body-sm text-fg-muted">{user?.email}</span>
              </span>
            </CardBody>
          </Card>

          <Card variant="elevated">
            <CardHeader>
              <CardTitle>Voyager points</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              {account.data ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="tabular text-display-sm">
                      {account.data.loyalty.pointsBalance.toLocaleString('en-GB')}
                    </span>
                    <Badge intent="brand">{account.data.loyalty.tier}</Badge>
                  </div>

                  {account.data.loyalty.nextTier && account.data.loyalty.pointsToNextTier ? (
                    <div>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={tierProgress(account.data.loyalty)}
                        aria-label={`Progress to ${account.data.loyalty.nextTier}`}
                        className="h-2 overflow-hidden rounded-full bg-bg-sunken"
                      >
                        <span
                          className="block h-full rounded-full bg-accent-500"
                          style={{ width: `${tierProgress(account.data.loyalty)}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-body-sm text-fg-muted">
                        {account.data.loyalty.pointsToNextTier.toLocaleString('en-GB')} points to{' '}
                        {account.data.loyalty.nextTier}
                      </p>
                    </div>
                  ) : null}

                  <ul className="divide-y divide-border">
                    {account.data.loyalty.transactions.slice(0, 5).map((transaction) => (
                      <li
                        key={transaction.id}
                        className="flex items-baseline justify-between gap-3 py-2"
                      >
                        <span className="min-w-0 truncate text-body-sm">
                          {transaction.description}
                        </span>
                        <span
                          className={
                            transaction.points >= 0
                              ? 'tabular text-body-sm text-success-700'
                              : 'tabular text-body-sm text-danger-700'
                          }
                        >
                          {transaction.points > 0 ? '+' : ''}
                          {transaction.points.toLocaleString('en-GB')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Skeleton shape="rect" className="h-32" />
              )}
            </CardBody>
          </Card>

          {account.data && account.data.savedPaymentMethods.length > 0 ? (
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>Saved cards</CardTitle>
              </CardHeader>
              <CardBody>
                <ul className="space-y-1.5">
                  {account.data.savedPaymentMethods.map((method) => (
                    <li key={method.id} className="tabular text-body-sm text-fg-muted">
                      {method.cardBrand} ···· {method.cardLast4} · expires{' '}
                      {String(method.expiryMonth).padStart(2, '0')}/
                      {String(method.expiryYear).slice(-2)}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}

function tierProgress(loyalty: {
  lifetimePoints: number;
  pointsToNextTier: number | null;
}): number {
  if (!loyalty.pointsToNextTier) return 100;
  const target = loyalty.lifetimePoints + loyalty.pointsToNextTier;
  return Math.round((loyalty.lifetimePoints / target) * 100);
}
