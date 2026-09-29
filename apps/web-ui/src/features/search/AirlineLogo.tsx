import { useState } from 'react';
import { airlineLogoUrl, airlineMonogramDataUrl } from '@/lib/assets';
import { cn } from '@/lib/cn';

export interface AirlineLogoProps {
  code: string;
  name: string;
  size?: number;
  className?: string;
}

/**
 * Generated monograms only -- no real carrier mark appears anywhere in Voyager.
 * Explicit width and height so the row never reflows when the file lands.
 */
export function AirlineLogo({ code, name, size = 40, className }: AirlineLogoProps) {
  const [src, setSrc] = useState(() => airlineLogoUrl(code));

  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setSrc(airlineMonogramDataUrl(code))}
      className={cn('shrink-0 rounded-md', className)}
    />
  );
}
