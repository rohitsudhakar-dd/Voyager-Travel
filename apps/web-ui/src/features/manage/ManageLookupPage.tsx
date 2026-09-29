import { zodResolver } from '@hookform/resolvers/zod';
import { type BookingLookup, bookingLookupSchema } from '@voyager/shared-schemas';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useBookingLookup } from '@/api/hooks/booking';
import { errorMessage, hasErrorType } from '@/api/errors';
import { PageContainer, PageHeading } from '@/components/layout/Page';
import { Alert, Button, Card, CardBody, Input } from '@/components/ui';

/** `/manage` -- guest lookup, no sign-in (06-USER-FLOWS.md § 4). */
export default function ManageLookupPage() {
  const navigate = useNavigate();
  const lookup = useBookingLookup();

  const form = useForm<BookingLookup>({
    resolver: zodResolver(bookingLookupSchema),
    defaultValues: { pnr: '', lastName: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    try {
      const { booking } = await lookup.mutateAsync(values);
      navigate(`/manage/${booking.pnr ?? values.pnr.toUpperCase()}`);
    } catch {
      /* Rendered below. */
    }
  });

  const notFound = hasErrorType(lookup.error, 'BookingNotFoundError');

  return (
    <PageContainer className="py-10">
      <div className="mx-auto max-w-md">
        <PageHeading
          title="Manage your booking"
          description="Find a booking with the six-character reference from your confirmation email."
        />

        <Card variant="elevated" className="mt-6">
          <CardBody>
            <form onSubmit={submit} noValidate className="space-y-4">
              {lookup.isError ? (
                <Alert intent={notFound ? 'warning' : 'danger'} testId="lookup-error">
                  {notFound
                    ? "We couldn't find a booking with that reference and surname. Check both and try again."
                    : errorMessage(lookup.error)}
                </Alert>
              ) : null}

              <Input
                label="Booking reference"
                placeholder="K8M2QR"
                maxLength={6}
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono uppercase tracking-widest"
                data-testid="lookup-pnr"
                error={form.formState.errors.pnr?.message}
                {...form.register('pnr', {
                  setValueAs: (value: string) => value.trim().toUpperCase(),
                })}
              />

              <Input
                label="Surname"
                autoComplete="family-name"
                data-testid="lookup-surname"
                error={form.formState.errors.lastName?.message}
                {...form.register('lastName')}
              />

              <Button
                type="submit"
                fullWidth
                size="lg"
                loading={lookup.isPending}
                data-testid="lookup-submit"
                data-dd-action-name="Look up booking"
              >
                Find my booking
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
