import { type ComponentType, lazy, Suspense, useEffect, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { isAndroid } from "@/lib/mobile";
import type { ProviderId, RemoteConfig, SyncStatus } from "@/lib/sync/service";

const SyncQr = lazy(() => import("@/components/SyncQr").then((m) => ({ default: m.SyncQr })));

type SyncService = typeof import("@/lib/sync/service");
const loadSync = (): Promise<SyncService> => import("@/lib/sync/service");

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  gdrive: "Google Drive",
  s3: "S3-compatible storage",
  dropbox: "Dropbox",
};

export interface ProviderSetupProps {
  /** Resolves once pairing is created; rejects with a friendly message. */
  onDone: (config: RemoteConfig) => Promise<void>;
  onCancel: () => void;
}

function PlaceholderSetup({ onCancel }: ProviderSetupProps) {
  return (
    <div className="modal-card sync-step">
      <p className="modal-row-blurb">Storage connection coming next</p>
      <div className="confirm-actions">
        <button type="button" className="modal-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="modal-button" disabled>
          Continue
        </button>
      </div>
    </div>
  );
}

const S3_FIELDS = [
  {
    key: "endpoint",
    label: "Endpoint URL",
    placeholder: "https://<account-id>.r2.cloudflarestorage.com",
  },
  { key: "bucket", label: "Bucket" },
  { key: "region", label: "Region" },
  { key: "accessKeyId", label: "Access key ID" },
  { key: "secretAccessKey", label: "Secret access key", secret: true },
  { key: "prefix", label: "Folder prefix (optional)", optional: true },
] as const;
type S3Key = (typeof S3_FIELDS)[number]["key"];

export function S3Setup({ onDone, onCancel }: ProviderSetupProps) {
  const [values, setValues] = useState<Record<S3Key, string>>({
    endpoint: "",
    bucket: "",
    region: "auto",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "blobbies-sync",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = (key: S3Key) => values[key].trim();
  const httpsOk = /^https:\/\/\S+$/i.test(t("endpoint"));
  const ready =
    httpsOk && S3_FIELDS.every((field) => ("optional" in field ? true : t(field.key) !== ""));
  return (
    <form
      className="modal-card sync-step sync-s3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError(null);
        onDone({
          provider: "s3",
          endpoint: t("endpoint"),
          bucket: t("bucket"),
          region: t("region"),
          accessKeyId: t("accessKeyId"),
          secretAccessKey: t("secretAccessKey"),
          prefix: t("prefix"),
        }).catch(() => {
          setError("Couldn't reach that bucket. Check the endpoint, bucket name and keys.");
          setBusy(false);
        });
      }}
    >
      <p className="modal-row-title">S3-compatible storage</p>
      {S3_FIELDS.map((field) => (
        <label key={field.key} className="sync-field">
          <span className="modal-row-blurb">{field.label}</span>
          <input
            className="modal-name-input"
            type={"secret" in field ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={"placeholder" in field ? field.placeholder : undefined}
            value={values[field.key]}
            onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))}
          />
        </label>
      ))}
      {t("endpoint") !== "" && !httpsOk ? (
        <p className="modal-row-blurb sync-error">The endpoint must start with https://</p>
      ) : null}
      <p className="modal-row-blurb">
        <ExternalLink href="https://developers.cloudflare.com/r2/api/tokens/">
          Using Cloudflare R2? Create a bucket and an API token with Object Read &amp; Write
        </ExternalLink>
      </p>
      {error !== null ? (
        <p className="modal-row-blurb sync-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="modal-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="modal-button" disabled={!ready || busy}>
          {busy ? "Connecting…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

/** One line per provider: swap a placeholder for the real form here. */
export const PROVIDER_SETUP: Record<ProviderId, ComponentType<ProviderSetupProps>> = {
  gdrive: PlaceholderSetup,
  s3: S3Setup,
  dropbox: PlaceholderSetup,
};
const DEFAULT_PROVIDER: ProviderId = "s3";

export function relativeTime(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function PairingCode({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-card sync-step sync-pairing">
      <Suspense fallback={<div className="sync-qr sync-qr-loading" />}>
        <SyncQr value={link} />
      </Suspense>
      <p className="modal-row-title">Scan this with your phone's camera</p>
      <button
        type="button"
        className="modal-button"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      <p className="modal-row-blurb sync-warning">
        This code unlocks your synced data. Don't share it with anyone.
      </p>
    </div>
  );
}

export function SyncSettings() {
  const android = isAndroid();
  const [svc, setSvc] = useState<SyncService | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [step, setStep] = useState<"idle" | "provider">("idle");
  const [link, setLink] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    let stop = () => {};
    let alive = true;
    void loadSync().then((mod) => {
      if (!alive) return;
      setSvc(mod);
      setStatus(mod.getSyncStatus());
      stop = mod.subscribeSync((next: SyncStatus) => setStatus(next));
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  if (svc === null || status === null) {
    return <p className="modal-row-blurb">Loading…</p>;
  }

  const on = status.state !== "off";
  if (!on) {
    const Setup = PROVIDER_SETUP[DEFAULT_PROVIDER];
    return (
      <>
        <p className="modal-section-label">Sync</p>
        <div className="modal-card">
          <div className="modal-row modal-row-multiline">
            <span className="modal-row-text">
              <span className="modal-row-blurb">
                Keep your Blobs and chats on your phone and computer in step. Everything is
                encrypted on your device before it leaves; the storage only ever holds scrambled
                data.
              </span>
            </span>
            {!android && step === "idle" && link === null ? (
              <button type="button" className="modal-button" onClick={() => setStep("provider")}>
                Set up sync
              </button>
            ) : null}
          </div>
        </div>
        {android ? (
          <div className="modal-card sync-step">
            <p className="modal-row-blurb">
              Scan the code shown in Blobbies on your computer (Settings → Sync) with your phone's
              camera app.
            </p>
            <form
              className="sync-paste"
              onSubmit={(event) => {
                event.preventDefault();
                const url = paste.trim();
                if (svc.parsePairLink(url) === null) {
                  setMessage("That pairing code didn't work. Show a new one on your computer.");
                  return;
                }
                setMessage("Connecting…");
                svc.acceptPairing(url).then(
                  () => window.location.reload(),
                  (error: unknown) => setMessage(String(error)),
                );
              }}
            >
              <label className="modal-row-title" htmlFor="sync-paste">
                Paste a pairing link
              </label>
              <input
                id="sync-paste"
                className="modal-name-input"
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
              />
              <button type="submit" className="modal-button" disabled={paste.trim() === ""}>
                Connect
              </button>
            </form>
          </div>
        ) : null}
        {!android && step === "provider" ? (
          <Setup
            onCancel={() => setStep("idle")}
            onDone={async (config) => {
              setMessage(null);
              const result = await svc.createPairing(config);
              setLink(result.link);
              setStep("idle");
            }}
          />
        ) : null}
        {link !== null ? <PairingCode link={link} /> : null}
        {message !== null ? <p className="modal-row-blurb sync-message">{message}</p> : null}
      </>
    );
  }

  const syncing = status.state === "syncing";
  return (
    <>
      <p className="modal-section-label">Sync</p>
      <div className="modal-card">
        <div className="modal-row modal-row-multiline">
          <span className="modal-row-text">
            <span className="modal-row-title">
              {status.provider === null ? "Sync" : PROVIDER_NAMES[status.provider]}
            </span>
            <span className="modal-row-blurb">Last synced {relativeTime(status.lastSyncedAt)}</span>
            {status.error !== null ? (
              <span className="modal-row-blurb sync-error" role="alert">
                {status.error}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="modal-button"
            disabled={syncing}
            onClick={() => void svc.syncNow().catch(() => {})}
          >
            {syncing ? <span className="sync-spinner" aria-hidden="true" /> : null}
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
        {!android ? (
          <div className="modal-row">
            <span className="modal-row-text">
              <span className="modal-row-title">Pair another phone</span>
            </span>
            <button
              type="button"
              className="modal-button"
              onClick={() => void svc.currentPairingLink().then(setLink)}
            >
              Show pairing code
            </button>
          </div>
        ) : null}
        <div className="modal-row">
          <span className="modal-row-text">
            <span className="modal-row-title">Turn off sync on this device</span>
          </span>
          {confirmOff ? (
            <>
              <button type="button" className="modal-button" onClick={() => setConfirmOff(false)}>
                Keep sync
              </button>
              <button
                type="button"
                className="modal-button confirm-danger"
                onClick={() => {
                  setConfirmOff(false);
                  setLink(null);
                  void svc.unpair();
                }}
              >
                Turn off
              </button>
            </>
          ) : (
            <button type="button" className="modal-button" onClick={() => setConfirmOff(true)}>
              Turn off sync
            </button>
          )}
        </div>
      </div>
      {link !== null ? <PairingCode link={link} /> : null}
    </>
  );
}
