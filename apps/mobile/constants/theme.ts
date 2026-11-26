import { useColorScheme } from 'react-native';

/**
 * iOS system colors, with the blue, the grey text and the green darkened
 * (light) or lightened (dark) until text meets WCAG 2.2 AA (4.5:1) on its
 * real background, including the tinted button fill.
 */
const light = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  label: '#000000',
  secondaryLabel: '#5E5E63',
  separator: 'rgba(60,60,67,0.29)',
  fill: 'rgba(120,120,128,0.12)',
  /** Blue for text and icons. */
  tint: '#0040DD',
  /** Blue behind white button text. */
  button: '#0071E3',
  green: '#146C2E',
  greenFill: 'rgba(52,199,89,0.15)',
  red: '#D70015',
  orange: '#C93400',
};

const dark: typeof light = {
  background: '#000000',
  surface: '#1C1C1E',
  label: '#FFFFFF',
  secondaryLabel: 'rgba(235,235,245,0.6)',
  separator: 'rgba(84,84,88,0.65)',
  fill: 'rgba(120,120,128,0.24)',
  tint: '#64B0FF',
  button: '#0071E3',
  green: '#30D158',
  greenFill: 'rgba(48,209,88,0.18)',
  red: '#FF6961',
  orange: '#FF9F0A',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** The camera is always dark, like the system camera. */
export const cameraPalette = dark;

/** Behind the result sheet: almost opaque, so its text keeps its contrast over any photo. */
export const SHEET_BACKGROUND = 'rgba(28,28,30,0.94)';

/** iOS text styles (points). */
export const type = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, letterSpacing: 0.37 },
  title2: { fontSize: 22, fontWeight: '700' as const, letterSpacing: 0.35 },
  title3: { fontSize: 20, fontWeight: '600' as const, letterSpacing: 0.38 },
  headline: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.41 },
  body: { fontSize: 17, fontWeight: '400' as const, letterSpacing: -0.41 },
  subheadline: { fontSize: 15, fontWeight: '400' as const, letterSpacing: -0.24 },
  footnote: { fontSize: 13, fontWeight: '400' as const, letterSpacing: -0.08 },
};
