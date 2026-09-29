import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { CheckoutLayout } from '@/components/layout/CheckoutLayout';
import { RouteFallback } from '@/components/layout/Page';
import { ProtectedRoute } from '@/features/auth/ProtectedRoute';
import { LoginPage, SignupPage } from '@/features/auth/AuthPages';
import HomePage from '@/features/search/HomePage';

/**
 * Routes are exactly 06-USER-FLOWS.md § 2. Every screen except the home page is
 * a separate chunk, which is what keeps the initial bundle inside the 220 KB
 * budget in 04-STYLING.md § 9 -- and the admin console, which pulls in Recharts,
 * is never downloaded by a customer.
 */
const SearchFormPage = lazy(() => import('@/features/search/SearchFormPage'));
const FlightResultsPage = lazy(() => import('@/features/search/FlightResultsPage'));
const HotelResultsPage = lazy(() => import('@/features/search/HotelResultsPage'));
const DetailPage = lazy(() => import('@/features/search/DetailPage'));
const ReviewStep = lazy(() => import('@/features/checkout/ReviewStep'));
const PassengersStep = lazy(() => import('@/features/checkout/PassengersStep'));
const PaymentStep = lazy(() => import('@/features/checkout/PaymentStep'));
const ConfirmationPage = lazy(() => import('@/features/checkout/ConfirmationPage'));
const ManageLookupPage = lazy(() => import('@/features/manage/ManageLookupPage'));
const ManageBookingPage = lazy(() => import('@/features/manage/ManageBookingPage'));
const AccountPage = lazy(() => import('@/features/account/AccountPage'));
const AdminPage = lazy(() => import('@/features/admin/AdminPage'));
const NotFoundPage = lazy(() => import('@/features/shell/NotFoundPage'));

export function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="search/flights" element={<SearchFormPage product="flights" />} />
          <Route path="search/hotels" element={<SearchFormPage product="hotels" />} />
          <Route path="results/flights/:searchId" element={<FlightResultsPage />} />
          <Route path="results/hotels/:searchId" element={<HotelResultsPage />} />
          <Route path="detail/:searchId/:resultId" element={<DetailPage />} />
          <Route path="confirmation/:bookingId" element={<ConfirmationPage />} />
          <Route path="manage" element={<ManageLookupPage />} />
          <Route path="manage/:pnr" element={<ManageBookingPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route
            path="account"
            element={
              <ProtectedRoute>
                <AccountPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        <Route path="checkout/:bookingId" element={<CheckoutLayout />}>
          <Route index element={<Navigate to="review" replace />} />
          <Route path="review" element={<ReviewStep />} />
          <Route path="passengers" element={<PassengersStep />} />
          <Route path="payment" element={<PaymentStep />} />
        </Route>

        <Route path="admin" element={<AdminPage />} />
      </Routes>
    </Suspense>
  );
}
