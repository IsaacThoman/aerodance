import { useEffect, useState } from "react";
import { errorMessage } from "./api.ts";

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export default function StorageStatus({ revision, busy }: { revision: number; busy: boolean }) {
  const [usage, setUsage] = useState(""), [persistent, setPersistent] = useState(false), [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]).then(([estimate, kept]) => {
      if (!active) return;
      setUsage(`${size(estimate.usage || 0)} used${estimate.quota ? ` of about ${size(estimate.quota)}` : ""}`);
      setPersistent(kept);
    }).catch(error => { if (active) setMessage(errorMessage(error)); });
    return () => { active = false; };
  }, [revision, busy]);
  return <details className="storage-status">
    <summary>On this device{usage ? ` · ${usage}` : ""}</summary>
    <div>
      <p>Projects autosave in this browser at this site address. Use <strong>Backup</strong> to keep a project file or move it to another device. There is no cloud sync.</p>
      <p>Clearing site data removes projects. Private browsing storage is temporary.</p>
      {persistent ? <p>Browser storage is protected from automatic eviction.</p> : <button onClick={async () => {
        try {
          const kept = await navigator.storage.persist(); setPersistent(kept);
          setMessage(kept ? "" : "The browser did not grant persistent storage. Keep project backups.");
        } catch (error) { setMessage(errorMessage(error)); }
      }}>Keep browser storage</button>}
      {message && <p role="status">{message}</p>}
    </div>
  </details>;
}
