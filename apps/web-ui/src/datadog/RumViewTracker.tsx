import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { startRumView } from './rum';

/**
 * Renders nothing; exists to turn react-router locations into RUM views.
 *
 * It has to sit inside the router but outside `Suspense`, because a lazily
 * loaded screen starts its view the moment the navigation happens rather than
 * when its chunk arrives -- otherwise the chunk download is charged to the
 * previous view and every route's loading time reads as zero.
 */
export function RumViewTracker(): null {
  const { pathname } = useLocation();

  useEffect(() => {
    startRumView(pathname);
  }, [pathname]);

  return null;
}
