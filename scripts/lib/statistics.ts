export function nearestRankPercentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
  );
}
