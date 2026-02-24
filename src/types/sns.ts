import { z } from "zod";

/** SNS message attribute value (Type + Value). */
const snsMessageAttributeValue = z.object({
  Type: z.string(),
  Value: z.string(),
});

/** SNS Notification envelope (when SNS delivers to SQS, the SQS message body is this). */
export const snsNotificationEnvelopeSchema = z.object({
  Type: z.literal("Notification"),
  MessageId: z.string(),
  TopicArn: z.string().optional(),
  Subject: z.string().optional(),
  Message: z.string(),
  Timestamp: z.string().optional(),
  MessageAttributes: z.record(snsMessageAttributeValue).optional(),
  UnsubscribeURL: z.string().optional(),
  SigningCertURL: z.string().optional(),
  Signature: z.string().optional(),
});

export type SnsNotificationEnvelope = z.infer<typeof snsNotificationEnvelopeSchema>;

/** SQS message body when SNS is the producer: same as SNS envelope. */
export const sqsSnsMessageBodySchema = snsNotificationEnvelopeSchema;

export type SqsSnsMessageBody = z.infer<typeof sqsSnsMessageBodySchema>;

/** Parse SQS message body (may be string or already object). */
export function parseSqsSnsBody(raw: unknown): SnsNotificationEnvelope | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const result = snsNotificationEnvelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}
