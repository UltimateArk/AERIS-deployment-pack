export interface ChannelDef {
  key: string;
  label: string;
  unit: string;
  nominal: number;
  noise: number;
  decimals?: number;
// Soft envelope. Absolute value or delta.
  warn?: number;
  crit?: number;
}

// Channel keys and units from engine model limits. Warn and crit drive tile colors.
export const CHANNELS: ChannelDef[] = [
  { key: "rpm", label: "RPM", unit: "rpm", nominal: 5500, noise: 22, decimals: 0, warn: 8000, crit: 9500 },
  { key: "cht", label: "CHT", unit: "°C", nominal: 234, noise: 1.4, decimals: 0, warn: 260, crit: 280 },
  { key: "egt", label: "EGT", unit: "°C", nominal: 558, noise: 4, decimals: 0, warn: 750, crit: 850 },
  { key: "egt1", label: "EGT1", unit: "°C", nominal: 558, noise: 4, decimals: 0 },
  { key: "egt2", label: "EGT2", unit: "°C", nominal: 558, noise: 4, decimals: 0 },
  { key: "egt3", label: "EGT3", unit: "°C", nominal: 558, noise: 4, decimals: 0 },
  { key: "egt4", label: "EGT4", unit: "°C", nominal: 558, noise: 4, decimals: 0 },
  { key: "egtSpread", label: "EGT SPREAD", unit: "°C", nominal: 5, noise: 2, decimals: 0, warn: 60, crit: 90 },
  { key: "map", label: "MAP", unit: "bar", nominal: 1.24, noise: 0.01, decimals: 2 },
  { key: "oilPressure", label: "OIL PRESS", unit: "bar", nominal: 3.69, noise: 0.05, decimals: 2, warn: 1.5, crit: 1.2 },
  { key: "oilTemp", label: "OIL TEMP", unit: "°C", nominal: 94, noise: 0.6, decimals: 0, warn: 115, crit: 130 },
  { key: "fuelFlow", label: "FUEL FLOW", unit: "g/s", nominal: 3.0, noise: 0.08, decimals: 2 },
  { key: "vibX", label: "VIB X", unit: "g", nominal: 0.13, noise: 0.01, decimals: 3, warn: 0.3, crit: 0.4 },
  { key: "vibY", label: "VIB Y", unit: "g", nominal: 0.13, noise: 0.01, decimals: 3, warn: 0.3, crit: 0.4 },
  { key: "vibZ", label: "VIB Z", unit: "g", nominal: 0.13, noise: 0.01, decimals: 3, warn: 0.3, crit: 0.4 },
  { key: "vibRMS", label: "VIB RMS", unit: "g", nominal: 0.13, noise: 0.01, decimals: 3, warn: 0.3, crit: 0.4 },
  { key: "battV", label: "BATT V", unit: "V", nominal: 28.4, noise: 0.06, decimals: 1, warn: 24, crit: 22 },
  { key: "altA", label: "ALT A", unit: "A", nominal: 12.5, noise: 0.3, decimals: 1 },
  { key: "injTiming", label: "INJ TIMING", unit: "°BTDC", nominal: 20, noise: 0.15, decimals: 1 },
  { key: "powerKw", label: "POWER", unit: "kW", nominal: 42, noise: 0.4, decimals: 1 },
];

export const CHANNEL_BY_KEY: Record<string, ChannelDef> = Object.fromEntries(
  CHANNELS.map((c) => [c.key, c]),
);

export type Sample = Record<string, number> & { t: number };

export interface Controls {
  rpm: number; // 0..10000
  load: number; // 0..100 %
  afr: number; // 12..16
  cooling: number; // 0..1
  injTiming: number; // 10..30 deg
  altitude: number; // 0..15000 ft
  ambientT: number; // -20..55 C
  humidity: number; // 0..100 %
}

export const DEFAULT_CONTROLS: Controls = {
  rpm: 5500,
  load: 60,
  afr: 14.7,
  cooling: 1,
  injTiming: 20,
  altitude: 0,
  ambientT: 15,
  humidity: 30,
};

export interface EngineState {
  running: boolean;
  activeFaults: string[];
  controls: Controls;
}
