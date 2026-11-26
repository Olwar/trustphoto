import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CHECK_LABELS, DELETE_CONFIRM, DELETE_NOTE, FINDABLE_NOTE, INCONCLUSIVE_NOTE, PROOF_LIMITS, TEST_PROOF_NOTE } from '@trustphoto/shared';
import { Button } from '@/components/Button';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/components/Icon';
import { type, usePalette } from '@/constants/theme';
import { deletePhoto, usePhotos } from '@/lib/photos';
import { formatDate } from '@/lib/format';
import { sharePhoto } from '@/lib/share';

export default function PhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const listed = usePhotos().photos.find((p) => p.id === id);
  // Kept while the screen slides away after a delete, so it never flashes "not available".
  const [kept, setKept] = useState(listed);
  if (listed && listed !== kept) setKept(listed);
  const photo = listed ?? kept;
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);

  if (!photo) {
    return (
      <View style={[styles.missing, { backgroundColor: palette.background }]}>
        <Text style={[type.body, { color: palette.secondaryLabel }]}>This photo is not available.</Text>
      </View>
    );
  }

  const share = async () => {
    setSharing(true);
    try {
      await sharePhoto(photo);
    } catch {
      Alert.alert('Could Not Share', 'Check the connection and try again.');
    } finally {
      setSharing(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete This Photo?', DELETE_CONFIRM, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            await deletePhoto(photo.id);
            router.back();
          } catch {
            setDeleting(false);
            Alert.alert('Could Not Delete', 'Check the connection and try again.');
          }
        },
      },
    ]);

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      {photo.isTest ? null : (
        <Stack.Screen
          options={{
            headerRight: () => (
              <Pressable accessibilityRole="button" accessibilityLabel="Share" disabled={sharing} onPress={share} hitSlop={12} style={({ pressed }) => ({ opacity: pressed || sharing ? 0.5 : 1 })}>
                <Icon name="share" size={22} color={palette.tint} />
              </Pressable>
            ),
          }}
        />
      )}
      <Image
        source={{ uri: photo.imageUrl }}
        style={{ width: '100%', aspectRatio: photo.width / photo.height, backgroundColor: palette.fill }}
        contentFit="contain"
        accessibilityLabel={photo.isTest ? 'The photo of this test proof' : 'The photo of this proof'}
      />

      <View style={styles.body}>
        <View style={[styles.badge, { backgroundColor: photo.isTest ? palette.fill : palette.greenFill }]}>
          <Icon name={photo.isTest ? 'info' : 'seal'} size={16} color={photo.isTest ? palette.secondaryLabel : palette.green} />
          <Text style={[type.subheadline, styles.badgeText, { color: photo.isTest ? palette.secondaryLabel : palette.green }]}>
            {photo.isTest ? 'Test Proof' : 'Verified'}
          </Text>
        </View>
        <Text style={[type.title2, { color: palette.label }]}>
          {photo.isTest ? 'This is not a real proof.' : 'A phone camera took this photo.'}
        </Text>

        <View style={[styles.group, { backgroundColor: palette.surface }]}>
          <Row label="Received" value={formatDate(photo.receivedAt)} palette={palette} />
          {photo.device ? <Row label="Phone" value={photo.device} palette={palette} separator /> : null}
          {photo.checks.map((c) => (
            <Row
              key={c.key}
              label={CHECK_LABELS[c.key]}
              value={c.state === 'passed' ? 'Passed' : photo.isTest && c.key === 'device' ? 'Did not run' : 'No clear result'}
              palette={palette}
              separator
            />
          ))}
        </View>

        {photo.isTest ? (
          <Text style={[type.footnote, { color: palette.secondaryLabel }]}>{TEST_PROOF_NOTE}</Text>
        ) : photo.checks.some((c) => c.state !== 'passed') ? (
          <Text style={[type.footnote, { color: palette.secondaryLabel }]}>{INCONCLUSIVE_NOTE}</Text>
        ) : null}
        <Text style={[type.footnote, { color: palette.secondaryLabel }]}>
          {PROOF_LIMITS} {FINDABLE_NOTE}
        </Text>

        <View style={styles.actions}>
          {photo.isTest ? null : <CopyButton palette={palette} url={photo.url} />}
          <Button palette={palette} variant="tinted" title="Open Proof Page" icon="safari" onPress={() => WebBrowser.openBrowserAsync(photo.url)} />
        </View>

        <View style={styles.deleteBlock}>
          <Button palette={palette} variant="destructive" title="Delete Photo" icon="trash" busy={deleting} onPress={confirmDelete} />
          <Text style={[type.footnote, styles.center, { color: palette.secondaryLabel }]}>{DELETE_NOTE}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, palette, separator }: { label: string; value: string; palette: ReturnType<typeof usePalette>; separator?: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={[styles.row, separator && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator }]}
    >
      <Text style={[type.body, { color: palette.label }]}>{label}</Text>
      <Text style={[type.body, styles.value, { color: palette.secondaryLabel }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 16 },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { fontWeight: '600' },
  group: { borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, columnGap: 12, rowGap: 2 },
  value: { flexShrink: 1, textAlign: 'right' },
  actions: { gap: 10, marginTop: 4 },
  deleteBlock: { gap: 8, marginTop: 24 },
  center: { textAlign: 'center' },
});
