import { zodResolver } from '@hookform/resolvers/zod';
import {
  AGE_BOUNDS,
  type Booking,
  type PassengersRequest,
  passengersRequestSchema,
} from '@voyager/shared-schemas';
import { differenceInYears, parseISO } from 'date-fns';
import { useFieldArray, useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { useBookingDetail, useSavePassengers } from '@/api/hooks/booking';
import { errorMessage } from '@/api/errors';
import { useAuth } from '@/features/auth/AuthProvider';
import { Alert, Card, CardBody, CardHeader, CardTitle, Input, Select } from '@/components/ui';
import { Button } from '@/components/ui';
import { CheckoutShell, CheckoutSkeleton } from './CheckoutShell';

const TITLES = ['Mr', 'Ms', 'Mrs', 'Mx', 'Dr'].map((value) => ({ value, label: value }));

/**
 * The age bounds in 05-FUNCTIONALITY.md § 15 are measured at travel; the
 * itinerary date is not on the booking payload, so this checks age today, which
 * is the stricter side of the boundary for infants and children.
 */
const schema = passengersRequestSchema.superRefine((value, ctx) => {
  value.passengers.forEach((passenger, index) => {
    const [min, max] = AGE_BOUNDS[passenger.passengerType];
    const age = differenceInYears(new Date(), parseISO(passenger.dateOfBirth));
    if (Number.isNaN(age)) return;
    if (age < min || age > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passengers', index, 'dateOfBirth'],
        message: `An ${passenger.passengerType} must be ${min} to ${max} years old`,
      });
    }
  });
});

function travellerCount(booking: Booking): number {
  const segment = booking.items.find((item) => item.itemType === 'flight_segment');
  return Math.max(1, segment?.quantity ?? booking.passengers.length ?? 1);
}

export default function PassengersStep() {
  const { bookingId = '' } = useParams<{ bookingId: string }>();
  const detail = useBookingDetail(bookingId);

  if (detail.isPending || !detail.data) return <CheckoutSkeleton />;

  // Mounted only once the booking is in hand, so the form's default values are
  // set once and a background refetch cannot overwrite what is being typed.
  return (
    <CheckoutShell
      booking={detail.data.booking}
      step={1}
      pointsPreview={detail.data.loyalty?.pointsEarned}
    >
      <PassengerForm booking={detail.data.booking} />
    </CheckoutShell>
  );
}

function PassengerForm({ booking }: { booking: Booking }) {
  const navigate = useNavigate();
  const save = useSavePassengers(booking.id);
  const { user } = useAuth();
  const travellers = travellerCount(booking);

  const form = useForm<PassengersRequest>({
    resolver: zodResolver(schema),
    defaultValues: {
      contactEmail: booking.contactEmail ?? user?.email ?? '',
      contactPhone: booking.contactPhone ?? '',
      passengers:
        booking.passengers.length > 0
          ? booking.passengers
          : Array.from({ length: travellers }, (_, index) => ({
              passengerType: 'adult' as const,
              title: 'Mr',
              firstName: index === 0 ? (user?.firstName ?? '') : '',
              lastName: index === 0 ? (user?.lastName ?? '') : '',
              dateOfBirth: '',
              nationality: '',
              passportNumber: '',
              frequentFlyerNumber: '',
            })),
    },
  });
  const { fields } = useFieldArray({ control: form.control, name: 'passengers' });

  const submit = form.handleSubmit(async (values) => {
    try {
      await save.mutateAsync(values);
      navigate(`/checkout/${booking.id}/payment`);
    } catch {
      /* Rendered from save.error below; the traveller stays on the step. */
    }
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {save.isError ? (
        <Alert intent="danger" title="We could not save those details">
          {errorMessage(save.error)}
        </Alert>
      ) : null}

      {fields.map((field, index) => (
        <Card key={field.id} variant="elevated">
          <CardHeader>
            <CardTitle>Traveller {index + 1}</CardTitle>
          </CardHeader>
          <CardBody>
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="sr-only">Traveller {index + 1} details</legend>

              <Select
                label="Title"
                options={TITLES}
                error={form.formState.errors.passengers?.[index]?.title?.message}
                {...form.register(`passengers.${index}.title`)}
              />
              <Select
                label="Traveller type"
                options={[
                  { value: 'adult', label: 'Adult (12+)' },
                  { value: 'child', label: 'Child (2–11)' },
                  { value: 'infant', label: 'Infant (under 2)' },
                ]}
                error={form.formState.errors.passengers?.[index]?.passengerType?.message}
                {...form.register(`passengers.${index}.passengerType`)}
              />
              <Input
                label="First name"
                autoComplete={index === 0 ? 'given-name' : 'off'}
                data-testid={`passenger-${index}-first-name`}
                error={form.formState.errors.passengers?.[index]?.firstName?.message}
                {...form.register(`passengers.${index}.firstName`)}
              />
              <Input
                label="Last name"
                hint="Exactly as it appears in the passport"
                autoComplete={index === 0 ? 'family-name' : 'off'}
                data-testid={`passenger-${index}-last-name`}
                error={form.formState.errors.passengers?.[index]?.lastName?.message}
                {...form.register(`passengers.${index}.lastName`)}
              />
              <Input
                label="Date of birth"
                type="date"
                data-testid={`passenger-${index}-dob`}
                error={form.formState.errors.passengers?.[index]?.dateOfBirth?.message}
                {...form.register(`passengers.${index}.dateOfBirth`)}
              />
              <Input
                label="Nationality"
                hint="Two-letter country code, for example GB"
                maxLength={2}
                className="uppercase"
                data-testid={`passenger-${index}-nationality`}
                error={form.formState.errors.passengers?.[index]?.nationality?.message}
                {...form.register(`passengers.${index}.nationality`, {
                  setValueAs: (value: string) => value.trim().toUpperCase(),
                })}
              />
              <Input
                label="Passport number"
                hint="Optional now, required before travel"
                maxLength={20}
                error={form.formState.errors.passengers?.[index]?.passportNumber?.message}
                {...form.register(`passengers.${index}.passportNumber`)}
              />
              <Input
                label="Loyalty number"
                hint="Optional"
                maxLength={20}
                error={form.formState.errors.passengers?.[index]?.frequentFlyerNumber?.message}
                {...form.register(`passengers.${index}.frequentFlyerNumber`)}
              />
            </fieldset>
          </CardBody>
        </Card>
      ))}

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Where should we send the itinerary?</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            data-testid="contact-email"
            error={form.formState.errors.contactEmail?.message}
            {...form.register('contactEmail')}
          />
          <Input
            label="Mobile number"
            type="tel"
            autoComplete="tel"
            hint="For airline disruption alerts only"
            data-testid="contact-phone"
            error={form.formState.errors.contactPhone?.message}
            {...form.register('contactPhone')}
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button
          type="submit"
          size="lg"
          loading={save.isPending}
          data-testid="passengers-continue"
          data-dd-action-name="Submit passenger details"
          data-passenger-count={fields.length}
        >
          Continue to payment
        </Button>
      </div>
    </form>
  );
}
