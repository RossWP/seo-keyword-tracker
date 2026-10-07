const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids get the same 404 as unknown or foreign ones: nothing is revealed either way. */
export const isUuid = (value: string): boolean => UUID.test(value);
