/**
 * Wire contract between the phone, the server and the website.
 * Change it on all three sides at once.
 */

/** A nonce is good for this long after the server issued it, measured to the start of the upload request. */
export const NONCE_TTL_MS = 30_000;
/** The newest motion sample (bound into the proof) may be at most this old when the upload arrives. */
export const MAX_SHOT_AGE_MS = 3 * 60_000;
/** How far a phone clock may run ahead of the server. */
export const MAX_CLOCK_AHEAD_MS = 2 * 60_000;
/** The phone sends at most this many samples; the server hashes at most this many. */
export const MAX_SENSOR_SAMPLES = 10_000;
/** Motion recorded before the shutter that is attached to the shot. */
export const SENSOR_WINDOW_MS = 3_000;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export type Platform = 'ios' | 'android';

export interface SensorSample {
  /** In g, as expo-sensors reports it. */
  accelerometer: { x: number; y: number; z: number };
  /** In rad/s. */
  gyroscope: { x: number; y: number; z: number };
  /** Wall clock, ms. */
  timestamp: number;
}

export interface DeviceInfo {
  platform: Platform;
  brand: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  isDevice: boolean;
  hasGyroscope: boolean;
}

export type AttestationPayload =
  | { type: 'app_attest'; keyId: string; assertion: string }
  | { type: 'play_integrity'; token: string }
  | { type: 'none'; reason: string };

/** The JSON part of POST /v1/captures. The photo bytes travel as the second part. */
export interface CaptureBundle {
  v: 1;
  nonce: string;
  imageSha256: string;
  /** When the phone says the shutter fired (ms). The server shows its own receive time, never this. */
  captureTimestamp: number;
  sensorData: SensorSample[];
  deviceInfo: DeviceInfo;
  attestation: AttestationPayload;
}

export type CheckKey = 'device' | 'motion' | 'screen' | 'camera_file';
export type CheckState = 'passed' | 'inconclusive';

export interface PublicCheck {
  key: CheckKey;
  state: CheckState;
}

export interface PublicPhoto {
  id: string;
  /** The proof page. */
  url: string;
  imageUrl: string;
  /** ISO time the server received the photo. */
  receivedAt: string;
  /** "Apple iPhone 15 Pro", or null when the phone did not say. */
  device: string | null;
  width: number;
  height: number;
  /** Made without a hardware device check (development build). Never shown as a real proof. */
  isTest: boolean;
  checks: PublicCheck[];
}

/** The reasons a phone can show. A photo checks module picks the one that fits (the reference checks use only some of them). */
export type NotVerifiedReason = 'screen' | 'blank' | 'motion' | 'device' | 'clock' | 'stale' | 'checks';

export type CaptureResult =
  | { status: 'verified'; photo: PublicPhoto }
  | { status: 'not_verified'; reason: NotVerifiedReason; message: string };

export const NOT_VERIFIED_MESSAGES: Record<NotVerifiedReason, string> = {
  screen: 'This looks like a photo of a screen. Take a photo of the real scene.',
  blank: 'The photo is too dark or shows no detail. Add light and try again.',
  motion: 'The motion at the shot did not look like a phone in a hand. Hold the phone in your hand and take a new photo.',
  device: 'We could not confirm this phone with Apple or Google. Check the connection and take a new photo. A modified phone usually cannot pass this check.',
  clock: 'The clock on your phone is wrong. Set the date and time to automatic.',
  stale: 'This photo is too old to verify, or the clock on your phone is wrong. Set the date and time to automatic, then take a new photo.',
  checks: 'This photo did not pass all checks. Try again.',
};

/** Each check is an estimate from the photo checks, so the labels say what was found, not what is true. */
export const CHECK_LABELS: Record<CheckKey, string> = {
  device: 'Real phone, genuine app',
  motion: 'Phone motion at the shot',
  screen: 'No screen found',
  camera_file: 'No sign of editing',
};

/** Shown under the checks when one of them has no clear result. */
export const INCONCLUSIVE_NOTE = 'No clear result: this check found no sign either way, or it did not run. The other checks were enough to verify the photo.';

/** Shown under the checks of a test proof, in place of INCONCLUSIVE_NOTE. */
export const TEST_PROOF_NOTE = 'This is a test proof. These checks do not verify it.';

/** Everything that makes a verified photo public. The app shows it before the first shot. */
export const PUBLIC_NOTE = 'Each verified photo gets a public page. Anyone with the link, or with a copy of the photo or of a part of it, can find it.';

/** Who can delete a photo. */
export const DELETE_NOTE = 'Only the phone that took a photo can delete it in the app. After you delete the app on Android, or move to a new phone, ask us to remove earlier photos. The Privacy page tells you how.';

/** The confirm text before a delete, the same in every place. */
export const DELETE_CONFIRM =
  'The proof link stops working for everyone. Copies in caches can stay for up to one hour. Copies that people saved or were sent, and link previews in other apps, can stay. You cannot undo this.';

/** Who can find a verified photo, said next to "Verified" in the app. */
export const FINDABLE_NOTE = 'Anyone with the link, or with a copy of the photo or of a part of it, can find this photo and its proof.';

/** What the app sends, said before the first shot. */
export const SENDS_NOTE = 'TrustPhoto records how the phone moves at the shot and sends it with the photo. The public page shows the photo, the phone model and the time.';

/** What no proof can show. The proof page and the app repeat it next to every "Verified". */
export const PROOF_LIMITS = 'A proof does not show where the photo was taken, who took it, or that the scene is real.';

/** How a similar file sits against the verified photo. `mirrored` is known to the browser only. */
export interface LookupShape {
  /** Turn of the file against the photo, degrees clockwise, 0 to 359. */
  rotation: number;
  /** Share of the photo that the file shows, 0 to 1. */
  ofPhoto: number;
  /** Share of the file that is the photo, 0 to 1. */
  ofFile: number;
}

/**
 * A photo that may be the one. The token names it for /v1/lookup/confirm and
 * says nothing else; the proof is told only after the confirm step.
 */
export interface LookupCandidate {
  token: string;
  /** The frame that `spots` and the confirm step refer to. */
  width: number;
  height: number;
  /** Found by pHash: the index in ORIENTATIONS that matched. */
  orientation?: number;
  /** Found by keys: the photo's spots that share a key with the file, as [key, x, y]. */
  spots?: Array<[number, number, number]>;
}

export type LookupResult =
  | { match: 'exact'; photo: PublicPhoto }
  | { match: 'similar'; photo: PublicPhoto; shape?: LookupShape }
  | { match: 'candidates'; candidates: LookupCandidate[] }
  /** `unclear`: a photo may be like the file, but it has too little clear detail to compare. */
  | { match: 'none'; unclear?: true };

/** POST /v1/lookup/confirm: the detail bits of the file under the transform that puts it onto the candidate. */
export interface ConfirmRequest {
  token: string;
  /** Size of the grey picture of the file that the transform refers to. */
  frame: { width: number; height: number };
  transform: { a: number; b: number; tx: number; ty: number };
  bits: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
