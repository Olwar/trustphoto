import { useEffect, useRef, useState } from 'react';
import { Alert, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from './Button';
import type { Palette } from '@/constants/theme';
import { copyLink } from '@/lib/share';

/** "Copy Link" that says "Copied" for two seconds, so the copy is visible as well as felt and heard. */
export function CopyButton({ url, palette, style }: { url: string; palette: Palette; style?: StyleProp<ViewStyle> }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <Button
      palette={palette}
      variant="tinted"
      title={copied ? 'Copied' : 'Copy Link'}
      icon="copy"
      style={style}
      onPress={async () => {
        try {
          await copyLink(url);
        } catch {
          Alert.alert('Could Not Copy', 'Try again, or use Share.');
          return;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      }}
    />
  );
}
