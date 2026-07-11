const githubWebhookPath = "/webhooks/github";
const githubSignaturePrefix = "sha256=";
const sha256ByteLength = 32;

function decodeSignature(header: string): Uint8Array | undefined {
  if (!header.startsWith(githubSignaturePrefix)) {
    return undefined;
  }

  const hex = header.slice(githubSignaturePrefix.length);
  if (hex.length !== sha256ByteLength * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    return undefined;
  }

  return Uint8Array.from({ length: sha256ByteLength }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

async function hasValidSignature(
  body: ArrayBuffer,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (header === null) {
    return false;
  }

  const supplied = decodeSignature(header);
  if (supplied === undefined) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, body);
  return crypto.subtle.timingSafeEqual(expected, supplied);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== githubWebhookPath) {
      return new Response(null, { status: 404 });
    }

    const body = await request.arrayBuffer();
    const valid = await hasValidSignature(
      body,
      request.headers.get("X-Hub-Signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    );
    if (!valid) {
      return new Response(null, { status: 401 });
    }

    return new Response(null, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
