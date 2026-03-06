import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'wb_session';

// Routes that require authentication
const PROTECTED_PREFIXES = ['/wallboard', '/admin', '/tv'];

// Routes that are always public
const PUBLIC_PATHS = ['/login', '/setup'];

// API routes that handle their own auth (tRPC via session, relay via API key)
const API_PUBLIC_PREFIXES = ['/api/trpc', '/api/relay'];

// API routes that need session cookie presence
const API_AUTH_PREFIXES = ['/api/sse'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  // Let tRPC handle its own auth
  if (API_PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // API routes that require session cookie
  if (API_AUTH_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!hasSession) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // If on login page and already has session, redirect to wallboard
  if (pathname === '/login' && hasSession) {
    return NextResponse.redirect(new URL('/wallboard', request.url));
  }

  // Public paths — allow through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Protected routes — require session cookie
  if (PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!hasSession) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return NextResponse.next();
  }

  // Everything else (root /, static files, etc.) — pass through
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder files
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
