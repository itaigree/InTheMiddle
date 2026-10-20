// Errors shared by all map/data providers.

/**
 * The provider can't serve requests right now and the app should switch to
 * another one. `reason` is one of:
 *   'quota'          – the (free) quota is used up
 *   'auth'           – key missing/invalid/restricted, API or billing not enabled
 *   'not-configured' – no API key was provided at all
 *   'load-failed'    – the provider's SDK or servers could not be reached
 */
export class ProviderUnavailableError extends Error {
  constructor(message, { reason = 'load-failed', cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderUnavailableError';
    this.reason = reason;
  }
}

/** A request failed in a way that switching providers wouldn't fix (bad input, timeout…). */
export class ProviderRequestError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message, { cause });
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

export function isAbortError(err) {
  return err?.name === 'AbortError';
}
