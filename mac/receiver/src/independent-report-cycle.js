/** Run both channels concurrently and retain each channel's failure independently. */
export async function runIndependentReportCycles({ weather, health }) {
  const [weatherResult, healthResult] = await Promise.all([
    Promise.resolve().then(weather).catch(() => ({ unavailable: 1 })),
    Promise.resolve().then(health).catch(() => ({ unavailable: 1 })),
  ]);
  return { weather: weatherResult, health: healthResult };
}
