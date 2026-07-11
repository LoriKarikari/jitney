/**
 * Jitney control plane entrypoint. The ingress Worker route, Scheduler
 * Durable Object, and runner Container Durable Objects land with the native
 * spike; until then every request is answered with 404.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
