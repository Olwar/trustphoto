import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { router, Stack, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { API_URL } from '@/lib/api';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PublicPhoto } from '@trustphoto/shared';
import { Icon } from '@/components/Icon';
import { type, usePalette } from '@/constants/theme';
import { refreshPhotos, usePhotos } from '@/lib/photos';
import { formatDate } from '@/lib/format';

const COLUMNS = 3;
const GAP = 2;

export default function LibraryScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { photos, synced } = usePhotos();
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const size = (width - GAP * (COLUMNS - 1)) / COLUMNS;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshPhotos();
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Every time Photos opens: a photo can verify after the camera stopped waiting for it.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      refreshPhotos()
        .then(() => setFailed(false))
        .catch(() => setFailed(true))
        .finally(() => setLoading(false));
    }, []),
  );

  const renderItem = useCallback(
    ({ item }: { item: PublicPhoto }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Photo from ${formatDate(item.receivedAt)}`}
        onPress={() => router.push({ pathname: '/photo/[id]', params: { id: item.id } })}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <Image source={{ uri: item.imageUrl }} style={{ width: size, height: size, backgroundColor: palette.fill }} contentFit="cover" transition={120} recyclingKey={item.id} />
      </Pressable>
    ),
    [size, palette.fill],
  );

  return (
    <>
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Privacy and what a proof shows"
            hitSlop={12}
            onPress={() => WebBrowser.openBrowserAsync(`${API_URL}/privacy`)}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Icon name="info" size={22} color={palette.tint} />
          </Pressable>
        ),
      }}
    />
    <FlatList
      data={photos}
      keyExtractor={(p) => p.id}
      numColumns={COLUMNS}
      renderItem={renderItem}
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={[{ gap: GAP, paddingBottom: insets.bottom + 24 }, photos.length === 0 && styles.grow]}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      ListHeaderComponent={
        failed ? (
          <Text style={[type.footnote, styles.banner, { color: palette.secondaryLabel }]}>Could not update. Pull down to try again.</Text>
        ) : null
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          {!synced && (loading || refreshing) ? (
            <ActivityIndicator accessibilityLabel="Loading photos" />
          ) : (
            <>
              <Icon name="photos" size={48} color={palette.secondaryLabel} />
              <Text style={[type.title3, { color: palette.label }]}>{synced ? 'No Photos Yet' : 'Could Not Load Photos'}</Text>
              <Text style={[type.subheadline, styles.emptyText, { color: palette.secondaryLabel }]}>
                {synced ? 'Photos you verify appear here. Each one has a link you can share.' : 'Check the connection. Pull down to try again.'}
              </Text>
            </>
          )}
        </View>
      }
    />
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
  banner: { textAlign: 'center', paddingVertical: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40, paddingBottom: 80 },
  emptyText: { textAlign: 'center' },
});
