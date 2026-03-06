'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Phone, CheckCircle2, Loader2, ArrowRight, Server } from 'lucide-react';

type Step = 1 | 2 | 3;

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [pbxUrl, setPbxUrl] = useState('');
  const [extensionNumber, setExtensionNumber] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const setupMutation = trpc.auth.setup.useMutation({
    onSuccess: () => {
      setStep(3);
      // Auto-redirect after a brief moment
      setTimeout(() => {
        router.push('/wallboard');
      }, 2000);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setupMutation.mutate({ pbxUrl, extensionNumber, password });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg">
        {/* Branding */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
            <Phone className="h-6 w-6 text-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            3CX Wallboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Initial setup wizard
          </p>
        </div>

        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  s < step
                    ? 'bg-green-600/20 text-green-400'
                    : s === step
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground'
                }`}
              >
                {s < step ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  s
                )}
              </div>
              {s < 3 && (
                <div
                  className={`h-px w-12 transition-colors ${
                    s < step ? 'bg-green-600/40' : 'bg-border'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step labels */}
        <div className="mb-6 flex justify-between px-2 text-xs text-muted-foreground">
          <span className={step >= 1 ? 'text-foreground' : ''}>
            PBX Connection
          </span>
          <span className={step >= 2 ? 'text-foreground' : ''}>
            Confirmation
          </span>
          <span className={step >= 3 ? 'text-foreground' : ''}>
            Complete
          </span>
        </div>

        {/* Step 1: PBX Connection */}
        {step === 1 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Server className="h-5 w-5 text-muted-foreground" />
                PBX Connection
              </CardTitle>
              <CardDescription>
                Enter your 3CX PBX details and system owner credentials. The
                system owner extension is used for API access to discover queues
                and fetch user information.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleConnect} className="space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="pbxUrl"
                    className="text-sm font-medium text-foreground"
                  >
                    PBX FQDN
                  </label>
                  <Input
                    id="pbxUrl"
                    type="text"
                    placeholder="customer.my3cx.us"
                    value={pbxUrl}
                    onChange={(e) => setPbxUrl(e.target.value)}
                    disabled={setupMutation.isPending}
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    The fully qualified domain name of your 3CX instance
                  </p>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="setupExtension"
                    className="text-sm font-medium text-foreground"
                  >
                    System Owner Extension
                  </label>
                  <Input
                    id="setupExtension"
                    type="text"
                    placeholder="e.g. 100"
                    value={extensionNumber}
                    onChange={(e) => setExtensionNumber(e.target.value)}
                    disabled={setupMutation.isPending}
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="setupPassword"
                    className="text-sm font-medium text-foreground"
                  >
                    Password
                  </label>
                  <Input
                    id="setupPassword"
                    type="password"
                    placeholder="Web client password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={setupMutation.isPending}
                  />
                </div>

                {error && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-red-400">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    setupMutation.isPending ||
                    !pbxUrl ||
                    !extensionNumber ||
                    !password
                  }
                >
                  {setupMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Connecting to PBX...
                    </>
                  ) : (
                    <>
                      Connect & Setup
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Step 2 is skipped since setup validates + creates everything in one call.
            On success we go directly to step 3.
            But if we want a confirmation step, the setup mutation's onSuccess
            could set step=2 first, show results, then go to step=3.
            For now, the mutation goes straight through. Let's implement a proper
            2-step flow with a confirmation view. */}

        {/* Step 3: Complete */}
        {step === 3 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="flex flex-col items-center py-12">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-600/20">
                <CheckCircle2 className="h-8 w-8 text-green-400" />
              </div>
              <h2 className="mb-2 text-xl font-semibold text-foreground">
                Setup Complete!
              </h2>
              <p className="mb-1 text-sm text-muted-foreground">
                Connected to <span className="font-medium text-foreground">{pbxUrl}</span>
              </p>
              <p className="mb-6 text-sm text-muted-foreground">
                Queues have been auto-discovered and your admin account is ready.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Redirecting to wallboard...
              </div>
            </CardContent>
          </Card>
        )}

        {step === 1 && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            This setup only needs to be done once. The system owner extension
            will have admin privileges.
          </p>
        )}
      </div>
    </div>
  );
}
