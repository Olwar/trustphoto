import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useNetworkState } from 'expo-network';
import * as WebBrowser from 'expo-web-browser';
import { API_URL } from '@/lib/api';
import { DELETE_NOTE, MAX_SHOT_AGE_MS, PUBLIC_NOTE, SENDS_NOTE } from '@trustphoto/shared';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { ResultSheet, type SheetState } from '@/components/ResultSheet';
import { cameraPalette as p, type } from '@/constants/theme';
import { ApiError, CancelledError, NetworkError } from '@/lib/api';
import { sendShot, type Shot } from '@/lib/capture';
import { useMotionRecorder } from '@/lib/motion';
import { addPhoto, deletePhoto, refreshPhotos, usePhotos } from '@/lib/photos';
import { sharePhoto } from '@/lib/share';

const SHOT_AGE_MINUTES = Math.round(MAX_SHOT_AGE_MS / 60_000);
/** Room the shutter row needs under the viewfinder. */
const CONTROLS_HEIGHT = 140;
/** Space above the viewfinder when the screen is tall enough. */
const TOP_GAP = 44;

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  // A 3:4 viewfinder, shorter on small screens so the shutter row always fits above the home indicator.
  const free = window.height - insets.top - insets.bottom;
  const topGap = free - (window.width * 4) / 3 - CONTROLS_HEIGHT >= TOP_GAP ? TOP_GAP : 0;
  const viewfinderHeight = Math.min((window.width * 4) / 3, free - CONTROLS_HEIGHT - topGap);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const upload = useRef<AbortController | null>(null);
  const [focused, setFocused] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [facing, setFacing] = useState<CameraType>('back');
  /** Changing it mounts a fresh camera after a start failure. */
  const [cameraKey, setCameraKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState<Shot | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const { photos, synced } = usePhotos();

  // The camera exists only while this screen is in front: on Android the
  // `active` prop does nothing, and the stack keeps this screen mounted.
  const cameraOn = focused && foreground;
  const live = cameraOn && permission?.granted === true && shot === null;
  useEffect(() => {
    if (!cameraOn) setReady(false);
  }, [cameraOn]);
  const { takeWindow, hasGyroscope } = useMotionRecorder(live);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    // Back from Settings: read the camera permission again.
    const sub = AppState.addEventListener('change', (s) => {
      setForeground(s === 'active');
      if (s === 'active') getPermission().catch(() => undefined);
    });
    return () => sub.remove();
  }, [getPermission]);
  useEffect(() => {
    refreshPhotos().catch(() => undefined);
  }, []);

  const send = useCallback(async (s: Shot) => {
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    setSheet({ kind: 'sending' });
    try {
      const result = await sendShot(s, controller.signal);
      if (result.status === 'verified') {
        addPhoto(result.photo);
        Haptics.notificationAsync(result.photo.isTest ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        setSheet({ kind: 'verified', photo: result.photo });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        setSheet({ kind: 'not_verified', message: result.message });
      }
    } catch (err) {
      if (err instanceof CancelledError) return;
      if (err instanceof NetworkError) {
        setSheet({
          kind: 'error',
          title: 'Could Not Send',
          message: `Check the connection. Try again within ${SHOT_AGE_MINUTES} minutes. After that, this photo cannot be verified.`,
          action: 'retry',
        });
      } else if (err instanceof ApiError && err.code === 'duplicate_photo') {
        setSheet({ kind: 'error', title: 'Already Sent', message: err.message, action: 'ok' });
      } else if (err instanceof ApiError && (err.code === 'device_check_limit' || err.code === 'device_check_busy')) {
        // "Try again tomorrow / in an hour / later": a retry now would meet the same limit.
        setSheet({ kind: 'error', title: 'Not Now', message: `${err.message} Take a new photo then.`, action: 'ok' });
      } else {
        // Worth a retry: server trouble, a short wait, an expired nonce (a retry gets a new one). Not: a refusal.
        const retry =
          !(err instanceof ApiError) || err.status >= 500 || ['rate_limited', 'install_busy', 'nonce_invalid'].includes(err.code);
        setSheet({ kind: 'error', title: 'Could Not Send', message: err instanceof ApiError ? err.message : 'Something went wrong. Try again.', action: retry ? 'retry' : 'new_photo' });
      }
    } finally {
      if (upload.current === controller) upload.current = null;
    }
  }, []);

  const takePhoto = useCallback(async () => {
    if (!camera.current || !ready || shot) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    const captureTimestamp = Date.now();
    try {
      // The file as the camera module saves it, not compressed again by the app: its hash is bound into the device check.
      const picture = await camera.current.takePictureAsync({ quality: 0.95, exif: true });
      // The motion window ends at the shutter press, not when the file is saved.
      const next: Shot = { uri: picture.uri, samples: takeWindow(captureTimestamp), captureTimestamp, hasGyroscope };
      setShot(next);
      void send(next);
    } catch {
      setSheet({ kind: 'error', title: 'Camera Error', message: 'The camera did not take the photo. Try again.', action: 'new_photo' });
    }
  }, [ready, shot, takeWindow, hasGyroscope, send]);

  const reset = useCallback(() => {
    // A cancelled or failed upload may still have reached the server: look again shortly.
    if (upload.current || sheet?.kind === 'error') setTimeout(() => refreshPhotos().catch(() => undefined), 5_000);
    upload.current?.abort();
    upload.current = null;
    setSheet(null);
    setShot(null);
  }, [sheet]);

  // Android Back closes the sheet (and cancels a running upload) instead of the app.
  useEffect(() => {
    if (!sheet) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      reset();
      return true;
    });
    return () => sub.remove();
  }, [sheet, reset]);

  if (!permission) return <View style={styles.black} />;
  if (!permission.granted) {
    const denied = !permission.canAskAgain;
    return (
      <View style={[styles.black, styles.permission, { paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={styles.permissionBody}>
          <Icon name="camera" size={56} color={p.label} />
          <Text style={[type.title2, styles.permissionTitle]} accessibilityRole="header">
            {denied ? 'Camera Access Is Off' : 'Allow Camera Access'}
          </Text>
          <Text style={[type.body, styles.permissionText]}>
            {denied ? 'Turn on the camera for TrustPhoto in Settings.' : 'TrustPhoto takes photos with the camera. It never reads your photo library.'}
          </Text>
          <Text style={[type.footnote, styles.permissionText]}>{SENDS_NOTE}</Text>
          <Text style={[type.footnote, styles.permissionText]}>{PUBLIC_NOTE}</Text>
          <Text style={[type.footnote, styles.permissionText]}>{DELETE_NOTE}</Text>
          <Button palette={p} variant="plain" title="Privacy" onPress={() => WebBrowser.openBrowserAsync(`${API_URL}/privacy`)} />
        </ScrollView>
        <Button
          palette={p}
          title={denied ? 'Open Settings' : 'Continue'}
          onPress={() => (denied ? Linking.openSettings() : requestPermission())}
          style={styles.permissionButton}
        />
      </View>
    );
  }

  const latest = photos[0];
  const firstPhoto = synced && photos.length === 0 && !shot;
  const behindSheet = sheet ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const } : {};
  return (
    <View style={styles.black}>
      <StatusBar style="light" />
      <View style={[styles.viewfinder, { marginTop: insets.top + topGap, height: viewfinderHeight }]} {...behindSheet}>
        {cameraOn ? (
          <CameraView
            key={cameraKey}
            ref={camera}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode="picture"
            animateShutter
            onCameraReady={() => setReady(true)}
            onMountError={() => setSheet({ kind: 'error', title: 'Camera Error', message: 'The camera could not start.', action: 'restart_camera' })}
          />
        ) : null}
        {shot ? <Image source={{ uri: shot.uri }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
        {offline && !shot ? (
          <View style={styles.hint} pointerEvents="none" accessibilityLiveRegion="polite">
            <Text style={[type.footnote, styles.hintText]}>No connection. A photo must reach TrustPhoto within {SHOT_AGE_MINUTES} minutes to be verified.</Text>
          </View>
        ) : firstPhoto ? (
          <View style={styles.hint} pointerEvents="none">
            <Text style={[type.footnote, styles.hintText]}>{PUBLIC_NOTE}</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]} {...behindSheet}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Your photos"
          onPress={() => router.push('/library')}
          style={({ pressed }) => [styles.thumb, pressed && styles.pressed]}
        >
          {latest ? (
            <Image source={{ uri: latest.imageUrl }} style={styles.thumbImage} contentFit="cover" transition={150} />
          ) : (
            <Icon name="photos" size={22} color={p.label} />
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{ disabled: !ready || shot !== null }}
          disabled={!ready || shot !== null}
          onPress={takePhoto}
          style={[styles.shutterRing, (!ready || shot) && styles.dim]}
        >
          {({ pressed }) => <View style={[styles.shutter, pressed && styles.shutterPressed]} />}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={facing === 'back' ? 'Use front camera' : 'Use back camera'}
          disabled={shot !== null}
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
        >
          <Icon name="flip" size={22} color={p.label} />
        </Pressable>
      </View>

      {sheet ? (
        <ResultSheet
          state={sheet}
          bottomInset={insets.bottom}
          onShare={sharePhoto}
          onDone={reset}
          onRetry={() => (shot ? send(shot) : reset())}
          onCancel={reset}
          onDelete={async (photo) => {
            await deletePhoto(photo.id);
            reset();
          }}
          onRestartCamera={() => {
            setSheet(null);
            setShot(null);
            setReady(false);
            setCameraKey((k) => k + 1);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  viewfinder: { width: '100%', overflow: 'hidden', backgroundColor: '#111' },
  hint: { position: 'absolute', left: 16, right: 16, bottom: 16, alignItems: 'center' },
  hintText: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, overflow: 'hidden', textAlign: 'center' },
  controls: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32, minHeight: CONTROLS_HEIGHT },
  thumb: { width: 48, height: 48, borderRadius: 10, overflow: 'hidden', backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' },
  thumbImage: { width: '100%', height: '100%' },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  shutterRing: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutter: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff' },
  shutterPressed: { transform: [{ scale: 0.9 }], opacity: 0.85 },
  dim: { opacity: 0.4 },
  permission: { justifyContent: 'space-between', paddingHorizontal: 32 },
  permissionBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 24 },
  permissionTitle: { color: p.label, textAlign: 'center' },
  permissionText: { color: p.secondaryLabel, textAlign: 'center', maxWidth: 320 },
  permissionButton: { alignSelf: 'stretch' },
});
