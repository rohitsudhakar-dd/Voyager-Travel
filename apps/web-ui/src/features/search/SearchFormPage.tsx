import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageContainer, PageHeading } from '@/components/layout/Page';
import { SearchPanel, type SearchProduct } from './SearchPanel';
import { flightSearchFromParams, hotelSearchFromParams } from './searchParams';

/**
 * `/search/flights` and `/search/hotels`. Deep-linkable: every field is read
 * back out of the query string, which is what makes a deal link or a shared
 * search work.
 */
export default function SearchFormPage({ product }: { product: SearchProduct }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const flight = useMemo(() => flightSearchFromParams(searchParams), [searchParams]);
  const hotel = useMemo(() => hotelSearchFromParams(searchParams), [searchParams]);

  return (
    <PageContainer className="py-10">
      <PageHeading
        title={product === 'flights' ? 'Find a flight' : 'Find a hotel'}
        description={
          product === 'flights'
            ? 'Live fares from every carrier we sell, priced with taxes included.'
            : 'Rooms, rates and cancellation terms, shown before you commit.'
        }
      />
      <SearchPanel
        className="mt-6"
        product={product}
        onProductChange={(next) => navigate(`/search/${next}`)}
        initialFlight={flight}
        initialHotel={hotel}
      />
    </PageContainer>
  );
}
