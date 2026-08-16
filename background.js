// api2 is primary; the rest are fallbacks observed in WarEra's own bundle in case one host is down/rate-limited.
const API_HOSTS = ["api2", "api3", "api4", "api5", "api6"].map(
  (h) => `https://${h}.warera.io/trpc`
);

async function callApi(endpoint, params) {
  let lastError;
  for (const base of API_HOSTS) {
    try {
      const res = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("All API hosts failed");
}

// Generic passthrough so any feature can call any tRPC endpoint without background.js
// needing a dedicated function per endpoint.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "WARERA_INTEL_FETCH") {
    return callApi(message.endpoint, message.params);
  }
  return undefined;
});
