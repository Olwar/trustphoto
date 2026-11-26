import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { File, Paths } from 'expo-file-system';
import { AccessibilityInfo, Platform, Share } from 'react-native';
import type { PublicPhoto } from '@trustphoto/shared';

/**
 * iOS: the public copy of the photo (no location data) and its link in one
 * sheet, which also offers Save Image.
 * Android: the link as text. Neither React Native's Share nor expo-sharing
 * sends a file and text together there; the link preview shows the photo.
 */
export async function sharePhoto(photo: PublicPhoto): Promise<void> {
  if (Platform.OS === 'ios') {
    const file = await File.downloadFileAsync(photo.imageUrl, new File(Paths.cache, `trustphoto-${photo.id}.jpg`), { idempotent: true });
    await Share.share({ url: file.uri, message: photo.url });
  } else {
    await Share.share({ message: photo.url });
  }
}

export async function copyLink(url: string): Promise<void> {
  await Clipboard.setStringAsync(url);
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  AccessibilityInfo.announceForAccessibility('Link copied');
}
