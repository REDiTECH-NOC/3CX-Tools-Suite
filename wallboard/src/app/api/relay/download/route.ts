import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { cookies } from 'next/headers';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * GET /api/relay/download
 *
 * Serves the relay agent as a tar.gz archive for admin download.
 * Requires admin session authentication.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate via session cookie (admin only) ──
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get('wb_session')?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { token: sessionToken },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date() || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 });
  }

  // ── 2. Find relay agent files ──
  // In production Docker container, relay agent files are at /app/relay-agent/
  // In development, they're at ../relay-agent/ relative to app root
  const possiblePaths = [
    '/app/relay-agent',                                    // Docker container
    path.join(process.cwd(), '..', 'relay-agent'),         // Dev (monorepo sibling)
    path.join(process.cwd(), 'relay-agent'),               // Dev (nested)
  ];

  let agentDir: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'dist', 'index.js'))) {
      agentDir = p;
      break;
    }
  }

  if (!agentDir) {
    return NextResponse.json(
      { error: 'Relay agent build not found. Ensure the relay agent is built.' },
      { status: 404 }
    );
  }

  // ── 3. Build tar archive in memory ──
  // Simple tar format: header (512 bytes) + file data (padded to 512) per file
  const filesToInclude: { relativePath: string; absolutePath: string }[] = [];

  // Add dist/ JS files
  const distDir = path.join(agentDir, 'dist');
  for (const f of fs.readdirSync(distDir)) {
    if (f.endsWith('.js')) {
      filesToInclude.push({
        relativePath: `3cx-relay/dist/${f}`,
        absolutePath: path.join(distDir, f),
      });
    }
  }

  // Add package.json
  filesToInclude.push({
    relativePath: '3cx-relay/package.json',
    absolutePath: path.join(agentDir, 'package.json'),
  });

  // Add install.sh and uninstall.sh
  for (const script of ['install.sh', 'uninstall.sh']) {
    const scriptPath = path.join(agentDir, script);
    if (fs.existsSync(scriptPath)) {
      filesToInclude.push({
        relativePath: `3cx-relay/${script}`,
        absolutePath: scriptPath,
      });
    }
  }

  // Build tar buffer
  const tarChunks: Buffer[] = [];

  for (const file of filesToInclude) {
    const content = fs.readFileSync(file.absolutePath);
    const header = createTarHeader(file.relativePath, content.length, file.relativePath.endsWith('.sh'));
    tarChunks.push(header);
    tarChunks.push(content);

    // Pad to 512-byte boundary
    const padding = 512 - (content.length % 512);
    if (padding < 512) {
      tarChunks.push(Buffer.alloc(padding, 0));
    }
  }

  // End-of-archive marker (two 512-byte zero blocks)
  tarChunks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(tarChunks);

  // Gzip compress
  const gzipped = zlib.gzipSync(tarBuffer);

  // ── 4. Return as download ──
  return new NextResponse(gzipped, {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': 'attachment; filename="3cx-relay-agent.tar.gz"',
      'Content-Length': String(gzipped.length),
    },
  });
}

/**
 * Create a POSIX tar header (512 bytes) for a file entry.
 */
function createTarHeader(name: string, size: number, executable: boolean): Buffer {
  const header = Buffer.alloc(512, 0);

  // Name (0-99)
  header.write(name.substring(0, 100), 0, 100, 'utf8');
  // Mode (100-107): 0755 for executable, 0644 for regular
  header.write(executable ? '0000755\0' : '0000644\0', 100, 8, 'utf8');
  // UID (108-115)
  header.write('0001000\0', 108, 8, 'utf8');
  // GID (116-123)
  header.write('0001000\0', 116, 8, 'utf8');
  // Size (124-135) — octal
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  // Mtime (136-147) — current time in octal
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  // Checksum placeholder (148-155) — spaces for initial calculation
  header.write('        ', 148, 8, 'utf8');
  // Type flag (156): '0' = regular file
  header.write('0', 156, 1, 'utf8');
  // USTAR magic (257-262)
  header.write('ustar\0', 257, 6, 'utf8');
  // USTAR version (263-264)
  header.write('00', 263, 2, 'utf8');

  // Calculate and write checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  return header;
}

export const dynamic = 'force-dynamic';
