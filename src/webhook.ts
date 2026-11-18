import { createHash, createHmac } from 'node:crypto';
import { ensure, type OutboundDelivery, type WebhookTarget } from './contracts.js';

/** One operator-owned destination; delivery records never carry credentials or URLs. */
export class SignedWebhook implements WebhookTarget {
  readonly fingerprint: string;
  #url: string;
  #secret: string;
  constructor(url: string, secret: string) {
    let target: URL | undefined;
    try {
      target = new URL(url);
    } catch {
      /* Report configuration errors without echoing secrets. */
    }
    ensure(
      target &&
        !target.username &&
        !target.password &&
        !url.includes('#') &&
        (target.protocol === 'https:' ||
          (target.protocol === 'http:' &&
            /^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(url))),
      'INVALID_CONFIG',
      'Webhook URL requires HTTPS or literal loopback HTTP, without credentials or fragments.',
    );
    ensure(
      Buffer.byteLength(secret) >= 32,
      'INVALID_CONFIG',
      'Webhook signing secret must contain at least 32 bytes.',
    );
    this.#url = target.href;
    this.#secret = secret;
    this.fingerprint = createHash('sha256').update(this.#url).digest('hex');
  }
  async send(delivery: OutboundDelivery): Promise<{ error_code: string } | undefined> {
    if (delivery.target_fingerprint !== this.fingerprint) return { error_code: 'TARGET_MISMATCH' };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.#secret)
      .update(`${timestamp}.${delivery.body}`)
      .digest('hex');
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          'X-Ticketing-Delivery': delivery.id,
          'X-Ticketing-Timestamp': timestamp,
          'X-Ticketing-Signature': `sha256=${signature}`,
        },
        body: delivery.body,
      });
      void response.body?.cancel().catch(() => {});
      return response.ok ? undefined : { error_code: `HTTP_${response.status}` };
    } catch (error) {
      return {
        error_code:
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'TIMEOUT'
            : 'NETWORK_ERROR',
      };
    }
  }
}
