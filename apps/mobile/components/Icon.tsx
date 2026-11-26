import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';

/** One name per icon: SF Symbols on iOS, Material Symbols on Android. */
const ICONS = {
  seal: { ios: 'checkmark.seal.fill', android: 'verified' },
  warning: { ios: 'exclamationmark.circle.fill', android: 'error' },
  flip: { ios: 'arrow.triangle.2.circlepath', android: 'cameraswitch' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  safari: { ios: 'safari', android: 'open_in_browser' },
  trash: { ios: 'trash', android: 'delete' },
  camera: { ios: 'camera.fill', android: 'photo_camera' },
  photos: { ios: 'photo.on.rectangle', android: 'photo_library' },
  info: { ios: 'info.circle.fill', android: 'info' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
} as const satisfies Record<string, Extract<SymbolViewProps['name'], object>>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color, weight = 'regular' }: { name: IconName; size?: number; color: ColorValue; weight?: 'regular' | 'semibold' }) {
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" />;
}
