import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { DELETE_CONFIRM, FINDABLE_NOTE, PROOF_LIMITS, TEST_PROOF_NOTE } from '@trustphoto/shared';
import type { PublicPhoto } from '@trustphoto/shared';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { cameraPalette as p, SHEET_BACKGROUND, type } from '@/constants/theme';

/** What the main button of an error does: send again, take a new photo, just close, or start the camera again. */
export type ErrorAction = 'retry' | 'new_photo' | 'ok' | 'restart_camera';

export type SheetState =
  | { kind: 'sending' }
  | { kind: 'verified'; photo: PublicPhoto }
  | { kind: 'not_verified'; message: string }
  | { kind: 'error'; title: string; message: string; action: ErrorAction };

/** After this long without an answer, the sheet says that a cancelled photo can still publish. */
const SLOW_AFTER_MS = 10_000;

function announcement(state: SheetState): string {
  switch (state.kind) {
    case 'sending':
      return 'Verifying the photo';
    case 'verified':
      return state.photo.isTest ? 'Test proof. This is not a real proof.' : 'Verified';
    case 'not_verified':
      return `Not verified. ${state.message}`;
    case 'error':
      return `${state.title}. ${state.message}`;
  }
}

/** The card over the frozen photo after the shutter: progress, then the answer. A modal for screen readers. */
export function ResultSheet({
  state,
  bottomInset,
  onShare,
  onDone,
  onRetry,
  onCancel,
  onDelete,
  onRestartCamera,
}: {
  state: SheetState;
  bottomInset: number;
  onShare: (photo: PublicPhoto) => Promise<void>;
  onDone: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onDelete: (photo: PublicPhoto) => Promise<void>;
  onRestartCamera: () => void;
}) {
  const rise = useRef(new Animated.Value(0)).current;
  // At the largest text sizes the card scrolls instead of running off the top of the screen.
  const maxCardHeight = useWindowDimensions().height * 0.85 - bottomInset;
  const [slow, setSlow] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const share = async (photo: PublicPhoto) => {
    setSharing(true);
    try {
      await onShare(photo);
    } catch {
      Alert.alert('Could Not Share', 'Check the connection and try again.');
    } finally {
      setSharing(false);
    }
  };

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (reduce) rise.setValue(1);
        else Animated.spring(rise, { toValue: 1, useNativeDriver: true, damping: 20, stiffness: 180 }).start();
      });
  }, [rise]);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement(state));
    setSlow(false);
    if (state.kind !== 'sending') return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Animated.View
      accessibilityViewIsModal
      style={[
        styles.wrap,
        { paddingBottom: bottomInset + 8 },
        { opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] },
      ]}
    >
      <ScrollView style={[styles.card, { maxHeight: maxCardHeight }]} contentContainerStyle={styles.cardContent} bounces={false}>
        {state.kind === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={p.label} size="large" />
            <Text style={[type.headline, styles.title]}>Verifying…</Text>
            <Text style={[type.subheadline, styles.text]}>We check the phone, the motion and the image. If the photo passes, it gets a public page.</Text>
            <View style={styles.actions}>
              <Button palette={p} variant="tinted" title="Cancel" onPress={onCancel} />
              <Text style={[type.footnote, styles.text, slow && styles.emphasis]}>
                If you cancel after the photo reached TrustPhoto, it can still get a public page. Look in Photos.
              </Text>
            </View>
          </View>
        ) : state.kind === 'verified' ? (
          <View style={styles.center}>
            <Icon name={state.photo.isTest ? 'info' : 'seal'} size={52} color={state.photo.isTest ? p.secondaryLabel : p.green} />
            <Text style={[type.title2, styles.title]}>{state.photo.isTest ? 'Test Proof' : 'Verified'}</Text>
            <Text style={[type.subheadline, styles.text]}>
              {state.photo.isTest
                ? 'A development build made this proof. It is not a real proof.'
                : FINDABLE_NOTE}
            </Text>
            <Text style={[type.footnote, styles.text]}>{state.photo.isTest ? TEST_PROOF_NOTE : PROOF_LIMITS}</Text>
            <View style={styles.actions}>
              {state.photo.isTest ? (
                <Button palette={p} title="Done" onPress={onDone} />
              ) : (
                <>
                  <Button palette={p} title="Share" icon="share" busy={sharing} onPress={() => share(state.photo)} />
                  <View style={styles.pair}>
                    <CopyButton palette={p} url={state.photo.url} style={styles.flex} />
                    <Button palette={p} variant="tinted" title="Done" onPress={onDone} style={styles.flex} />
                  </View>
                  <Button
                    palette={p}
                    variant="destructive"
                    title="Delete Photo"
                    icon="trash"
                    busy={deleting}
                    onPress={() =>
                      Alert.alert('Delete This Photo?', DELETE_CONFIRM, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            setDeleting(true);
                            try {
                              await onDelete(state.photo);
                            } catch {
                              Alert.alert('Could Not Delete', 'Check the connection and try again.');
                            } finally {
                              setDeleting(false);
                            }
                          },
                        },
                      ])
                    }
                  />
                </>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.center}>
            <Icon name="warning" size={52} color={state.kind === 'not_verified' ? p.orange : p.secondaryLabel} />
            <Text style={[type.title2, styles.title]}>{state.kind === 'not_verified' ? 'Not Verified' : state.title}</Text>
            <Text style={[type.subheadline, styles.text]}>{state.message}</Text>
            <View style={styles.actions}>
              {state.kind === 'error' && state.action === 'retry' ? (
                <>
                  <Button palette={p} title="Try Again" icon="retry" onPress={onRetry} />
                  <Button palette={p} variant="plain" title="Take a New Photo" onPress={onDone} />
                </>
              ) : state.kind === 'error' && state.action === 'ok' ? (
                <Button palette={p} title="OK" onPress={onDone} />
              ) : state.kind === 'error' && state.action === 'restart_camera' ? (
                <Button palette={p} title="Start Camera Again" icon="camera" onPress={onRestartCamera} />
              ) : (
                <Button palette={p} title="Take a New Photo" icon="camera" onPress={onDone} />
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 8, right: 8, bottom: 0 },
  card: { borderRadius: 32, backgroundColor: SHEET_BACKGROUND },
  cardContent: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 20 },
  center: { alignItems: 'center' },
  title: { color: p.label, marginTop: 14, textAlign: 'center' },
  text: { color: p.secondaryLabel, marginTop: 6, textAlign: 'center', maxWidth: 320 },
  emphasis: { color: p.label },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 22 },
  pair: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
});
