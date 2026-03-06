'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Loader2,
  Save,
  TestTube2,
  CheckCircle2,
  XCircle,
  Key,
  Wifi,
  WifiOff,
  Copy,
  AlertTriangle,
  Download,
  Radio,
} from 'lucide-react';

// Average wait window options
const AVG_WAIT_OPTIONS = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
  { value: '480', label: '8 hours' },
  { value: '720', label: '12 hours' },
  { value: '1440', label: '24 hours' },
];

export default function AdminSettingsPage() {
  const utils = trpc.useUtils();
  const {
    data: settings,
    isLoading,
    isError,
  } = trpc.admin.getSettings.useQuery();
  const { data: relayStatus } = trpc.admin.getRelayStatus.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  // ── PBX Connection form state ──
  const [pbxUrl, setPbxUrl] = useState('');
  const [extensionNumber, setExtensionNumber] = useState('');
  const [password, setPassword] = useState('');
  const [pbxDirty, setPbxDirty] = useState(false);

  // ── Polling form state ──
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);
  const [avgWaitWindow, setAvgWaitWindow] = useState('60');
  const [pollingDirty, setPollingDirty] = useState(false);

  // ── Connection test ──
  const [testResult, setTestResult] = useState<{
    success: boolean;
    latencyMs: number;
  } | null>(null);

  // ── Save feedback ──
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // ── Relay key generation ──
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [showKeyDialog, setShowKeyDialog] = useState(false);

  // Populate form from settings
  useEffect(() => {
    if (settings) {
      setPbxUrl(settings.pbxUrl);
      setExtensionNumber(settings.extensionNumber);
      setPollIntervalMs(settings.pollIntervalMs);
      setAvgWaitWindow(String(settings.avgWaitWindowMinutes));
    }
  }, [settings]);

  // ── Mutations ──
  const updateSettingsMutation = trpc.admin.updateSettings.useMutation({
    onSuccess: () => {
      utils.admin.getSettings.invalidate();
      setPbxDirty(false);
      setPollingDirty(false);
      setPassword('');
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
    onError: (err) => {
      console.error('[Settings] Save failed:', err.message);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 5000);
    },
  });

  const testConnectionMutation = trpc.admin.testConnection.useMutation({
    onSuccess: (result) => setTestResult(result),
    onError: () => setTestResult({ success: false, latencyMs: 0 }),
  });

  const generateKeyMutation = trpc.admin.generateRelayKey.useMutation({
    onSuccess: (result) => {
      setGeneratedKey(result.key);
      utils.admin.getRelayStatus.invalidate();
    },
  });

  // ── Handlers ──
  function handleSavePbx() {
    const data: Record<string, string> = {};
    if (pbxUrl !== settings?.pbxUrl) data.pbxUrl = pbxUrl;
    if (extensionNumber !== settings?.extensionNumber)
      data.extensionNumber = extensionNumber;
    if (password) data.password = password;

    if (Object.keys(data).length > 0) {
      updateSettingsMutation.mutate(data as any);
    }
  }

  function handleSavePolling() {
    const data: Record<string, number> = {};
    if (pollIntervalMs !== settings?.pollIntervalMs)
      data.pollIntervalMs = pollIntervalMs;
    const windowNum = parseInt(avgWaitWindow, 10);
    if (windowNum !== settings?.avgWaitWindowMinutes)
      data.avgWaitWindowMinutes = windowNum;

    if (Object.keys(data).length > 0) {
      updateSettingsMutation.mutate(data as any);
    }
  }

  function handleGenerateKey() {
    generateKeyMutation.mutate();
  }

  function handleCopyKey() {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 3000);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load settings. Check your connection and try again.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          PBX connection, polling configuration, and relay agent management.
        </p>
      </div>

      {/* ── PBX Connection ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">PBX Connection</CardTitle>
          <CardDescription>
            3CX Web Client API credentials. Used for polling queue data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pbxUrl">PBX URL</Label>
              <Input
                id="pbxUrl"
                value={pbxUrl}
                onChange={(e) => {
                  setPbxUrl(e.target.value);
                  setPbxDirty(true);
                }}
                placeholder="customer.my3cx.us"
              />
              <p className="text-[11px] text-muted-foreground">
                FQDN without https:// prefix
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="extension">Extension Number</Label>
              <Input
                id="extension"
                value={extensionNumber}
                onChange={(e) => {
                  setExtensionNumber(e.target.value);
                  setPbxDirty(true);
                }}
                placeholder="100"
              />
              <p className="text-[11px] text-muted-foreground">
                System Owner extension for API auth
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPbxDirty(true);
              }}
              placeholder={settings?.hasPassword ? '••••••••' : 'Enter password'}
            />
            <p className="text-[11px] text-muted-foreground">
              {settings?.hasPassword
                ? 'Leave blank to keep current password'
                : 'Web client password for the extension'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={handleSavePbx}
              disabled={!pbxDirty || updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-2 h-3.5 w-3.5" />
              )}
              Save Connection
            </Button>
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1 text-sm text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-400">
                <XCircle className="h-3.5 w-3.5" /> Save failed
              </span>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTestResult(null);
                testConnectionMutation.mutate();
              }}
              disabled={testConnectionMutation.isPending}
            >
              {testConnectionMutation.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <TestTube2 className="mr-2 h-3.5 w-3.5" />
              )}
              Test Connection
            </Button>

            {/* Test result */}
            {testResult && (
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-sm text-green-500">
                      Connected ({testResult.latencyMs}ms)
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 text-red-500" />
                    <span className="text-sm text-red-500">
                      Connection failed
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Polling Settings ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Polling Settings</CardTitle>
          <CardDescription>
            Controls how frequently the wallboard fetches data from 3CX.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Poll Interval */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Poll Interval</Label>
              <span className="font-mono text-sm text-muted-foreground">
                {pollIntervalMs / 1000}s
              </span>
            </div>
            <Slider
              value={[pollIntervalMs]}
              onValueChange={([val]) => {
                setPollIntervalMs(val);
                setPollingDirty(true);
              }}
              min={5000}
              max={60000}
              step={5000}
              className="w-full"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>5s</span>
              <span>30s</span>
              <span>60s</span>
            </div>
          </div>

          {/* Average Wait Window */}
          <div className="space-y-1.5">
            <Label>Average Wait Window</Label>
            <Select
              value={avgWaitWindow}
              onValueChange={(val) => {
                setAvgWaitWindow(val);
                setPollingDirty(true);
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVG_WAIT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Rolling window for the adjustable average wait time calculation.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleSavePolling}
              disabled={!pollingDirty || updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-2 h-3.5 w-3.5" />
              )}
              Save Polling Settings
            </Button>
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1 text-sm text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-400">
                <XCircle className="h-3.5 w-3.5" /> Save failed
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Relay Agent ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Relay Agent</CardTitle>
          <CardDescription>
            Install a lightweight agent on the PBX for true real-time data.
            When connected, the wallboard switches to LIVE mode automatically.
            Falls back to polling if the agent disconnects.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {relayStatus?.connected ? (
                <>
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                  </span>
                  <Badge variant="default" className="bg-emerald-600 font-normal hover:bg-emerald-600">
                    <Radio className="mr-1 h-3 w-3" />
                    Live
                  </Badge>
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4 text-muted-foreground" />
                  <Badge variant="secondary" className="font-normal">
                    {relayStatus?.configured ? 'Disconnected' : 'Not Configured'}
                  </Badge>
                </>
              )}
            </div>
            {relayStatus?.lastHeartbeat && (
              <span className="text-xs text-muted-foreground">
                Last heartbeat:{' '}
                {new Date(relayStatus.lastHeartbeat).toLocaleString()}
              </span>
            )}
            {relayStatus?.lastIp && (
              <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {relayStatus.lastIp}
              </span>
            )}
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label>API Key</Label>
            <div className="flex items-center gap-3">
              {relayStatus?.apiKeyPrefix ? (
                <div className="flex h-10 flex-1 items-center rounded-md border border-input bg-muted/50 px-3 font-mono text-sm">
                  {relayStatus.apiKeyPrefix}
                  {'••••••••••••••••••••'}
                </div>
              ) : (
                <div className="flex h-10 flex-1 items-center rounded-md border border-input bg-muted/50 px-3 text-sm text-muted-foreground">
                  No key generated
                </div>
              )}

              <Dialog open={showKeyDialog} onOpenChange={setShowKeyDialog}>
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setGeneratedKey(null);
                      setKeyCopied(false);
                      setShowKeyDialog(true);
                    }}
                  >
                    <Key className="mr-2 h-3.5 w-3.5" />
                    {relayStatus?.apiKeyPrefix
                      ? 'Regenerate Key'
                      : 'Generate Key'}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {generatedKey
                        ? 'Relay API Key Generated'
                        : 'Generate New Relay Key'}
                    </DialogTitle>
                    <DialogDescription>
                      {generatedKey
                        ? 'Copy this key now. It will not be shown again.'
                        : 'This will invalidate any existing relay API key. The relay agent will need to be reconfigured.'}
                    </DialogDescription>
                  </DialogHeader>

                  {generatedKey ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 overflow-hidden rounded-md border bg-muted/50 p-3 font-mono text-xs break-all">
                          {generatedKey}
                        </div>
                        <Button
                          size="icon"
                          variant="outline"
                          onClick={handleCopyKey}
                          className="shrink-0"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      {keyCopied && (
                        <p className="flex items-center gap-1 text-xs text-green-500">
                          <CheckCircle2 className="h-3 w-3" />
                          Copied to clipboard
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                      <span>
                        Generating a new key will immediately disconnect any
                        relay agent using the current key.
                      </span>
                    </div>
                  )}

                  <DialogFooter>
                    {generatedKey ? (
                      <Button
                        variant="outline"
                        onClick={() => setShowKeyDialog(false)}
                      >
                        Done
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => setShowKeyDialog(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleGenerateKey}
                          disabled={generateKeyMutation.isPending}
                        >
                          {generateKeyMutation.isPending ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Key className="mr-2 h-3.5 w-3.5" />
                          )}
                          Generate Key
                        </Button>
                      </>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Download + Install instructions */}
          <div className="rounded-md border border-border/50 bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-medium">Installation</h4>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  window.open('/api/relay/download', '_blank');
                }}
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                Download Agent
              </Button>
            </div>
            <ol className="space-y-1.5 text-xs text-muted-foreground">
              <li>
                1. Generate an API key above and copy it securely.
              </li>
              <li>
                2. Download the relay agent and transfer to the PBX server.
              </li>
              <li>
                3. Extract and run the installer:
              </li>
            </ol>
            <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
{`tar -xzf 3cx-relay-agent.tar.gz
cd 3cx-relay
sudo bash install.sh \\
  --wallboard-url https://your-wallboard:4200 \\
  --api-key <your-api-key> \\
  --pbx-url https://localhost:5001 \\
  --pbx-ext 1000 \\
  --pbx-pass <extension-password>`}
            </pre>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <p>
                The agent installs as a systemd service and pushes data every 2s.
              </p>
              <p>
                Logs: <code className="rounded bg-muted px-1 py-0.5">journalctl -u 3cx-relay -f</code>
              </p>
              <p>
                Uninstall: <code className="rounded bg-muted px-1 py-0.5">sudo bash /opt/3cx-relay/uninstall.sh</code>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
