export const R3_DOMAIN_EVENT_TOPIC = "r3.domain-event";

export interface R3DomainEvent {
  domainEvent: string;
  [key: string]: unknown;
}

/**
 * Validates the R3-owned payload before the shared worker acknowledges it.
 * Delivery-specific subscribers can be added later without changing writers.
 */
export function requireR3DomainEvent(payload: Record<string, unknown>): R3DomainEvent {
  if (typeof payload.domainEvent !== "string" ||
      !/^[A-Z][A-Za-z0-9]{2,63}$/u.test(payload.domainEvent)) {
    throw new TypeError("Invalid R3 domain event payload");
  }
  return payload as R3DomainEvent;
}
