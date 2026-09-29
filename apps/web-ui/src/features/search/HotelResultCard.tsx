import type { HotelResult } from '@voyager/shared-schemas';
import { Coffee, Dumbbell, ParkingCircle, Star, Utensils, Waves, Wifi, Wind } from 'lucide-react';
import { Badge, Button, PriceTag } from '@/components/ui';
import { useImagePolicy } from '@/chaos/ChaosProvider';
import { HOTEL_IMAGE_DIMENSIONS, hotelImageUrl } from '@/lib/assets';
import { formatMoney, pluralise, priceBand } from '@/lib/format';

const AMENITY_ICONS: Record<string, React.ReactNode> = {
  wifi: <Wifi aria-hidden className="h-4 w-4" />,
  pool: <Waves aria-hidden className="h-4 w-4" />,
  gym: <Dumbbell aria-hidden className="h-4 w-4" />,
  parking: <ParkingCircle aria-hidden className="h-4 w-4" />,
  breakfast: <Coffee aria-hidden className="h-4 w-4" />,
  restaurant: <Utensils aria-hidden className="h-4 w-4" />,
  air_conditioning: <Wind aria-hidden className="h-4 w-4" />,
};

export interface HotelResultCardProps {
  result: HotelResult;
  position: number;
  onSelect: (result: HotelResult) => void;
  onViewDetails: (result: HotelResult) => void;
  selecting?: boolean;
}

/**
 * The image-forward screen, and therefore the LCP-sensitive one. Width and
 * height are always explicit; `frontend_heavy_assets` is the only thing that
 * changes which variant is served and whether it lazy-loads.
 */
export function HotelResultCard({
  result,
  position,
  onSelect,
  onViewDetails,
  selecting,
}: HotelResultCardProps) {
  const image = useImagePolicy('sm');
  const dimensions = HOTEL_IMAGE_DIMENSIONS.sm;

  return (
    <li
      data-testid="hotel-result-card"
      data-position={position}
      data-price-band={priceBand(result.totalCents)}
      data-star-rating={result.starRating}
      className="v-deferred-row flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-xs transition-[border-color,box-shadow] duration-fast hover:border-border-strong hover:shadow-sm sm:flex-row"
    >
      <img
        src={hotelImageUrl(result.imageSeed, image.size)}
        alt=""
        width={dimensions.width}
        height={dimensions.height}
        {...image.attrs}
        className="h-[180px] w-full shrink-0 object-cover sm:w-[240px]"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-heading-md">{result.name}</h3>
            <p className="truncate text-body-sm text-fg-muted">
              {result.neighborhood ? `${result.neighborhood}, ` : ''}
              {result.cityName}
            </p>
          </div>
          <span
            aria-label={`${result.starRating} star`}
            className="flex shrink-0 items-center gap-0.5 text-accent-500"
          >
            {Array.from({ length: result.starRating }, (_, index) => (
              <Star key={index} aria-hidden className="h-3.5 w-3.5 fill-current" />
            ))}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge intent="brand" size="sm">
            <span className="tabular">{result.reviewScore.toFixed(1)}</span>
            <span className="text-fg-muted">· {result.reviewCount} reviews</span>
          </Badge>
          {result.breakfastIncluded ? (
            <Badge intent="success" size="sm">
              Breakfast included
            </Badge>
          ) : null}
          {result.refundable ? (
            <Badge intent="success" size="sm">
              Free cancellation
            </Badge>
          ) : null}
        </div>

        <p className="text-body-sm text-fg-muted">
          {result.roomName} · {result.ratePlanName}
        </p>

        <ul className="mt-auto flex items-center gap-3 text-fg-muted">
          {result.amenities.slice(0, 3).map((amenity) => (
            <li key={amenity} className="flex items-center gap-1.5 text-body-sm">
              {AMENITY_ICONS[amenity] ?? null}
              <span className="capitalize">{amenity.replace(/_/g, ' ')}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex shrink-0 flex-row items-center justify-between gap-2 border-t border-border p-4 sm:w-44 sm:flex-col sm:items-end sm:justify-center sm:border-l sm:border-t-0">
        <div className="text-right">
          <PriceTag
            cents={result.nightlyPriceCents}
            currency={result.currency}
            suffix="per night"
          />
          <p className="tabular text-body-sm text-fg-muted">
            {formatMoney(result.totalCents, result.currency)} total for{' '}
            {pluralise(result.nights, 'night')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            loading={selecting}
            data-testid="hotel-result-select"
            data-dd-action-name="Select hotel result"
            onClick={() => onSelect(result)}
          >
            Select
          </Button>
          <button
            type="button"
            data-testid="hotel-result-details"
            data-dd-action-name="View fare details"
            onClick={() => onViewDetails(result)}
            className="text-body-sm font-medium text-brand-600 hover:underline"
          >
            Room details
          </button>
        </div>
      </div>
    </li>
  );
}
