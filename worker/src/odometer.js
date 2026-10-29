import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  properties: {
    readable: { type: "boolean", description: "true if the total odometer value can be read" },
    odometer_km: { type: "integer", description: "Total odometer value as shown, -1 if not readable" },
    unit: { type: "string", enum: ["km", "mi", "unknown"] },
    dashboard_class: { type: "string", enum: ["car", "motorcycle", "scooter", "unknown"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string", description: "Short remark, e.g. glare, trip meter also visible. Empty if none." },
  },
  required: ["readable", "odometer_km", "unit", "dashboard_class", "confidence", "note"],
  additionalProperties: false,
};

const PROMPT = `This photo shows the instrument cluster of a vehicle, taken to log a ride.
Read the TOTAL odometer (ODO), not a trip meter (TRIP, TRIP A/B, or a value with a decimal that resets).
If both are visible, return the total odometer. Ignore the decimal digit if the odometer shows tenths.
Also classify the dashboard: "car", "motorcycle" or "scooter" (for example a Vespa or other step-through scooter).
If you cannot read the odometer with reasonable certainty, set readable to false and odometer_km to -1.`;

export async function readOdometer(env, base64Jpeg) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { readable: false, odometer_km: -1, unit: "unknown", dashboard_class: "unknown", confidence: "low", note: "Photo could not be processed." };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`No reading returned (stop_reason: ${response.stop_reason})`);
  const result = JSON.parse(text);
  if (result.unit === "mi" && result.odometer_km > 0) {
    result.note = [result.note, "Dashboard shows miles."].filter(Boolean).join(" ");
  }
  return result;
}
