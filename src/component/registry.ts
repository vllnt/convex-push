import { ConvexError } from "convex/values";
import {
  MAX_CUSTOM_ADDRESS_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_REF_LENGTH,
  MAX_TOKEN_LENGTH,
  type PushErrorCode,
} from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import { base64Decode, sha256Hex } from "./crypto/codec.js";
import type { DeviceAddress, DeviceView } from "./validators.js";

/**
 * Throw a coded error.
 * @param code - The error code.
 * @param message - A message without secrets or payload content.
 * @returns Never.
 */
export function fail(code: PushErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

/**
 * Check an opaque ref: non-empty and at most 256 characters.
 * @param field - Field name for the error.
 * @param value - The ref.
 */
export function checkRef(field: string, value: string): void {
  if (value.length === 0 || value.length > MAX_REF_LENGTH) {
    fail("INVALID_ARGUMENT", `${field} must be 1 to ${String(MAX_REF_LENGTH)} characters`);
  }
}

function checkPrintable(field: string, value: string, max: number): void {
  if (value.length === 0 || value.length > max || /\s/.test(value)) {
    fail("INVALID_ADDRESS", `${field} must be 1 to ${String(max)} characters without whitespace`);
  }
}

/** Host names that only resolve inside a machine or a private network. */
const PRIVATE_HOST = /(^localhost$)|\.(localhost|local|localdomain|internal|intranet|lan|corp|svc|test|arpa)$/;

/**
 * Whether a URL is https on the default port, with no credentials, to a public
 * host name. IP literals, a trailing dot and private names are refused, so a registered
 * endpoint cannot point the send action at the deployment's own network.
 * DNS answers are not checked (a public name may still resolve privately).
 * @param value - The URL.
 * @returns Whether it may be used as a Web Push endpoint.
 */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const ipLiteral = host.startsWith("[") || /^[\d.]+$/.test(host);
  const trailingDot = host.endsWith(".");
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    host.includes(".") &&
    !ipLiteral &&
    !trailingDot &&
    !PRIVATE_HOST.test(host)
  );
}

/**
 * Validate a device address. Web Push endpoints must be https URLs to a public
 * host name (see `isPublicHttpsUrl`) and carry a 65-byte P-256 key and a
 * 16-byte auth secret.
 * @param address - The address to check.
 */
export function checkAddress(address: DeviceAddress): void {
  switch (address.platform) {
    case "apns":
    case "fcm": {
      checkPrintable("token", address.token, MAX_TOKEN_LENGTH);
      return;
    }
    case "webpush": {
      checkPrintable("endpoint", address.endpoint, MAX_ENDPOINT_LENGTH);
      if (!isPublicHttpsUrl(address.endpoint)) {
        fail("INVALID_ADDRESS", "endpoint must be an https URL to a public host name, on the default port");
      }
      if (base64Decode(address.p256dh)?.length !== 65 || base64Decode(address.auth)?.length !== 16) {
        fail("INVALID_ADDRESS", "p256dh must be a 65-byte P-256 key and auth a 16-byte secret");
      }
      return;
    }
    case "custom": {
      checkRef("provider", address.provider);
      if (address.address.length === 0 || address.address.length > MAX_CUSTOM_ADDRESS_LENGTH) {
        fail("INVALID_ADDRESS", `address must be 1 to ${String(MAX_CUSTOM_ADDRESS_LENGTH)} characters`);
      }
    }
  }
}

/**
 * The dedupe key of an address: SHA-256 of the platform and the address. Web
 * Push keys are left out, so a subscription whose keys rotate stays one row.
 * @param address - A device address.
 * @returns 64 hex characters.
 */
export function addressHash(address: DeviceAddress): Promise<string> {
  switch (address.platform) {
    case "apns":
    case "fcm": {
      return sha256Hex(`${address.platform}\n${address.token}`);
    }
    case "webpush": {
      return sha256Hex(`webpush\n${address.endpoint}`);
    }
    case "custom": {
      return sha256Hex(`custom\n${address.provider}\n${address.address}`);
    }
  }
}

/**
 * The public view of a device. The address is never returned.
 * @param device - A devices row.
 * @returns The view.
 */
export function toDeviceView(device: Doc<"devices">): DeviceView {
  return {
    deviceId: device._id,
    subjectRef: device.subjectRef,
    appRef: device.appRef,
    platform: device.address.platform,
    provider: device.address.platform === "custom" ? device.address.provider : undefined,
    status: device.status,
    invalidCode: device.invalidCode,
    installRef: device.installRef,
    locale: device.locale,
    lastSeenAt: device.lastSeenAt,
  };
}
