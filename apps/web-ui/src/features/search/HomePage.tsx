import { ArrowRight, Plane } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useHome } from '@/api/hooks/account';
import { useImagePolicy } from '@/chaos/ChaosProvider';
import { PageContainer } from '@/components/layout/Page';
import { Badge, Card, PriceTag, Skeleton } from '@/components/ui';
import { HOTEL_IMAGE_DIMENSIONS, hotelImageUrl } from '@/lib/assets';
import { formatDateWithDay } from '@/lib/format';
import { SearchPanel, type SearchProduct } from './SearchPanel';

export default function HomePage() {
  const [product, setProduct] = useState<SearchProduct>('flights');
  const home = useHome();
  const navigate = useNavigate();

  return (
    <>
      {/* No purple gradient. A restrained brand wash, and real copy. */}
      <section className="bg-brand-800 pb-16 pt-12 text-white">
        <PageContainer>
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-caption font-medium">
            <Plane aria-hidden className="h-3.5 w-3.5" />
            Flights and hotels, one basket
          </p>
          <h1 className="mt-4 max-w-2xl text-display-lg">Go further for less</h1>
          <p className="mt-3 max-w-xl text-body-lg text-brand-100">
            Fares from twelve hundred carriers and eighty thousand properties, priced live.
          </p>
        </PageContainer>
      </section>

      <PageContainer>
        <SearchPanel product={product} onProductChange={setProduct} overlap />
      </PageContainer>

      <PageContainer className="mt-12 space-y-12">
        {home.data?.upcomingTrips.length ? (
          <section aria-labelledby="upcoming-trips">
            <h2 id="upcoming-trips" className="text-heading-lg">
              Your upcoming trips
            </h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {home.data.upcomingTrips.map((trip) => (
                <Card key={trip.bookingId} variant="interactive" as="li">
                  <Link
                    to={`/manage/${trip.pnr}`}
                    data-testid="upcoming-trip"
                    className="flex items-center justify-between gap-3 p-4"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-heading-sm">{trip.headline}</span>
                      <span className="tabular block text-body-sm text-fg-muted">
                        {formatDateWithDay(trip.departAt)}
                      </span>
                      <span className="mt-1 block font-mono text-mono-sm text-fg-muted">
                        {trip.pnr}
                      </span>
                    </span>
                    <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-fg-muted" />
                  </Link>
                </Card>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="deals">
          <div className="flex items-end justify-between gap-4">
            <h2 id="deals" className="text-heading-lg">
              Deals worth a detour
            </h2>
            {home.data?.loyalty ? (
              <Badge intent="brand" data-testid="home-loyalty-badge">
                {home.data.loyalty.tier} · {home.data.loyalty.pointsBalance.toLocaleString('en-GB')}{' '}
                pts
              </Badge>
            ) : null}
          </div>

          {home.isPending ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="overflow-hidden rounded-lg border border-border">
                  <Skeleton shape="rect" className="h-[180px] rounded-none" />
                  <div className="space-y-2 p-4">
                    <Skeleton width="60%" height={18} />
                    <Skeleton width="35%" height={12} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(home.data?.deals ?? []).map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  onOpen={() =>
                    deal.productType === 'flight' && deal.origin && deal.destination
                      ? navigate(
                          `/search/flights?origin=${deal.origin}&destination=${deal.destination}`,
                        )
                      : navigate(`/search/hotels?city=${encodeURIComponent(deal.cityName)}`)
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </PageContainer>
    </>
  );
}

function DealCard({
  deal,
  onOpen,
}: {
  deal: NonNullable<ReturnType<typeof useHome>['data']>['deals'][number];
  onOpen: () => void;
}) {
  const image = useImagePolicy('sm');
  const dimensions = HOTEL_IMAGE_DIMENSIONS.sm;

  return (
    <Card variant="interactive" as="li" className="overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        data-testid="deal-card"
        className="flex w-full flex-col text-left"
      >
        <img
          src={hotelImageUrl(deal.imageSeed, image.size)}
          alt=""
          width={dimensions.width}
          height={dimensions.height}
          {...image.attrs}
          className="h-[180px] w-full object-cover"
        />
        <span className="flex w-full items-end justify-between gap-3 p-4">
          <span className="min-w-0">
            <span className="block truncate text-heading-sm">{deal.cityName}</span>
            <span className="block truncate text-body-sm text-fg-muted">{deal.headline}</span>
          </span>
          <PriceTag cents={deal.fromPriceCents} currency={deal.currency} from />
        </span>
      </button>
    </Card>
  );
}
