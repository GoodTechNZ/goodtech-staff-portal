// Minimal Deno globals so `npm run typecheck` can check the edge function without Deno installed.
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
