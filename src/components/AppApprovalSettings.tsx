import { useEffect, useState } from "react";
import { loadPlugins } from "@/data/plugins";

interface AppApprovalSettingsProps {
  /** Composio toolkit slugs set to "Always allow". */
  appIds: string[];
  onRemove: (id: string) => void;
}

/**
 * The "App actions" section of Settings → Plugins.
 *
 * An "Always allow" with no way back is a permission nobody would grant twice,
 * so every one of them is listed here with a way to take it back.
 */
export function AppApprovalSettings({ appIds, onRemove }: AppApprovalSettingsProps) {
  // Display names come from the catalog, which loads on its own; until then,
  // and for an app the catalog does not know, the slug stands in.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    void loadPlugins().then((catalog) => {
      if (live) {
        setNames(new Map(catalog.map((plugin) => [plugin.id, plugin.name])));
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const apps = appIds.map((id) => ({ id, name: names.get(id) ?? id }));
  return (
    <>
      <p className="modal-section-label">App actions</p>
      <div className="modal-card">
        <div className="modal-row modal-row-multiline">
          <span className="modal-row-text">
            <span className="modal-row-title">Ask before changing anything</span>
            <span className="modal-row-blurb">
              Blobs ask you before they send, create, change or delete anything in your apps.
              Reading runs without asking.
              {apps.length === 0 ? " No apps are set to always allow." : ""}
            </span>
          </span>
        </div>
        {apps.map((app) => (
          <div key={app.id} className="modal-row">
            <span className="modal-row-text">
              <span className="modal-row-title">{app.name}</span>
              <span className="modal-row-blurb">Always allowed — runs without asking.</span>
            </span>
            <button type="button" className="modal-button" onClick={() => onRemove(app.id)}>
              Ask again
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
