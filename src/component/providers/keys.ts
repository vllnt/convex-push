import { sha256Hex } from "../crypto/codec.js";
import { isJsonObject } from "./payload.js";

/** The component's environment variables, as bound at mount. Every one is optional. */
export interface PushEnv {
  readonly APNS_KEY_P8?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_SANDBOX_KEY_P8?: string;
  readonly APNS_SANDBOX_KEY_ID?: string;
  readonly FCM_SERVICE_ACCOUNT_JSON?: string;
  readonly VAPID_PUBLIC_KEY?: string;
  readonly VAPID_PRIVATE_KEY?: string;
  readonly VAPID_SUBJECT?: string;
}

/** Apple token-auth key for one environment. */
export interface ApnsKey {
  pemText: string;
  keyId: string;
  teamId: string;
  credentialRef: string;
}

/** The fields of a Google service-account key file this package uses. */
export interface FcmKey {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  credentialRef: string;
}

/** VAPID key pair and contact. */
export interface VapidKey {
  publicKey: string;
  privateKey: string;
  subject: string;
  credentialRef: string;
}

/** Result of reading one provider's keys. */
export type KeyRead<T> =
  | { ok: true; value: T }
  | { ok: false; code: "CREDENTIALS_INVALID" | "PROVIDER_NOT_CONFIGURED" };

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** Variable names of the main and the sandbox-only Apple key. */
const APNS_MAIN_VARS = { pem: "APNS_KEY_P8", id: "APNS_KEY_ID" } as const;
const APNS_SANDBOX_VARS = { pem: "APNS_SANDBOX_KEY_P8", id: "APNS_SANDBOX_KEY_ID" } as const;

/**
 * Whether a provider has its keys set at all. Cheap, used at fan-out.
 * @param env - Component env.
 * @param platform - A built-in platform.
 * @returns Whether every required variable is present.
 */
export function isConfigured(env: PushEnv, platform: "apns" | "fcm" | "webpush"): boolean {
  if (platform === "apns") {
    const main = Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID);
    const sandbox = Boolean(env.APNS_SANDBOX_KEY_P8 && env.APNS_SANDBOX_KEY_ID);
    return Boolean(env.APNS_TEAM_ID) && (main || sandbox);
  }
  if (platform === "fcm") return Boolean(env.FCM_SERVICE_ACCOUNT_JSON);
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * Read the Apple key for one environment. The sandbox pair is used for sandbox
 * when set; otherwise the main key signs for both hosts.
 * @param env - Component env.
 * @param environment - Which Apple host the delivery targets.
 * @returns The key, or why it is unusable.
 */
export async function readApns(env: PushEnv, environment: "production" | "sandbox"): Promise<KeyRead<ApnsKey>> {
  const useSandboxKey = environment === "sandbox" && Boolean(env.APNS_SANDBOX_KEY_P8 && env.APNS_SANDBOX_KEY_ID);
  const names = useSandboxKey ? APNS_SANDBOX_VARS : APNS_MAIN_VARS;
  const pemText = env[names.pem];
  const keyId = env[names.id];
  const teamId = env.APNS_TEAM_ID;
  if (!pemText || !keyId || !teamId) return { ok: false, code: "PROVIDER_NOT_CONFIGURED" };
  const credentialRef = await sha256Hex(`apns:${teamId}:${keyId}`);
  return { ok: true, value: { pemText, keyId, teamId, credentialRef } };
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read the Google service-account key.
 * @param env - Component env.
 * @returns The key, or why it is unusable.
 */
export async function readFcm(env: PushEnv): Promise<KeyRead<FcmKey>> {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return { ok: false, code: "PROVIDER_NOT_CONFIGURED" };
  const parsed = parseJson(env.FCM_SERVICE_ACCOUNT_JSON);
  if (!isJsonObject(parsed)) return { ok: false, code: "CREDENTIALS_INVALID" };
  const projectId = stringField(parsed, "project_id");
  const clientEmail = stringField(parsed, "client_email");
  const privateKey = stringField(parsed, "private_key");
  const tokenUri = stringField(parsed, "token_uri") ?? GOOGLE_TOKEN_URI;
  if (!projectId || !clientEmail || !privateKey || !tokenUri.startsWith("https://")) {
    return { ok: false, code: "CREDENTIALS_INVALID" };
  }
  const keyId = stringField(parsed, "private_key_id") ?? "";
  const credentialRef = await sha256Hex(`fcm:${clientEmail}:${keyId}`);
  return { ok: true, value: { projectId, clientEmail, privateKey, tokenUri, credentialRef } };
}

/**
 * Read the VAPID key pair.
 * @param env - Component env.
 * @returns The key, or why it is unusable.
 */
export async function readVapid(env: PushEnv): Promise<KeyRead<VapidKey>> {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  if (!publicKey || !privateKey || !subject) return { ok: false, code: "PROVIDER_NOT_CONFIGURED" };
  if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) {
    return { ok: false, code: "CREDENTIALS_INVALID" };
  }
  const credentialRef = await sha256Hex(`vapid:${publicKey}`);
  return { ok: true, value: { publicKey, privateKey, subject, credentialRef } };
}
