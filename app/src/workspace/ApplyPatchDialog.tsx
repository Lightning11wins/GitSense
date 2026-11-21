import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { PatchFile } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { baseName, dirName, repoName } from "./repos";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContentDiff } from "./ContentDiff";

type Preview = { files: PatchFile[] } | { error: string };

async function preview(repo: string, patch: string): Promise<Preview> {
  try {
    return { files: await call("patch.preview", { repo, patch }) };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Applies the patch on the clipboard to a repo, after previewing its files. Starts with the first visible repo
 * the patch applies to.
 */
export function ApplyPatchDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const home = useSession(session, (s) => s.info.home);
  const repos = useSession(session, (s) => s.repos);
  const visible = repos.filter((r) => !r.hidden);
  const [patch, setPatch] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [repo, setRepo] = useState<string>();
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let stale = false;
    (async () => {
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        return !stale && setReadError(`Failed to read the clipboard: ${e}`);
      }
      if (stale) return;
      if (!text.trim()) return setReadError("Failed to read a patch: the clipboard is empty.");
      setPatch(text);
      for (const r of visible) {
        const result = await preview(r.path, text);
        if (stale) return;
        setPreviews((old) => ({ ...old, [r.path]: result }));
        if ("files" in result) return setRepo(r.path);
      }
      setRepo(visible[0]?.path);
    })();
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!repo || !patch || previews[repo]) return;
    let stale = false;
    preview(repo, patch).then((result) => !stale && setPreviews((old) => ({ ...old, [repo]: result })));
    return () => {
      stale = true;
    };
  }, [repo, patch]);

  const current = repo ? previews[repo] : undefined;
  const files = current && "files" in current ? current.files : undefined;
  const file = files?.[Math.min(selected, files.length - 1)];

  async function apply() {
    if (!repo || !patch) return;
    try {
      await call("patch.apply", { repo, patch });
      session.notify(`Applied the patch to ${repoName({ path: repo }, home)}.`);
    } catch (e) {
      // A failed apply may leave conflicts in the working tree, so it shows outside the dialog.
      session.notify(String(e));
    } finally {
      session.refreshStatus(repo);
    }
  }

  return (
    <ConfirmDialog
      title="Apply Patch from Clipboard"
      confirmLabel="Apply"
      width={1100}
      blocker={files ? undefined : readError ? "Copy a patch to the clipboard" : current ? "Choose a repository the patch applies to" : "Loading..."}
      onConfirm={apply}
      onClose={onClose}
    >
      {visible.length > 1 && (
        <label className="field">
          <span>Repository:</span>
          <select value={repo ?? ""} disabled={!repo} onChange={(e) => (setRepo(e.target.value), setSelected(0))}>
            {!repo && <option value="">Finding a repository the patch applies to...</option>}
            {visible.map((r) => (
              <option key={r.path} value={r.path}>
                {repoName(r, home)}
              </option>
            ))}
          </select>
        </label>
      )}
      {readError && <p className="error-text">{readError}</p>}
      {current && "error" in current && <p className="error-text">{current.error}</p>}
      {!readError && !current && <p className="secondary">Loading...</p>}
      {files && (
        <div className="patch-preview">
          <div
            className="tree dialog-list patch-files"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              setSelected((i) => Math.max(0, Math.min(files.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            }}
          >
            {files.map((f, i) => (
              <div
                key={f.path}
                className={`tree-row ${f === file ? "selected" : ""}`}
                title={f.orig_path ? `Renamed from ${f.orig_path}` : f.path}
                onMouseDown={() => setSelected(i)}
              >
                <FileText size={14} className="secondary" />
                <span className={`label status-${f.kind}`}>{baseName(f.path)}</span>
                <span className="hint">{dirName(f.path)}</span>
              </div>
            ))}
          </div>
          {file && (
            <div className="patch-diff">
              <ContentDiff
                key={file.path}
                path={file.path}
                left={{ label: `HEAD: ${file.orig_path ?? file.path}`, content: file.before }}
                right={{ label: "Patched version", content: file.after }}
              />
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
