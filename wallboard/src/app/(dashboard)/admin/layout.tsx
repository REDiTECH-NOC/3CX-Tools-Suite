'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Gauge, Settings, Users, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/admin/queues', label: 'Queues', icon: LayoutGrid },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
  { href: '/admin/users', label: 'Users', icon: Users },
] as const;

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* ── Sidebar (desktop) / Top tabs (mobile) ── */}
      <aside className="shrink-0 border-b border-border/50 bg-card/20 lg:w-52 lg:border-b-0 lg:border-r">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 lg:flex-col lg:items-start lg:gap-1 lg:px-4 lg:py-4">
          <h2 className="text-sm font-semibold text-foreground">Admin</h2>
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden lg:inline">Back to Wallboard</span>
            <span className="lg:hidden">Wallboard</span>
          </Link>
        </div>

        {/* Nav links — horizontal on mobile, vertical on desktop */}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:flex-col lg:px-3 lg:pb-4">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap">{label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* ── Content area ── */}
      <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
    </div>
  );
}
