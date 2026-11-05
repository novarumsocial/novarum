const toDb = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-6));

export const rmsDb = (samples: Float32Array) => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return toDb(Math.sqrt(sum / samples.length));
};

// speech always has gaps, so the quietest tenth of recent frames is the room's noise floor.
// quiet rooms get a light touch that keeps the voice natural; loud ones get suppressed harder
export const autoAttenuation = (levelsDb: number[]) => {
  const sorted = [...levelsDb].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
  return Math.round(Math.min(50, Math.max(12, floor + 90)));
};
