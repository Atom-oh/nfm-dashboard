'use client';

// /settings — user-tunable client-side preferences persisted in localStorage
// (`nfm-settings`) via useSettings: default time range, monitor filter, and
// alert/anomaly thresholds, plus an SNS alarm-subscribe helper. No backend;
// changes save immediately. Anomaly σ + thresholds feed the Anomalies page,
// the rest are display preferences for now.
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { Card, Select, TextInput } from '@/components/ui/Controls';
import { TIME_RANGES, type TimeRange } from '@/lib/analytics/filters';
import { DEFAULT_SETTINGS, useSettings } from '@/lib/settings';
import { usePolling } from '@/lib/use-polling';
import PageIntro from '@/components/PageIntro';

const SNS_SUBSCRIBE_CMD =
  'aws sns subscribe --topic-arn arn:aws:sns:ap-northeast-2:<account-id>:nfm-dashboard-alarms --protocol email --notification-endpoint you@example.com';

interface McpToolMeta { name: string; description: string; }
interface McpMetaResponse { tools: McpToolMeta[]; }

/**
 * MCP integration card: how to register this app's read-only MCP server
 * (`/api/mcp`, ADR-012) — the live tool catalog (fetched, not hardcoded, so
 * it can't drift from `mcp-server.ts`) plus copy-paste registration snippets
 * for the two known consumers (Claude Code, awsops). The bearer token itself
 * is NEVER fetched or shown here — only where to find it.
 */
function McpIntegrationCard() {
  const { t } = useLanguage();
  const { data, error } = usePolling<McpMetaResponse>('/api/mcp/meta', 5 * 60 * 1000);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const endpoint = `${origin || 'https://<this-domain>'}/api/mcp`;
  const claudeCodeCmd =
    `claude mcp add --transport http nfm-dashboard ${endpoint} ` +
    '--header "Authorization: Bearer <TOKEN>"';
  const awsopsPreset = `"nfm-dashboard-mcp-server-target": {
    "gateway": "external-obs",
    "preset_key": "nfm",
    "description": "NFM Dashboard — pod-to-pod topology + infra request path + cost/latency/reliability lenses + history (read-only)",
    "auth": {"mode": "api_key", "credential_location": "HEADER",
             "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
}`;

  return (
    <Card title={t('settings.mcp')} testId="mcp-integration-card">
      <p className={noteCls}>{t('settings.mcpHint')}</p>

      <div className="mt-3 flex flex-col gap-1">
        <span className="text-[11px] font-medium text-ink/60 dark:text-white/60">
          {t('settings.mcpEndpoint')}
        </span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-black/5 px-2 py-1 text-xs dark:bg-white/10">
            {endpoint}
          </code>
          <CopyButton text={endpoint} />
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <span className="text-[11px] font-medium text-ink/60 dark:text-white/60">
          {t('settings.mcpTools')}
        </span>
        {error ? (
          <p className={noteCls}>{t('settings.mcpToolsError')}</p>
        ) : !data ? (
          <p className={noteCls}>{t('settings.mcpToolsLoading')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {data.tools.map((tool) => (
              <li key={tool.name} className="flex flex-col">
                <span className="font-mono text-[11px] text-chartViolet">{tool.name}</span>
                <span className={noteCls}>{tool.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-ink/60 dark:text-white/60">
            {t('settings.mcpClaudeCode')}
          </span>
          <CopyButton text={claudeCodeCmd} />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
          <code>{claudeCodeCmd}</code>
        </pre>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-ink/60 dark:text-white/60">
            {t('settings.mcpAwsops')}
          </span>
          <CopyButton text={awsopsPreset} />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
          <code>{awsopsPreset}</code>
        </pre>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-ink/60 dark:text-white/60">
            {t('settings.mcpSigv4')}
          </span>
          <CopyButton text={SIGV4_SNIPPET} />
        </div>
        <p className={noteCls}>{t('settings.mcpSigv4Hint')}</p>
        <pre className="overflow-x-auto rounded-lg bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
          <code>{SIGV4_SNIPPET}</code>
        </pre>
      </div>
    </Card>
  );
}

const SIGV4_SNIPPET = `import boto3
url = boto3.client("sts").generate_presigned_url("get_caller_identity", ExpiresIn=60)
headers = {"Authorization": f"AWS4-GetCallerIdentity {url}"}
# then POST that header + your JSON-RPC body to the endpoint above.
# Ask nfm-dashboard to add your role to MCP_ALLOWED_CALLERS first — see ADR-013.`;

/** The four numeric settings rendered as validated number fields. */
const NUMBER_FIELDS = ['retransThreshold', 'timeoutThreshold', 'costPerGb', 'anomalySigma'] as const;

const btnCls =
  'inline-flex items-center gap-1 rounded-md bg-ink/[.06] px-2 py-1 text-[11px] font-medium text-ink/60 transition-colors hover:bg-ink/10 hover:text-ink dark:bg-white/10 dark:text-white/60 dark:hover:bg-white/20 dark:hover:text-white';

const noteCls = 'text-[11px] leading-relaxed text-ink/50 dark:text-white/50';

/**
 * Free-text number input: valid values commit (and persist) as you type;
 * on blur a value that is not a finite number falls back to the default.
 */
function NumberField({
  label,
  value,
  defaultValue,
  onCommit,
}: {
  label: string;
  value: number;
  defaultValue: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (raw: string) => {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : null;
  };
  return (
    <div
      onBlur={() => {
        if (draft === null) return;
        onCommit(parse(draft) ?? defaultValue);
        setDraft(null);
      }}
    >
      <TextInput
        label={label}
        value={draft ?? String(value)}
        onChange={(v) => {
          setDraft(v);
          const n = parse(v);
          if (n !== null) onCommit(n);
        }}
      />
    </div>
  );
}

/** Copy-to-clipboard button (guarded for jsdom / insecure contexts). */
function CopyButton({ text }: { text: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write denied — keep the idle label instead of lying.
    }
  };
  const label = copied ? t('settings.copied') : t('settings.copy');
  return (
    <button type="button" onClick={handleCopy} aria-label={label} className={btnCls}>
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {label}
    </button>
  );
}

export default function SettingsPage() {
  const { t } = useLanguage();
  const { settings, setSetting, reset } = useSettings();
  // Bumped on reset to remount NumberFields, discarding any in-flight drafts.
  const [resetSeq, setResetSeq] = useState(0);

  // Only 'all' is offered today; keep a persisted custom value selectable.
  const monitorOptions = [
    { value: 'all', label: t('settings.monitorAll') },
    ...(settings.monitorFilter !== 'all'
      ? [{ value: settings.monitorFilter, label: settings.monitorFilter }]
      : []),
  ];

  return (
    <div data-testid="settings-page" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        <button
          type="button"
          onClick={() => {
            reset();
            setResetSeq((s) => s + 1);
          }}
          className={btnCls}
        >
          <RotateCcw size={12} aria-hidden />
          {t('settings.reset')}
        </button>
      </div>

      <PageIntro page="settings" />

      <p className={noteCls}>
        {t('settings.savedHint')} {t('settings.wiredNote')}
      </p>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card title={t('settings.general')}>
          <div className="flex flex-col gap-3">
            <Select
              label={t('settings.defaultRange')}
              value={settings.defaultRange}
              onChange={(v) => setSetting('defaultRange', v as TimeRange)}
              options={TIME_RANGES.map((r) => ({ value: r, label: t(`filter.range.${r}`) }))}
            />
            <Select
              label={t('settings.monitorFilter')}
              value={settings.monitorFilter}
              onChange={(v) => setSetting('monitorFilter', v)}
              options={monitorOptions}
            />
            <p className={noteCls}>{t('settings.monitorNote')}</p>
          </div>
        </Card>

        <Card title={t('settings.thresholds')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {NUMBER_FIELDS.map((key) => (
              <NumberField
                key={`${key}-${resetSeq}`}
                label={t(`settings.${key}`)}
                value={settings[key]}
                defaultValue={DEFAULT_SETTINGS[key]}
                onCommit={(n) => setSetting(key, n)}
              />
            ))}
          </div>
          <p className={`mt-3 ${noteCls}`}>{t('settings.thresholdsNote')}</p>
        </Card>
      </div>

      <Card title={t('settings.subscribe')} action={<CopyButton text={SNS_SUBSCRIBE_CMD} />}>
        <p className={`mb-3 ${noteCls}`}>{t('settings.subscribeHint')}</p>
        <pre className="overflow-x-auto rounded-lg bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
          <code>{SNS_SUBSCRIBE_CMD}</code>
        </pre>
      </Card>

      <McpIntegrationCard />
    </div>
  );
}
