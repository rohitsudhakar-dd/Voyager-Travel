import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageContainer } from '@/components/layout/Page';
import { EmptyState } from '@/components/ui';

export default function NotFoundPage() {
  return (
    <PageContainer className="py-16">
      <EmptyState
        icon={<Compass aria-hidden className="h-5 w-5" />}
        title="We can't find that page"
        description="The link may be old, or the trip it pointed at may have finished."
        testId="not-found"
        action={
          <Link
            to="/"
            className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-body-md font-semibold text-white hover:bg-brand-700"
          >
            Back to search
          </Link>
        }
      />
    </PageContainer>
  );
}
