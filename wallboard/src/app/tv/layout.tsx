/**
 * TV mode layout -- bare-bones wrapper.
 * No header, no nav, no auth chrome. Just the providers needed for
 * tRPC and SSE to function.
 *
 * Authentication is still enforced by the SSE endpoint and tRPC middleware,
 * so unauthenticated users will be redirected by the hooks.
 */
export default function TVLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
