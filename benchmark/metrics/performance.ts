export interface PercentileResult {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

export function computePercentiles(values: number[]): PercentileResult {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    mean: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
