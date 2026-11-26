import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { usePalette } from '@/constants/theme';
import { getInstall } from '@/lib/install';
import { warmUpIntegrity } from '@/lib/integrity';

export default function RootLayout() {
  const palette = usePalette();

  // Register the install and start the one-time device-key setup before the first photo.
  useEffect(() => {
    getInstall()
      .then(warmUpIntegrity)
      .catch(() => undefined);
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerTintColor: palette.tint,
          headerStyle: { backgroundColor: palette.background },
          contentStyle: { backgroundColor: palette.background },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false, contentStyle: { backgroundColor: '#000' } }} />
        <Stack.Screen name="library" options={{ title: 'Photos', headerLargeTitle: true }} />
        <Stack.Screen name="photo/[id]" options={{ title: '' }} />
      </Stack>
    </>
  );
}
