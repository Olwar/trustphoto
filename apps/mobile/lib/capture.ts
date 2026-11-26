/**
 * Sends one photo for verification: hash the exact camera file, get a fresh
 * nonce, bind photo + motion + nonce + install into one hash, get the
 * hardware commitment over it, upload.
 */

import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  computeBindingHash,
  computeDeviceDigest,
  computeSensorDigest,
  type CaptureBundle,
  type CaptureResult,
  type SensorSample,
} from '@trustphoto/shared';
import { ApiError, apiFetch } from './api';
import { withInstall, type Install } from './install';
import { AppAttestKeyInvalidError, getCommitment, prepareCommitment } from './integrity';

export interface Shot {
  /** file:// URI of the camera's JPEG, untouched. */
  uri: string;
  samples: SensorSample[];
  captureTimestamp: number;
  hasGyroscope: boolean;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `signal` cancels the request. A photo the server already received can still verify; it then shows in Photos. */
export async function sendShot(shot: Shot, signal?: AbortSignal): Promise<CaptureResult> {
  const imageSha256 = await sha256Hex(await new File(shot.uri).bytes());
  const deviceInfo: CaptureBundle['deviceInfo'] = {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    brand: Device.brand,
    model: Device.modelName,
    osVersion: Device.osVersion,
    appVersion: Application.nativeApplicationVersion,
    isDevice: Device.isDevice,
    hasGyroscope: shot.hasGyroscope,
  };

  const attempt = async (install: Install, newKey: boolean): Promise<CaptureResult> => {
    await prepareCommitment(install, { newKey });
    const { nonce } = await apiFetch<{ nonce: string }>('/v1/nonce', { method: 'POST', token: install.token, signal });
    const bindingHash = computeBindingHash({
      installId: install.installId,
      nonce,
      imageSha256,
      sensorDigest: computeSensorDigest(shot.samples),
      deviceDigest: computeDeviceDigest(deviceInfo, shot.captureTimestamp),
    });
    const bundle: CaptureBundle = {
      v: 1,
      nonce,
      imageSha256,
      captureTimestamp: shot.captureTimestamp,
      sensorData: shot.samples,
      deviceInfo,
      attestation: await getCommitment(bindingHash, install),
    };
    const form = new FormData();
    form.append('bundle', JSON.stringify(bundle));
    // React Native reads the file from disk while it uploads.
    form.append('photo', { uri: shot.uri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);
    return apiFetch<CaptureResult>('/v1/captures', { method: 'POST', token: install.token, body: form, timeoutMs: 90_000, signal });
  };

  return withInstall(async (install) => {
    try {
      return await attempt(install, false);
    } catch (err) {
      // The server does not know this phone's device key (a reset server), or
      // the key itself is gone (a restore to a new phone): make a new key
      // once, before a new nonce, and send again.
      if (err instanceof AppAttestKeyInvalidError || (err instanceof ApiError && err.code === 'attest_key_unknown')) {
        return attempt(install, true);
      }
      throw err;
    }
  });
}
