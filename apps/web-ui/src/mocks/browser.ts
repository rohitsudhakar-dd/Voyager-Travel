import { setupWorker } from 'msw/browser';
import { accountHandlers } from './handlers/account';
import { adminHandlers } from './handlers/admin';
import { bookingHandlers } from './handlers/booking';
import { referenceHandlers } from './handlers/reference';
import { searchHandlers } from './handlers/search';
import { supportHandlers } from './handlers/support';

export const handlers = [
  ...referenceHandlers,
  ...searchHandlers,
  ...bookingHandlers,
  ...accountHandlers,
  ...supportHandlers,
  ...adminHandlers,
];

export const worker = setupWorker(...handlers);
