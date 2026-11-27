import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

type UpdateState =
  | { status: "idle" | "checking" | "current" }
  | { status: "available" | "installing" | "installed"; version: string }
  | { status: "error"; message: string };

export function useWriterUpdates() {
  const enabled = import.meta.env.PROD && isTauri();
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const operation = useRef<"idle" | "checking" | "installing" | "installed">("idle");
  const reportCheckError = useRef(false);

  const check = useCallback(async (showError = true) => {
    if (operation.current === "checking") {
      reportCheckError.current ||= showError;
      return;
    }
    if (operation.current !== "idle") return;
    operation.current = "checking";
    reportCheckError.current = showError;
    setState({ status: "checking" });
    try {
      const version = await invoke<string | null>("check_for_update");
      setState(version ? { status: "available", version } : { status: "current" });
    } catch (err) {
      setState(reportCheckError.current ? { status: "error", message: String(err) } : { status: "idle" });
    } finally {
      operation.current = "idle";
    }
  }, []);

  useEffect(() => {
    if (enabled) void check(false);
  }, [enabled, check]);

  async function install(version: string) {
    if (operation.current !== "idle") return;
    operation.current = "installing";
    setState({ status: "installing", version });
    try {
      await invoke("install_update", { version });
      operation.current = "installed";
      setState({ status: "installed", version });
    } catch (err) {
      operation.current = "idle";
      setState({ status: "error", message: String(err) });
    }
  }

  return { enabled, state, check, install };
}

export function WriterUpdates({
  updates,
  dirty,
}: {
  updates: ReturnType<typeof useWriterUpdates>;
  dirty: boolean;
}) {
  const { state, check, install } = updates;
  const [restartError, setRestartError] = useState<string>();

  return (
    <div className="settings-card" id="software-updates">
      <div className="settings-card-row">
        <div>
          <div className="settings-label">Software updates</div>
          <div className="settings-sub" role="status">
            {state.status === "current" && "Writer is up to date."}
            {state.status === "available" && `Writer ${state.version} is available.`}
            {state.status === "installing" && `Downloading and installing Writer ${state.version}…`}
            {state.status === "installed" && (restartError ?? (dirty
              ? "Save your document before restarting Writer."
              : `Writer ${state.version} is ready. Restart to finish updating.`))}
            {state.status === "error" && state.message}
          </div>
        </div>
        {state.status === "available" ? (
          <button type="button" className="small-btn" onClick={() => void install(state.version)}>
            Install update
          </button>
        ) : state.status === "installed" ? (
          <button
            type="button"
            className="small-btn"
            disabled={dirty}
            onClick={() => void invoke("restart_writer").catch((err) => setRestartError(String(err)))}
          >
            Restart Writer
          </button>
        ) : (
          <button
            type="button"
            className="small-btn"
            disabled={state.status === "checking" || state.status === "installing"}
            onClick={() => void check()}
          >
            {state.status === "checking" ? "Checking…" : state.status === "installing" ? "Installing…" : "Check for updates"}
          </button>
        )}
      </div>
    </div>
  );
}
