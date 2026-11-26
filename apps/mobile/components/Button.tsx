import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { type, type Palette } from '@/constants/theme';

type Variant = 'filled' | 'tinted' | 'plain' | 'destructive';

/** iOS-style button: filled (primary), tinted (secondary), plain (text) or destructive (red text). */
export function Button({
  title,
  onPress,
  palette,
  variant = 'filled',
  icon,
  busy = false,
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  palette: Palette;
  variant?: Variant;
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const color = variant === 'filled' ? '#FFFFFF' : variant === 'destructive' ? palette.red : palette.tint;
  const background = variant === 'filled' ? palette.button : variant === 'tinted' ? palette.fill : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.base, { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, style]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <View style={styles.row}>
          {icon ? <Icon name={icon} size={18} color={color} weight="semibold" /> : null}
          <Text style={[type.headline, styles.label, { color }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { textAlign: 'center', flexShrink: 1 },
});
